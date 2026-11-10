// E06 Document and media processing — service layer (engine service convention v1).
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, canonical, invariant, nonempty } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { importWebVtt } from '../captions.ts';
import * as kit from '../service-kit.ts';
import type { AuditRecord, EngineEvent, EngineManifestV1, Inspection, Job, Migration, Route, SearchHit, ServiceContext, Sql, StandardEngine, UpstreamChange } from '../service-kit.ts';
import * as tools from './tools.ts';
import type { Family, LanguageProfile, PageInfo, SegmentDraft, Sniffed, ToolLimits, Word } from './tools.ts';
import * as adapters from './adapters.ts';
import type { AsrAdapter, Availability, EngineInfo, PocketsphinxConfig, ProviderConfig, TranslationAdapter, WhisperCommandConfig } from './adapters.ts';

export const SCHEMA = 'e06_processing';
const S = SCHEMA, E = 'E06';
export const manifest: EngineManifestV1 = {
  id: E, name: 'Document and media processing engine', version: '1.0.0', kit: kit.SERVICE_KIT_VERSION,
  capabilities: ['processing:read', 'processing:write', 'processing:attribute_speaker', 'processing:export', 'processing:admin', 'processing:events'],
  emits: ['processing.requested', 'processing.completed', 'processing.failed', 'processing.low_quality', 'processing.text_corrected', 'processing.stale', 'processing.blocked', 'processing.cancelled', 'processing.redacted', 'processing.speaker_attributed', 'processing.policy_changed', 'translation.completed', 'translation.revised'],
  consumes: ['evidence.released', 'evidence.version_added', 'evidence.blocked', 'consent.withdrawn'],
};

export const migrations: readonly Migration[] = [{ id: '001_processing', sql: `
create table {s}.policy (
  tenant_id text not null, project_id text not null, revision int not null,
  external_transmission text not null check (external_transmission in ('forbidden','allowed')),
  allowed_providers jsonb not null, languages jsonb not null, updated_at timestamptz not null, updated_by text not null,
  primary key (tenant_id, project_id));
create table {s}.processing (
  id uuid primary key, tenant_id text not null, project_id text not null,
  evidence_ref text not null, evidence_id text not null, evidence_revision int not null, sha256 text not null,
  declared_media_type text not null, media_type text, family text, filename text not null, compartment text,
  sources jsonb not null, options jsonb not null, options_digest text not null, generation int not null default 1,
  state text not null check (state in ('queued','running','done','partial','failed','cancelled')),
  stale boolean not null default false, blocked boolean not null default false, reasons jsonb not null default '[]',
  failure text, cause text, requested_by text not null, created_at timestamptz not null, updated_at timestamptz not null,
  unique (tenant_id, project_id, evidence_ref, options_digest, generation));
create index processing_scope on {s}.processing (tenant_id, project_id, created_at);
create table {s}.step (
  id uuid primary key, tenant_id text not null, project_id text not null, processing_id uuid not null references {s}.processing(id),
  ordinal int not null, name text not null, tool text not null, tool_version text not null, params jsonb not null, params_digest text not null,
  state text not null check (state in ('queued','running','done','failed','unavailable','denied','cancelled')),
  job_id uuid, detail jsonb not null default '{}', error text, started_at timestamptz, finished_at timestamptz,
  unique (processing_id, name, tool_version, params_digest));
create table {s}.representation (
  id uuid primary key, tenant_id text not null, project_id text not null, processing_id uuid not null references {s}.processing(id),
  step_id uuid not null, evidence_ref text not null, kind text not null check (kind in ('text','transcript','captions','translation')),
  language text, language_confidence real, language_method text, machine boolean not null, engine jsonb not null,
  source_ref text, label text not null, current_revision int not null default 1,
  state text not null default 'current' check (state in ('current','superseded')),
  stale boolean not null default false, blocked boolean not null default false, reasons jsonb not null default '[]',
  quality jsonb not null default '{}', pages jsonb not null default '[]', compartment text, sources jsonb not null,
  created_at timestamptz not null, created_by text not null, unique (step_id));
create index representation_proc on {s}.representation (processing_id);
create table {s}.representation_revision (
  representation_id uuid not null references {s}.representation(id), revision int not null,
  tenant_id text not null, project_id text not null, at timestamptz not null, actor_id text not null, actor_kind text not null,
  reason text not null, segment_ids jsonb not null, text_sha256 text not null, primary key (representation_id, revision));
create table {s}.segment (
  id uuid primary key, tenant_id text not null, project_id text not null, representation_id uuid not null references {s}.representation(id),
  ordinal int not null, kind text not null, source text not null, page int, bbox jsonb, start_ms int, end_ms int,
  anchor jsonb, speaker text, source_segment_id uuid, unique (representation_id, ordinal));
create index segment_page on {s}.segment (representation_id, page);
create index segment_time on {s}.segment (representation_id, start_ms);
create table {s}.segment_text (
  segment_id uuid not null references {s}.segment(id), revision int not null,
  tenant_id text not null, project_id text not null, representation_id uuid not null,
  text text not null, words jsonb, confidence real, corrected boolean not null default false, is_current boolean not null default true,
  tsv tsvector generated always as (to_tsvector('simple', text)) stored, primary key (segment_id, revision));
create index segment_text_fts on {s}.segment_text using gin (tsv) where is_current;
create index segment_text_rep on {s}.segment_text (representation_id, revision);
create table {s}.observation (
  id uuid primary key, tenant_id text not null, project_id text not null, processing_id uuid not null references {s}.processing(id),
  step_id uuid not null, kind text not null, page int, data jsonb not null, tool text not null, tool_version text not null,
  caveat text, created_at timestamptz not null);
create index observation_proc on {s}.observation (processing_id, kind);
create table {s}.derivative (
  id uuid primary key, tenant_id text not null, project_id text not null, processing_id uuid not null references {s}.processing(id),
  step_id uuid, representation_id uuid, representation_revision int, kind text not null, page int, media_type text not null,
  object_key text, evidence_derivative_ref text, sha256 text not null, size bigint not null, params jsonb not null default '{}',
  stale boolean not null default false, blocked boolean not null default false, reasons jsonb not null default '[]',
  compartment text, created_at timestamptz not null, created_by text not null);
create index derivative_proc on {s}.derivative (processing_id);
create table {s}.speaker_turn (
  id uuid primary key, tenant_id text not null, project_id text not null, processing_id uuid not null references {s}.processing(id),
  label text not null, start_ms int not null, end_ms int not null, confidence real,
  provisional boolean not null default true check (provisional));
create index speaker_turn_proc on {s}.speaker_turn (processing_id, start_ms);
create table {s}.speaker_attribution (
  id uuid primary key, tenant_id text not null, project_id text not null, processing_id uuid not null references {s}.processing(id),
  label text not null, identity_ref text not null, basis text not null,
  status text not null default 'attributed' check (status in ('attributed','revoked')),
  reviewed_by text not null, reviewed_at timestamptz not null, revoked_by text, revoked_at timestamptz, revoke_reason text);
create table {s}.upstream_change (
  tenant_id text not null, project_id text not null, event_id text not null, kind text not null, affected jsonb not null,
  at timestamptz not null, primary key (tenant_id, project_id, event_id));
create table {s}.block (
  tenant_id text not null, project_id text not null, ref text not null, reason text not null, event_id text not null,
  at timestamptz not null, primary key (tenant_id, project_id, ref, event_id));
` }];
export function migrate(sql: Sql): Promise<string[]> { return kit.runMigrations(sql, SCHEMA, migrations); }

// ───────────────────────────── Public types ─────────────────────────────
export type ProcessingPolicy = { externalTransmission: 'forbidden' | 'allowed'; allowedProviders: string[]; languages: string[]; revision: number };
export type StepView = { id: string; name: string; tool: string; toolVersion: string; state: string; error: string | null; detail: Json; jobId: string | null };
export type ProcessingView = {
  id: string; ref: string; evidenceRef: string; sha256: string; declaredMediaType: string; mediaType: string | null; family: string | null; filename: string;
  state: 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled'; stale: boolean; blocked: boolean; reasons: string[]; failure: string | null;
  generation: number; options: Json; createdAt: string; steps: StepView[]; representations: string[];
};
export type SpeakerView = { label: string; provisional: true; attribution: null | { id: string; identityRef: string; status: 'attributed'; verified: false; basis: string; reviewedBy: string; reviewedAt: string } };
export type SegmentView = {
  id: string; ordinal: number; kind: string; source: string; text: string; textRevision: number; corrected: boolean; confidence: number | null;
  page: number | null; bbox: [number, number, number, number] | null; startMs: number | null; endMs: number | null; anchor: Json;
  speaker: SpeakerView | null; sourceSegmentId: string | null; words: Word[] | null;
};
export type RepresentationView = {
  id: string; ref: string; revision: number; currentRevision: number; processingId: string; evidenceRef: string; kind: 'text' | 'transcript' | 'captions' | 'translation';
  label: string; language: string | null; languageConfidence: number | null; languageMethod: string | null; machine: boolean; machineTranslation: boolean;
  engine: Json; sourceRef: string | null; state: string; stale: boolean; blocked: boolean; reasons: string[]; quality: Json; pages: Json; segments: SegmentView[];
};
export type SegmentHit = {
  representationRef: string; evidenceRef: string; segmentId: string; kind: string; representationKind: string; snippet: string; rank: number;
  page: number | null; bbox: [number, number, number, number] | null; unit: string | null; startMs: number | null; endMs: number | null;
  speaker: SpeakerView | null; language: string | null; machineTranslation: boolean; stale: boolean; corrected: boolean; confidence: number | null;
};
export type RedactionSelector = { reason: string } & ({ segmentId: string; start?: number; end?: number } | { page: number; bbox: [number, number, number, number] } | { startMs: number; endMs: number });
export type DerivativeView = { id: string; ref: string; processingId: string; kind: string; page: number | null; mediaType: string; sha256: string; size: number; evidenceDerivativeRef: string | null; representationRef: string | null; stale: boolean; blocked: boolean; reasons: string[]; params: Json };
export type ObservationView = { id: string; kind: string; page: number | null; data: Json; tool: string; toolVersion: string; caveat: string | null };
export type RequestProcessingInput = { evidenceRef: string; languages?: string[]; steps?: string[]; translateTo?: string[]; asrProvider?: string; translationProvider?: string; captionsFor?: string; force?: boolean; idempotencyKey?: string };

export type EngineConfig = {
  limits?: Partial<ToolLimits>; tempRoot?: string; python?: string;
  /** OCR/ASR languages (ISO 639-3) used when neither the request nor the project policy names any. `auto` uses script detection. */
  defaultLanguages?: string[];
  languageProfiles?: Readonly<Record<string, LanguageProfile>>;
  /** Word confidence below this is counted as low; a page or transcript whose mean falls below `lowQualityMean` raises processing.low_quality. */
  lowConfidence?: number; lowQualityMean?: number;
  /** With no UseDecisionPort the engine denies processing unless this documented standalone mode is selected. */
  standalone?: { useDecisions?: 'allow' };
  asr?: { pocketsphinx?: PocketsphinxConfig | false; whisper?: WhisperCommandConfig; providers?: Readonly<Record<string, ProviderConfig>> };
  translation?: { apertium?: boolean; providers?: Readonly<Record<string, ProviderConfig & { kind: 'libretranslate' | 'llm' }>> };
  /** Lets the host adjust the context used for port calls made by workers (e.g. add service capabilities). */
  portContext?: (ctx: ServiceContext) => ServiceContext;
  jobLeaseMs?: number; maxAttempts?: number;
};
export type EnginePorts = { evidence?: kit.EvidencePort; useDecisions?: kit.UseDecisionPort; authorization?: kit.AuthorizationPort; budget?: kit.BudgetPort };
export type EngineDeps = { sql: Sql; objects?: kit.ObjectStore; ports?: EnginePorts; config?: EngineConfig };

export interface ProcessingEngine extends StandardEngine {
  getPolicy(ctx: ServiceContext): Promise<ProcessingPolicy>;
  setPolicy(ctx: ServiceContext, input: { externalTransmission: 'forbidden' | 'allowed'; allowedProviders?: string[]; languages?: string[]; idempotencyKey?: string }): Promise<ProcessingPolicy>;
  describeTools(ctx: ServiceContext): Promise<{ tools: Record<string, string | null>; ocrLanguages: string[]; asr: Availability[]; translation: Availability[]; diarization: Availability }>;
  requestProcessing(ctx: ServiceContext, input: RequestProcessingInput): Promise<ProcessingView>;
  getProcessing(ctx: ServiceContext, id: string): Promise<ProcessingView>;
  listProcessing(ctx: ServiceContext, options?: { evidenceRef?: string; state?: string; limit?: number }): Promise<ProcessingView[]>;
  cancelProcessing(ctx: ServiceContext, id: string, input?: { reason?: string }): Promise<ProcessingView>;
  retryProcessing(ctx: ServiceContext, id: string): Promise<ProcessingView>;
  getAlignment(ctx: ServiceContext, processingId: string): Promise<{ processing: ProcessingView; representations: RepresentationView[]; speakers: { turns: { label: string; startMs: number; endMs: number; confidence: number | null; provisional: true }[]; labels: SpeakerView[] } }>;
  getRepresentation(ctx: ServiceContext, ref: string, options?: { revision?: number }): Promise<RepresentationView>;
  listRevisions(ctx: ServiceContext, ref: string): Promise<{ ref: string; revision: number; at: string; actorId: string; actorKind: string; reason: string; segmentIds: string[]; textSha256: string }[]>;
  locate(ctx: ServiceContext, ref: string, point: { page: number; x: number; y: number } | { ms: number }): Promise<{ representationRef: string; evidenceRef: string; segment: SegmentView; word: Word | null } | null>;
  correctText(ctx: ServiceContext, input: { representation: string; corrections: { segmentId: string; text: string }[]; reason: string; expectedRevision?: number; idempotencyKey?: string }): Promise<{ representationRef: string; previousRef: string; revision: number; segmentIds: string[]; staled: string[] }>;
  requestTranslation(ctx: ServiceContext, input: { representation: string; targetLanguage: string; provider?: string; idempotencyKey?: string }): Promise<{ processingId: string; stepId: string; jobId: string }>;
  listObservations(ctx: ServiceContext, processingId: string, options?: { kind?: string }): Promise<ObservationView[]>;
  listSpeakers(ctx: ServiceContext, processingId: string): Promise<{ turns: { label: string; startMs: number; endMs: number; confidence: number | null; provisional: true }[]; labels: SpeakerView[] }>;
  attributeSpeaker(ctx: ServiceContext, input: { processingId: string; label: string; identityRef: string; basis: string; idempotencyKey?: string }): Promise<SpeakerView>;
  revokeSpeakerAttribution(ctx: ServiceContext, input: { attributionId: string; reason: string }): Promise<{ id: string; status: 'revoked' }>;
  createRedactedDerivative(ctx: ServiceContext, input: { representation: string; redactions: RedactionSelector[]; idempotencyKey?: string }): Promise<DerivativeView>;
  listDerivatives(ctx: ServiceContext, processingId: string): Promise<DerivativeView[]>;
  getDerivativeBytes(ctx: ServiceContext, id: string): Promise<{ derivative: DerivativeView; bytes: Uint8Array }>;
  exportSearchable(ctx: ServiceContext, input: { representation: string; format: 'txt' | 'json' | 'vtt'; revision?: number }): Promise<{ mediaType: string; filename: string; bytes: Uint8Array; representationRef: string }>;
  searchSegments(ctx: ServiceContext, query: { q: string; limit?: number; evidenceRef?: string; language?: string; kinds?: string[] }): Promise<SegmentHit[]>;
  listJobs(ctx: ServiceContext, options?: { states?: kit.JobState[]; limit?: number }): Promise<Job[]>;
  controlJob(ctx: ServiceContext, id: string, action: 'cancel' | 'pause' | 'resume' | 'retry'): Promise<Job>;
  /** Runs one worker pass over this engine's jobs. Not caller-scoped: each job carries the context it was requested with. */
  runJobs(options?: { worker?: string; limit?: number; leaseMs?: number }): Promise<number>;
}

// ───────────────────────────── Helpers ─────────────────────────────
type R = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LANG = /^[a-z]{2,3}(_[a-z]+)?$/;
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const dig = (v: unknown): string => sha(canonical(JSON.parse(JSON.stringify(v))));
const iso = (d: unknown): string => new Date(d as Date).toISOString();
const J = (v: unknown): string => JSON.stringify(v);
const notFound = (): DomainError => new DomainError('not_found', 'Not found');
const cmp = (ctx: ServiceContext): string[] => [...ctx.compartments];
const VIS = `tenant_id=$1 and project_id=$2 and (compartment is null or compartment = any($3::text[]))`;
const mean = (xs: number[]): number | null => xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 1e4) / 1e4;
const procRef = (id: string): string => kit.uref(E, 'processing', id);
const repRef = (id: string, rev?: number): string => kit.uref(E, 'representation', id, rev);
const derRef = (id: string): string => kit.uref(E, 'derivative', id);
function repId(ref: string): { id: string; revision?: number } {
  if (UUID.test(ref)) return { id: ref };
  let p: ReturnType<typeof kit.parseUref>;
  try { p = kit.parseUref(ref); } catch { throw notFound(); }
  if (p.engine !== E || p.kind !== 'representation' || !UUID.test(p.id)) throw notFound();
  return p.revision === undefined ? { id: p.id } : { id: p.id, revision: p.revision };
}
const uuid = (id: string): string => { if (typeof id !== 'string' || !UUID.test(id)) throw notFound(); return id; };
const strings = (v: unknown, label: string, max = 20): string[] => { invariant(Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200), 'invalid_input', `${label} must be a short list of strings`); return [...new Set(v as string[])]; };
const METADATA_CAVEAT = 'Embedded metadata is written by whoever produced or edited the file and can be forged or stripped; it is an observation about the file, not a verified fact.';

type StepRow = { id: string; processing_id: string; ordinal: number; name: string; tool: string; tool_version: string; params: R; state: string; job_id: string | null; detail: Json; error: string | null };
type ProcRow = { id: string; tenant_id: string; project_id: string; evidence_ref: string; evidence_id: string; evidence_revision: number; sha256: string; declared_media_type: string; media_type: string | null; family: Family | null; filename: string; compartment: string | null; sources: string[]; options: R; options_digest: string; generation: number; state: ProcessingView['state']; stale: boolean; blocked: boolean; reasons: string[]; failure: string | null; created_at: Date };
type RepDraft = { kind: RepresentationView['kind']; language: string | null; languageConfidence: number | null; languageMethod: string | null; machine: boolean; engine: Json; sourceRef: string | null; label: string; quality: Json; pages: PageInfo[]; segments: SegmentDraft[]; extraSources?: string[] };
type DerivDraft = { kind: string; page: number | null; mediaType: string; filename: string; bytes: Uint8Array; params: Json };
type ObsDraft = { kind: string; page?: number | null; data: Json; tool: string; toolVersion: string; caveat?: string };
type StepOutput = { representation?: RepDraft; observations: ObsDraft[]; derivatives: DerivDraft[]; turns?: adapters.SpeakerTurn[]; detail: Json; lowQuality: string[] };
type StoredDeriv = Omit<DerivDraft, 'bytes'> & { objectKey: string | null; evidenceRef: string | null; sha256: string; size: number };

export function createEngine(deps: EngineDeps): ProcessingEngine {
  const sql = deps.sql, ports = deps.ports ?? {}, config = deps.config ?? {};
  const runner = new tools.ToolRunner({ ...(config.limits === undefined ? {} : { limits: config.limits }), ...(config.tempRoot === undefined ? {} : { tempRoot: config.tempRoot }) });
  const limits = runner.limits;
  const profiles = config.languageProfiles ?? tools.BUILTIN_PROFILES;
  const lowConfidence = config.lowConfidence ?? 0.6, lowQualityMean = config.lowQualityMean ?? 0.75;
  const iso1 = (language: string | null): string | null => language === null ? null : profiles[language]?.iso1 ?? (language.length === 2 ? language : null);
  const portCtx = (ctx: ServiceContext): ServiceContext => config.portContext === undefined ? ctx : config.portContext(ctx);

  const asrLocal: AsrAdapter[] = [
    ...(config.asr?.whisper === undefined ? [] : [adapters.whisperCommandAdapter(runner, config.asr.whisper, iso1)]),
    ...(config.asr?.pocketsphinx === false ? [] : [adapters.pocketsphinxAdapter(runner, { ...(config.python === undefined ? {} : { python: config.python }), ...(config.asr?.pocketsphinx ?? {}) })]),
  ];
  const asrExternal = new Map<string, AsrAdapter>(Object.entries(config.asr?.providers ?? {}).map(([id, c]) => [id, adapters.httpAsrAdapter(id, c, iso1)]));
  const mtLocal: TranslationAdapter[] = config.translation?.apertium === false ? [] : [adapters.apertiumAdapter(runner)];
  const mtExternal = new Map<string, TranslationAdapter>(Object.entries(config.translation?.providers ?? {}).map(([id, c]) => [id, c.kind === 'llm' ? adapters.llmTranslationAdapter(id, c) : adapters.libreTranslateAdapter(id, c, iso1)]));

  // ── policy ──
  async function policyOf(q: Sql, ctx: ServiceContext): Promise<ProcessingPolicy> {
    const r = (await q.query<R>(`select * from ${S}.policy where tenant_id=$1 and project_id=$2`, [ctx.tenantId, ctx.projectId]))[0];
    return r === undefined ? { externalTransmission: 'forbidden', allowedProviders: [], languages: [], revision: 0 } : { externalTransmission: r.external_transmission as 'forbidden' | 'allowed', allowedProviders: r.allowed_providers as string[], languages: r.languages as string[], revision: r.revision as number };
  }
  /** Refuses an external transmission unless the project policy allows this provider; the decision is audited either way. */
  async function requireExternal(ctx: ServiceContext, proc: ProcRow, provider: string, operation: string): Promise<void> {
    const policy = await policyOf(sql, ctx);
    const allowed = policy.externalTransmission === 'allowed' && policy.allowedProviders.includes(provider);
    let decision: kit.UseDecision | null = null;
    if (allowed && ports.useDecisions !== undefined) decision = await ports.useDecisions.decide(portCtx(ctx), { subjects: [proc.evidence_ref], action: 'process', purpose: ctx.purpose, destination: `external:${provider}` });
    const ok = allowed && (decision === null || decision.decision === 'allow');
    await sql.tx((tx) => kit.appendAudit(tx, S, ctx, ok ? 'processing.external_transmission_allowed' : 'processing.policy_denied', procRef(proc.id), { provider, operation, policyRevision: policy.revision, externalTransmission: policy.externalTransmission, ...(decision === null ? {} : { useDecision: decision.decision }) }));
    if (!ok) throw new DomainError('policy_denied', allowed ? 'The use decision does not allow transmission to this provider' : 'Project processing policy forbids external transmission to this provider');
  }
  /** Protective gate evaluated at request time and again inside every worker step. */
  async function gate(ctx: ServiceContext, proc: Pick<ProcRow, 'evidence_ref' | 'sources' | 'id'>): Promise<void> {
    const blocks = await sql.query<{ ref: string; reason: string }>(`select ref, reason from ${S}.block where tenant_id=$1 and project_id=$2`, [ctx.tenantId, ctx.projectId]);
    const hit = blocks.find((b) => proc.sources.some((s) => sameObject(b.ref, s)));
    if (hit !== undefined) throw new DomainError('consent_denied', `Processing is blocked: ${hit.reason}`);
    if (ports.authorization !== undefined) {
      const a = await ports.authorization.authorize(portCtx(ctx), { capability: 'processing:write', resource: proc.evidence_ref });
      if (!a.allowed) throw new DomainError('forbidden', `Authorization denied: ${a.reason}`);
    }
    if (ports.useDecisions === undefined) {
      if (config.standalone?.useDecisions !== 'allow') throw new DomainError('consent_denied', 'No use-decision port is configured and standalone mode is not selected');
      return;
    }
    const d = await ports.useDecisions.decide(portCtx(ctx), { subjects: [proc.evidence_ref], action: 'process', purpose: ctx.purpose });
    if (d.decision !== 'allow') throw new DomainError('consent_denied', `Use decision is ${d.decision}: ${d.reasons.join('; ').slice(0, 300)}`);
  }
  function sameObject(a: string, b: string): boolean {
    try { const x = kit.parseUref(a), y = kit.parseUref(b); return x.engine === y.engine && x.id === y.id && (x.kind === y.kind) && (x.revision === undefined || y.revision === undefined || x.revision === y.revision); } catch { return false; }
  }
  function evidence(): kit.EvidencePort {
    if (ports.evidence === undefined) throw new DomainError('unavailable', 'No evidence port is configured');
    return ports.evidence;
  }

  // ── row mapping ──
  async function loadProc(q: Sql, ctx: ServiceContext, id: string, lock = false): Promise<ProcRow> {
    const r = (await q.query<ProcRow>(`select * from ${S}.processing where id=$4 and ${VIS}${lock ? ' for update' : ''}`, [ctx.tenantId, ctx.projectId, cmp(ctx), uuid(id)]))[0];
    if (r === undefined) throw notFound();
    return r;
  }
  async function procView(q: Sql, p: ProcRow): Promise<ProcessingView> {
    const steps = await q.query<StepRow>(`select * from ${S}.step where processing_id=$1 order by ordinal`, [p.id]);
    const reps = await q.query<{ id: string; current_revision: number }>(`select id, current_revision from ${S}.representation where processing_id=$1 order by created_at, id`, [p.id]);
    return {
      id: p.id, ref: procRef(p.id), evidenceRef: p.evidence_ref, sha256: p.sha256, declaredMediaType: p.declared_media_type, mediaType: p.media_type, family: p.family, filename: p.filename,
      state: p.state, stale: p.stale, blocked: p.blocked, reasons: p.reasons, failure: p.failure, generation: p.generation, options: p.options as Json, createdAt: iso(p.created_at),
      steps: steps.map((s) => ({ id: s.id, name: s.name, tool: s.tool, toolVersion: s.tool_version, state: s.state, error: s.error, detail: s.detail, jobId: s.job_id })),
      representations: reps.map((r) => repRef(r.id, r.current_revision)),
    };
  }
  async function speakerLabels(q: Sql, ctx: ServiceContext, processingId: string): Promise<Map<string, SpeakerView>> {
    const out = new Map<string, SpeakerView>();
    for (const t of await q.query<{ label: string }>(`select distinct label from ${S}.speaker_turn where processing_id=$1 and tenant_id=$2 and project_id=$3 order by label`, [processingId, ctx.tenantId, ctx.projectId])) out.set(t.label, { label: t.label, provisional: true, attribution: null });
    for (const a of await q.query<R>(`select * from ${S}.speaker_attribution where processing_id=$1 and tenant_id=$2 and project_id=$3 and status='attributed' order by reviewed_at`, [processingId, ctx.tenantId, ctx.projectId])) {
      // An attribution is a reviewed claim about who is speaking. It never upgrades the label to a verified identity.
      out.set(a.label as string, { label: a.label as string, provisional: true, attribution: { id: a.id as string, identityRef: a.identity_ref as string, status: 'attributed', verified: false, basis: a.basis as string, reviewedBy: a.reviewed_by as string, reviewedAt: iso(a.reviewed_at) } });
    }
    return out;
  }
  async function loadRep(q: Sql, ctx: ServiceContext, ref: string, lock = false): Promise<R & { id: string; current_revision: number; processing_id: string; evidence_ref: string; kind: RepresentationView['kind']; blocked: boolean; requested?: number }> {
    const { id, revision } = repId(ref);
    const r = (await q.query<R>(`select * from ${S}.representation where id=$4 and ${VIS}${lock ? ' for update' : ''}`, [ctx.tenantId, ctx.projectId, cmp(ctx), id]))[0];
    if (r === undefined) throw notFound();
    if (revision !== undefined && (revision < 1 || revision > (r.current_revision as number))) throw notFound();
    return { ...r, ...(revision === undefined ? {} : { requested: revision }) } as never;
  }
  function segView(s: R, speakers: Map<string, SpeakerView>, withWords: boolean): SegmentView {
    const label = s.speaker as string | null;
    return {
      id: s.id as string, ordinal: s.ordinal as number, kind: s.kind as string, source: s.source as string, text: s.text as string, textRevision: s.text_revision as number, corrected: s.corrected as boolean,
      confidence: (s.confidence as number | null) ?? null, page: (s.page as number | null) ?? null, bbox: (s.bbox as SegmentView['bbox']) ?? null, startMs: (s.start_ms as number | null) ?? null, endMs: (s.end_ms as number | null) ?? null,
      anchor: (s.anchor as Json) ?? null, speaker: label === null || label === undefined ? null : speakers.get(label) ?? { label, provisional: true, attribution: null },
      sourceSegmentId: (s.source_segment_id as string | null) ?? null, words: withWords ? ((s.words as Word[] | null) ?? null) : null,
    };
  }
  const SEG_AT = `select s.*, t.text, t.words, t.confidence, t.corrected, t.revision as text_revision from ${S}.segment s
    join lateral (select * from ${S}.segment_text t where t.segment_id=s.id and t.revision <= $2 order by t.revision desc limit 1) t on true where s.representation_id=$1`;
  async function repView(q: Sql, ctx: ServiceContext, r: Awaited<ReturnType<typeof loadRep>>, revision: number, withSegments = true): Promise<RepresentationView> {
    if (r.blocked) throw new DomainError('consent_denied', 'This representation is blocked and its content cannot be read');
    const speakers = await speakerLabels(q, ctx, r.processing_id);
    const segs = withSegments ? await q.query<R>(`${SEG_AT} order by s.ordinal`, [r.id, revision]) : [];
    return {
      id: r.id, ref: repRef(r.id, revision), revision, currentRevision: r.current_revision, processingId: r.processing_id, evidenceRef: r.evidence_ref, kind: r.kind, label: r.label as string,
      language: r.language as string | null, languageConfidence: r.language_confidence as number | null, languageMethod: r.language_method as string | null,
      machine: r.machine as boolean, machineTranslation: r.kind === 'translation' && (r.machine as boolean), engine: r.engine as Json, sourceRef: r.source_ref as string | null,
      state: r.state as string, stale: r.stale as boolean, blocked: r.blocked, reasons: r.reasons as string[], quality: r.quality as Json, pages: r.pages as Json, segments: segs.map((s) => segView(s, speakers, true)),
    };
  }
  const derView = (d: R): DerivativeView => ({ id: d.id as string, ref: derRef(d.id as string), processingId: d.processing_id as string, kind: d.kind as string, page: (d.page as number | null) ?? null, mediaType: d.media_type as string, sha256: d.sha256 as string, size: Number(d.size), evidenceDerivativeRef: (d.evidence_derivative_ref as string | null) ?? null, representationRef: d.representation_id === null ? null : repRef(d.representation_id as string, d.representation_revision as number), stale: d.stale as boolean, blocked: d.blocked as boolean, reasons: d.reasons as string[], params: d.params as Json });

  // ── persistence of step outputs ──
  async function storeDerivative(ctx: ServiceContext, proc: ProcRow, d: DerivDraft): Promise<StoredDeriv> {
    const digest = sha(d.bytes);
    let objectKey: string | null = null, evidenceRef: string | null = null;
    if (deps.objects !== undefined) { objectKey = `${ctx.tenantId}/${ctx.projectId}/processing/${proc.id}/${digest.slice(0, 16)}-${d.filename}`; kit.validObjectKey(objectKey); await deps.objects.put(objectKey, d.bytes); }
    if (ports.evidence !== undefined) {
      const info = await ports.evidence.addDerivative(portCtx(ctx), { parent: proc.evidence_ref, bytes: d.bytes, mediaType: d.mediaType, filename: d.filename, relation: d.kind, tool: { engine: E, processing: procRef(proc.id), ...(d.params as R) } as Json, idempotencyKey: `e06:${proc.id}:${d.kind}:${d.page ?? 0}:${digest}` });
      evidenceRef = info.ref;
    }
    invariant(objectKey !== null || evidenceRef !== null, 'unavailable', 'Neither an object store nor an evidence port is configured to hold derivatives');
    return { kind: d.kind, page: d.page, mediaType: d.mediaType, filename: d.filename, params: d.params, objectKey, evidenceRef, sha256: digest, size: d.bytes.byteLength };
  }
  async function insertDerivative(tx: Sql, ctx: ServiceContext, proc: ProcRow, stepId: string | null, d: StoredDeriv, rep?: { id: string; revision: number }): Promise<string> {
    const id = randomUUID();
    await tx.query(`insert into ${S}.derivative (id, tenant_id, project_id, processing_id, step_id, representation_id, representation_revision, kind, page, media_type, object_key, evidence_derivative_ref, sha256, size, params, compartment, created_at, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`, [id, ctx.tenantId, ctx.projectId, proc.id, stepId, rep?.id ?? null, rep?.revision ?? null, d.kind, d.page, d.mediaType, d.objectKey, d.evidenceRef, d.sha256, d.size, J(d.params), proc.compartment, ctx.now, ctx.actor.id]);
    return id;
  }
  async function insertRepresentation(tx: Sql, ctx: ServiceContext, proc: ProcRow, stepId: string, d: RepDraft): Promise<{ id: string; segmentIds: string[] }> {
    invariant(d.segments.length <= limits.maxSegments, 'payload_too_large', 'Too many segments');
    const id = randomUUID();
    const rows = d.segments.map((s, i) => ({ id: randomUUID(), ordinal: i + 1, kind: s.kind, source: s.source, page: s.page ?? null, bbox: s.bbox ?? null, start_ms: s.startMs ?? null, end_ms: s.endMs ?? null, anchor: s.anchor ?? null, speaker: s.speaker ?? null, source_segment_id: s.sourceSegmentId ?? null, text: s.text, words: s.words ?? null, confidence: s.confidence ?? null }));
    await tx.query(`insert into ${S}.representation (id, tenant_id, project_id, processing_id, step_id, evidence_ref, kind, language, language_confidence, language_method, machine, engine, source_ref, label, quality, pages, compartment, sources, created_at, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16::jsonb,$17,$18::jsonb,$19,$20)`,
      [id, ctx.tenantId, ctx.projectId, proc.id, stepId, proc.evidence_ref, d.kind, d.language, d.languageConfidence, d.languageMethod, d.machine, J(d.engine), d.sourceRef, d.label, J(d.quality), J(d.pages), proc.compartment, J([...proc.sources, ...(d.extraSources ?? [])]), ctx.now, ctx.actor.id]);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = J(rows.slice(i, i + 1000));
      await tx.query(`insert into ${S}.segment (id, tenant_id, project_id, representation_id, ordinal, kind, source, page, bbox, start_ms, end_ms, anchor, speaker, source_segment_id)
        select x.id, $1, $2, $3, x.ordinal, x.kind, x.source, x.page, x.bbox, x.start_ms, x.end_ms, x.anchor, x.speaker, x.source_segment_id
        from jsonb_to_recordset($4::jsonb) as x(id uuid, ordinal int, kind text, source text, page int, bbox jsonb, start_ms int, end_ms int, anchor jsonb, speaker text, source_segment_id uuid)`, [ctx.tenantId, ctx.projectId, id, chunk]);
      await tx.query(`insert into ${S}.segment_text (segment_id, revision, tenant_id, project_id, representation_id, text, words, confidence)
        select x.id, 1, $1, $2, $3, x.text, x.words, x.confidence from jsonb_to_recordset($4::jsonb) as x(id uuid, text text, words jsonb, confidence real)`, [ctx.tenantId, ctx.projectId, id, chunk]);
    }
    await tx.query(`insert into ${S}.representation_revision (representation_id, revision, tenant_id, project_id, at, actor_id, actor_kind, reason, segment_ids, text_sha256) values ($1,1,$2,$3,$4,$5,$6,$7,'[]',$8)`,
      [id, ctx.tenantId, ctx.projectId, ctx.now, ctx.actor.id, ctx.actor.kind, `Produced by ${String((d.engine as R).id ?? 'tool')}`, sha(rows.map((r) => r.text).join('\n'))]);
    return { id, segmentIds: rows.map((r) => r.id) };
  }

  // ── language choice ──
  async function wantedLanguages(ctx: ServiceContext, proc: ProcRow): Promise<string[]> {
    const requested = proc.options.languages as string[] | undefined;
    if (requested !== undefined && requested.length > 0) return requested;
    const policy = await policyOf(sql, ctx);
    return policy.languages.length > 0 ? policy.languages : config.defaultLanguages ?? ['auto'];
  }
  async function ocrLanguages(wanted: string[], cwd: string, image: string, warnings: string[]): Promise<{ languages: string[]; osd: Awaited<ReturnType<typeof tools.tesseractOsd>> }> {
    const installed = (await tools.tesseractLanguages(runner)).filter((l) => l !== 'osd' && l !== 'equ');
    if (installed.length === 0) throw new DomainError('unavailable', 'OCR is unavailable: tesseract or its language data is not installed');
    const osd = (await tools.tesseractLanguages(runner)).includes('osd') ? await tools.tesseractOsd(runner, cwd, image) : null;
    const explicit = wanted.filter((l) => l !== 'auto');
    const missing = explicit.filter((l) => !installed.includes(l));
    if (missing.length > 0) warnings.push(`OCR language data not installed for: ${missing.join(', ')}`);
    let languages = explicit.filter((l) => installed.includes(l));
    if (languages.length === 0) {
      if (explicit.length > 0) throw new DomainError('unavailable', `OCR language data is not installed for ${explicit.join(', ')}`);
      languages = osd === null ? [] : installed.filter((l) => profiles[l]?.script === osd.script);
      if (languages.length === 0) { languages = installed.slice(0, 3); warnings.push('Script could not be detected; OCR used every installed language, which lowers accuracy.'); }
    }
    return { languages: languages.slice(0, 4), osd };
  }
  function languageOf(segments: SegmentDraft[]): tools.LanguageGuess {
    let text = '';
    for (const s of segments) { if (text.length > 30000) break; text += `${s.text}\n`; }
    return tools.detectLanguage(text, profiles);
  }

  // ───────────────────────────── Step executors ─────────────────────────────
  type Exec = (ctx: ServiceContext, proc: ProcRow, step: StepRow, bytes: Uint8Array, sniffed: Sniffed, signal: AbortSignal) => Promise<StepOutput>;
  const empty = (): StepOutput => ({ observations: [], derivatives: [], detail: {}, lowQuality: [] });

  const execMetadata: Exec = (_ctx, proc, _step, bytes, sniffed, signal) => runner.workdir(async (cwd) => {
    const out = empty();
    const file = await tools.writeInput(cwd, `input.${sniffed.ext}`, bytes);
    const used: string[] = [];
    if (proc.declared_media_type !== sniffed.mediaType && proc.declared_media_type !== 'application/octet-stream') out.observations.push({ kind: 'warning', data: { code: 'media_type_mismatch', declared: proc.declared_media_type, detected: sniffed.mediaType, note: 'The declared media type differs from the content; processing follows the content.' }, tool: 'sniff', toolVersion: manifest.version });
    const exifVersion = await runner.version('exiftool');
    if (exifVersion !== null) {
      out.observations.push({ kind: 'metadata', data: { source: 'exiftool', forgeable: true, verified: false, tags: await tools.exifMetadata(runner, cwd, file) }, tool: 'exiftool', toolVersion: exifVersion, caveat: METADATA_CAVEAT });
      used.push('exiftool');
    } else out.observations.push({ kind: 'warning', data: { code: 'tool_unavailable', missing: 'exiftool' }, tool: 'exiftool', toolVersion: 'missing' });
    if (sniffed.family === 'media') {
      const probe = await tools.ffprobe(runner, cwd, file);
      out.observations.push({ kind: 'metadata', data: { source: 'ffprobe', forgeable: true, verified: false, container: probe.format, durationMs: probe.durationMs, streams: probe.streams, tags: probe.tags } as unknown as Json, tool: 'ffprobe', toolVersion: await runner.version('ffprobe') ?? 'unknown', caveat: METADATA_CAVEAT });
      used.push('ffprobe');
    }
    if (sniffed.family === 'pdf') {
      const info = await tools.pdfInfo(runner, cwd, file);
      out.observations.push({ kind: 'metadata', data: { source: 'pdfinfo', forgeable: true, verified: false, ...info }, tool: 'pdfinfo', toolVersion: await runner.version('pdfinfo') ?? 'unknown', caveat: METADATA_CAVEAT });
      if (info.javascript) out.observations.push({ kind: 'warning', data: { code: 'pdf_contains_javascript', note: 'Embedded scripts are never executed by this engine.' }, tool: 'pdfinfo', toolVersion: await runner.version('pdfinfo') ?? 'unknown' });
      used.push('pdfinfo');
    }
    void signal;
    out.detail = { tools: used };
    return out;
  });

  async function extractPdf(ctx: ServiceContext, proc: ProcRow, cwd: string, file: string, origin: 'original' | 'converted_pdf', signal: AbortSignal): Promise<StepOutput> {
    const out = empty();
    const info = await tools.pdfInfo(runner, cwd, file);
    if (info.encrypted) throw new DomainError('tool_failed', 'The PDF is encrypted; text cannot be extracted without its password');
    invariant(info.pages > 0 && info.pages <= limits.maxPages, 'tool_failed', `PDF page count ${info.pages} is outside the limit of ${limits.maxPages}`);
    const pages: PageInfo[] = [], segments: SegmentDraft[] = [];
    for (let first = 1; first <= info.pages; first += 50) {
      if (signal.aborted) throw new DomainError('process_aborted', 'Processing was cancelled');
      const part = await tools.pdfTextLayout(runner, cwd, file, first, Math.min(info.pages, first + 49));
      pages.push(...part.pages); segments.push(...part.segments);
    }
    const needOcr = pages.filter((p) => p.source === 'empty');
    const ocrVersion = await runner.version('tesseract');
    const pdfVersion = await runner.version('pdftotext') ?? 'unknown';
    const warnings: string[] = [];
    let languages: string[] | null = null;
    const searchable: string[] = [];
    const wanted = await wantedLanguages(ctx, proc);
    if (needOcr.length > 0 && ocrVersion === null) {
      warnings.push(`${needOcr.length} page(s) have no text layer and OCR is unavailable (tesseract is not installed).`);
      out.observations.push({ kind: 'warning', data: { code: 'ocr_unavailable', pages: needOcr.map((p) => p.page), missing: 'tesseract' }, tool: 'tesseract', toolVersion: 'missing' });
    } else {
      for (const [i, page] of needOcr.entries()) {
        if (signal.aborted) throw new DomainError('process_aborted', 'Processing was cancelled');
        if (i >= limits.maxOcrPages) { warnings.push(`OCR stopped after ${limits.maxOcrPages} pages (limit); later pages without a text layer were not read.`); break; }
        const dpi = Math.max(72, Math.min(limits.ocrDpi, Math.floor(6000 * 72 / Math.max(page.width, page.height))));
        const image = await tools.pdfRasterize(runner, cwd, file, page.page, dpi, `page-${page.page}`);
        const pageWarnings: string[] = [];
        let osd: Awaited<ReturnType<typeof tools.tesseractOsd>> = null;
        if (languages === null || wanted.includes('auto')) { const pick = await ocrLanguages(wanted, cwd, image, pageWarnings); languages = pick.languages; osd = pick.osd; }
        const wantPdf = needOcr.length === pages.length;
        const ocr = await tools.ocrImage(runner, cwd, image, { languages, page: page.page, scale: 72 / dpi, lowConfidence, dpi, ...(wantPdf ? { searchablePdf: 'yes' } : {}) });
        if (wantPdf) searchable.push(join(cwd, `ocr-${page.page}.pdf`));
        page.source = ocr.segments.length > 0 ? 'ocr' : 'empty';
        page.ocr = { ...ocr.stats, orientationDegrees: osd?.orientation ?? null, script: osd?.script ?? null, scriptConfidence: osd?.scriptConfidence ?? null };
        qualityOfPage(page, pageWarnings, out);
        segments.push(...ocr.segments);
      }
    }
    segments.sort((a, b) => (a.page as number) - (b.page as number));
    for (const p of pages) if (p.source === 'empty') p.warnings.push('No text was found on this page.');
    const guess = languageOf(segments);
    out.observations.push({ kind: 'language', data: guess as unknown as Json, tool: 'language-profile', toolVersion: manifest.version, caveat: 'Coarse identification among configured languages; null means undetermined, not absent.' });
    for (const w of warnings) out.observations.push({ kind: 'warning', data: { code: 'extraction_warning', note: w }, tool: 'pdftotext', toolVersion: pdfVersion });
    const ocrPages = pages.filter((p) => p.ocr !== undefined);
    const engine: EngineInfo & R = { id: ocrPages.length > 0 ? 'pdftotext+tesseract' : 'pdftotext', version: ocrPages.length > 0 ? `${pdfVersion}+${ocrVersion}` : pdfVersion, model: languages === null ? null : languages.join('+'), local: true, anchorSpace: origin };
    out.representation = {
      kind: 'text', language: guess.language, languageConfidence: guess.confidence, languageMethod: guess.method, machine: true, engine: engine as unknown as Json, sourceRef: null,
      label: ocrPages.length === 0 ? 'Text layer extracted from PDF' : ocrPages.length === pages.length ? 'Machine-read text (OCR)' : 'Text layer with machine-read (OCR) pages',
      quality: { pages: pages.length, textLayerPages: pages.filter((p) => p.source === 'text_layer').length, ocrPages: ocrPages.length, emptyPages: pages.filter((p) => p.source === 'empty').length, ocrMeanConfidence: mean(ocrPages.map((p) => p.ocr?.meanConfidence).filter((c): c is number => typeof c === 'number')), warnings, coordinateUnit: 'pt', coordinateOrigin: 'top-left', anchorSpace: origin },
      pages, segments,
    };
    if (searchable.length > 0 && ocrPages.some((p) => p.source === 'ocr')) {
      let pdf = searchable[0] as string;
      if (searchable.length > 1 && await tools.which('pdfunite') !== null) { pdf = join(cwd, 'searchable.pdf'); await runner.run('pdfunite', [...searchable, pdf], { cwd }); }
      if (searchable.length === 1 || pdf.endsWith('searchable.pdf')) out.derivatives.push({ kind: 'searchable_pdf', page: null, mediaType: 'application/pdf', filename: 'searchable.pdf', bytes: await readFile(pdf), params: { tool: 'tesseract', toolVersion: ocrVersion, languages, note: 'Image pages with an invisible machine-read text layer; the text is OCR output, not the original.' } as Json });
    }
    out.detail = { pages: pages.length, ocrPages: ocrPages.length, segments: segments.length, languages };
    return out;
  }
  function qualityOfPage(page: PageInfo, extra: string[], out: StepOutput): void {
    const o = page.ocr;
    page.warnings.push(...extra);
    if (o === undefined) return;
    if (o.words === 0) page.warnings.push('OCR found no words on this page.');
    if (o.meanConfidence !== null && o.meanConfidence < lowQualityMean) { page.warnings.push(`Low OCR confidence (mean ${o.meanConfidence}).`); out.lowQuality.push(`page ${page.page}: mean OCR confidence ${o.meanConfidence}`); }
    if (o.skewDegrees !== null && Math.abs(o.skewDegrees) >= 1.5) page.warnings.push(`Page appears skewed by about ${o.skewDegrees}°.`);
    if (o.orientationDegrees !== null && o.orientationDegrees !== 0) page.warnings.push(`Page appears rotated by ${o.orientationDegrees}°.`);
    out.observations.push({ kind: 'quality', page: page.page, data: { ...o, lowConfidenceThreshold: lowConfidence, warnings: page.warnings } as unknown as Json, tool: 'tesseract', toolVersion: 'see step' });
  }

  const execExtract: Exec = (ctx, proc, _step, bytes, sniffed, signal) => runner.workdir(async (cwd) => {
    const file = await tools.writeInput(cwd, `input.${sniffed.ext}`, bytes);
    if (sniffed.family === 'pdf') return extractPdf(ctx, proc, cwd, file, 'original', signal);
    if (sniffed.family === 'image') {
      const out = empty();
      const coder = sniffed.imageCoder as string;
      const info = await tools.imageInfo(runner, cwd, coder, file);
      invariant(info.width * info.height <= 200_000_000, 'tool_failed', 'Image is too large to process');
      await tools.imageToPng(runner, cwd, coder, file, join(cwd, 'page-1.png'));
      const pageWarnings: string[] = [];
      if (Math.max(info.width, info.height) < 1000 || (info.dpi !== null && info.dpi < 150)) pageWarnings.push(`Low resolution (${info.width}×${info.height}${info.dpi === null ? '' : `, ${info.dpi} dpi`}); small text may be misread.`);
      const pick = await ocrLanguages(await wantedLanguages(ctx, proc), cwd, join(cwd, 'page-1.png'), pageWarnings);
      const ocr = await tools.ocrImage(runner, cwd, join(cwd, 'page-1.png'), { languages: pick.languages, page: 1, scale: 1, lowConfidence, dpi: info.dpi !== null && info.dpi >= 70 ? info.dpi : null, searchablePdf: 'yes' });
      const page: PageInfo = { page: 1, width: info.width, height: info.height, unit: 'px', source: ocr.segments.length > 0 ? 'ocr' : 'empty', warnings: [], ocr: { ...ocr.stats, orientationDegrees: pick.osd?.orientation ?? null, script: pick.osd?.script ?? null, scriptConfidence: pick.osd?.scriptConfidence ?? null } };
      qualityOfPage(page, pageWarnings, out);
      const guess = languageOf(ocr.segments);
      out.observations.push({ kind: 'language', data: guess as unknown as Json, tool: 'language-profile', toolVersion: manifest.version, caveat: 'Coarse identification among configured languages; null means undetermined, not absent.' });
      const version = await runner.version('tesseract') ?? 'unknown';
      out.representation = { kind: 'text', language: guess.language, languageConfidence: guess.confidence, languageMethod: guess.method, machine: true, engine: { id: 'tesseract', version, model: pick.languages.join('+'), local: true }, sourceRef: null, label: 'Machine-read text (OCR)', quality: { pages: 1, ocrPages: 1, ocrMeanConfidence: ocr.stats.meanConfidence, warnings: page.warnings, coordinateUnit: 'px', coordinateOrigin: 'top-left', anchorSpace: 'original' }, pages: [page], segments: ocr.segments };
      if (ocr.segments.length > 0) out.derivatives.push({ kind: 'searchable_pdf', page: null, mediaType: 'application/pdf', filename: 'searchable.pdf', bytes: await readFile(join(cwd, 'ocr-1.pdf')), params: { tool: 'tesseract', toolVersion: version, languages: pick.languages, note: 'Image with an invisible machine-read text layer; the text is OCR output, not the original.' } });
      out.detail = { pages: 1, ocrPages: 1, segments: ocr.segments.length, languages: pick.languages };
      return out;
    }
    if (sniffed.family === 'captions') {
      // Supplied captions are assertions made by whoever wrote them. They are imported literally and bound to the media version.
      const mediaRef = proc.options.captionsFor as string | undefined;
      if (mediaRef === undefined) return textRepresentation(tools.paragraphsOf(new TextDecoder().decode(bytes)), 'plain-text', manifest.version, 'Caption file read as plain text (no media binding supplied)');
      const media = await evidence().describe(portCtx(ctx), mediaRef);
      if (media === null || !media.available) throw new DomainError('tool_failed', 'The media version the captions refer to is not available');
      const mediaBytes = await evidence().getBytes(portCtx(ctx), media.ref);
      const mediaSniff = tools.sniff(mediaBytes);
      invariant(mediaSniff.family === 'media', 'tool_failed', 'captionsFor does not name an audio or video version');
      const probe = await tools.ffprobe(runner, cwd, await tools.writeInput(cwd, `media.${mediaSniff.ext}`, mediaBytes));
      invariant(probe.durationMs !== null && probe.durationMs > 0, 'tool_failed', 'Media duration is unknown');
      const scope = { tenantId: ctx.tenantId, projectId: ctx.projectId };
      let imported: ReturnType<typeof importWebVtt>;
      try {
        imported = importWebVtt(ctx, { source: { ...scope, kind: 'evidence_version', id: proc.evidence_id, revision: proc.evidence_revision }, sha256: proc.sha256, scanStatus: 'clean', processingAllowed: true, bytes }, { source: { ...scope, kind: 'evidence_version', id: media.evidenceId, revision: media.revision }, sha256: media.sha256, durationMs: probe.durationMs, processingAllowed: true });
      } catch (error) { throw new DomainError('tool_failed', `Caption import rejected the file: ${error instanceof DomainError ? error.code : 'error'}`); }
      const out = empty();
      const segments: SegmentDraft[] = imported.cues.map((c) => ({ kind: 'cue', source: 'import', text: c.text, startMs: c.startMs, endMs: c.endMs, anchor: { cueId: c.advertisedId, byteStart: c.sourceByteStart, byteEnd: c.sourceByteEnd }, confidence: null }));
      const guess = languageOf(segments);
      out.representation = { kind: 'captions', language: guess.language, languageConfidence: guess.confidence, languageMethod: guess.method, machine: false, engine: { id: imported.processor, version: '1', model: null, local: true }, sourceRef: null, label: 'Supplied captions (unverified wording and timing)', quality: { warnings: [...imported.warnings], mediaRef: media.ref, mediaDurationMs: probe.durationMs }, pages: [], segments, extraSources: [media.ref] };
      out.detail = { cues: segments.length, mediaRef: media.ref };
      return out;
    }
    // text, html, mail and office documents
    if (sniffed.reader === 'plain') return textRepresentation(tools.paragraphsOf(new TextDecoder('utf-8', { fatal: false }).decode(bytes)), 'plain-text', manifest.version, 'Plain text');
    if (sniffed.reader === 'eml') {
      const mail = tools.parseEml(bytes);
      let body = mail.text;
      let via = 'eml-reader';
      if (body === null && mail.html !== null) { body = await tools.pandocToText(runner, cwd, await tools.writeInput(cwd, 'body.html', Buffer.from(mail.html, 'utf8')), 'html'); via = 'eml-reader+pandoc'; }
      const header = ['from', 'to', 'cc', 'date', 'subject'].filter((h) => mail.headers[h] !== undefined).map((h) => `${h[0]?.toUpperCase()}${h.slice(1)}: ${mail.headers[h]}`).join('\n');
      const out = textRepresentation(tools.paragraphsOf(`${header}\n\n${body ?? ''}`), via, manifest.version, 'Message headers and body text');
      out.observations.push({ kind: 'metadata', data: { source: 'message-headers', forgeable: true, verified: false, headers: Object.fromEntries(Object.entries(mail.headers).filter(([k]) => ['from', 'to', 'cc', 'date', 'subject', 'message-id', 'reply-to', 'return-path'].includes(k)).map(([k, v]) => [k, v.slice(0, 500)])) }, tool: 'eml-reader', toolVersion: manifest.version, caveat: 'Message headers are supplied by the sender and intermediaries and can be forged.' });
      if (body === null) out.observations.push({ kind: 'warning', data: { code: 'no_text_body', note: 'The message has no text or HTML body part; attachments are not opened.' }, tool: 'eml-reader', toolVersion: manifest.version });
      return out;
    }
    if (sniffed.reader === 'pandoc') {
      const version = await runner.version('pandoc');
      if (version === null) throw tools.unavailable('pandoc');
      return textRepresentation(tools.paragraphsOf(await tools.pandocToText(runner, cwd, file, sniffed.pandocFormat as string)), 'pandoc', version, `Text converted from ${sniffed.ext}`);
    }
    if (sniffed.reader === 'libreoffice') {
      if (await runner.version('soffice') === null) throw tools.unavailable('soffice (LibreOffice)');
      const pdf = await tools.officeToPdf(runner, cwd, file);
      const out = await extractPdf(ctx, proc, cwd, pdf, 'converted_pdf', signal);
      if (out.representation !== undefined) { out.representation.label = `Text from a PDF rendering of the ${sniffed.ext} file (page positions refer to the rendering)`; (out.representation.engine as R).converter = `soffice ${await runner.version('soffice')}`; }
      return out;
    }
    throw new DomainError('unsupported_media_type', `No extraction pipeline for ${sniffed.mediaType}`);
  });
  function textRepresentation(segments: SegmentDraft[], tool: string, version: string, label: string): StepOutput {
    const out = empty();
    const guess = languageOf(segments);
    out.observations.push({ kind: 'language', data: guess as unknown as Json, tool: 'language-profile', toolVersion: manifest.version, caveat: 'Coarse identification among configured languages; null means undetermined, not absent.' });
    out.representation = { kind: 'text', language: guess.language, languageConfidence: guess.confidence, languageMethod: guess.method, machine: tool !== 'plain-text', engine: { id: tool, version, model: null, local: true }, sourceRef: null, label, quality: { paragraphs: segments.length, anchorSpace: 'converted_text', note: 'Paragraph anchors count paragraphs and character offsets in the converted plain text.' }, pages: [], segments };
    out.detail = { segments: segments.length };
    return out;
  }

  const execDiarize: Exec = (_ctx, _proc, _step, bytes, sniffed, signal) => runner.workdir(async (cwd) => {
    const out = empty();
    const file = await tools.writeInput(cwd, `input.${sniffed.ext}`, bytes);
    const probe = await tools.ffprobe(runner, cwd, file);
    if (!probe.hasAudio) { out.detail = { speakers: 0, note: 'no audio stream' }; return out; }
    const audio = await tools.normalizeAudio(runner, cwd, file, limits.maxMediaSeconds);
    const result = await adapters.diarize(runner, cwd, audio.raw, { ...(config.python === undefined ? {} : { python: config.python }), signal });
    out.turns = result.turns;
    out.observations.push({ kind: 'quality', data: { scope: 'speaker_segmentation', method: result.method, speakers: result.speakers, provisional: true, ...result.quality } as Json, tool: result.tool, toolVersion: result.version, caveat: 'Speaker labels are provisional acoustic clusters. They do not identify any person and may merge or split real speakers.' });
    out.detail = { speakers: result.speakers, turns: result.turns.length, provisional: true };
    return out;
  });

  async function pickAsr(ctx: ServiceContext, proc: ProcRow, language: string | null): Promise<AsrAdapter> {
    const requested = proc.options.asrProvider as string | undefined;
    if (requested !== undefined) {
      const local = asrLocal.find((a) => a.id === requested);
      if (local !== undefined) return local;
      const external = asrExternal.get(requested);
      if (external === undefined) throw new DomainError('unavailable', `Speech recognition provider ${requested} is not configured`);
      await requireExternal(ctx, proc, requested, 'transcribe');
      return external;
    }
    const reasons: string[] = [];
    for (const a of asrLocal) {
      const info = await a.describe();
      if (!info.available) { reasons.push(`${a.id}: missing ${info.missing}`); continue; }
      if (language !== null && info.languages !== undefined && !info.languages.includes(language)) { reasons.push(`${a.id}: no model for ${language}`); continue; }
      return a;
    }
    throw new DomainError('unavailable', `No local speech recognition engine is available (${reasons.join('; ') || 'none configured'}); an external provider must be requested explicitly and allowed by policy`);
  }
  const execTranscribe: Exec = (ctx, proc, _step, bytes, sniffed, signal) => runner.workdir(async (cwd) => {
    const out = empty();
    const file = await tools.writeInput(cwd, `input.${sniffed.ext}`, bytes);
    const probe = await tools.ffprobe(runner, cwd, file);
    if (!probe.hasAudio) throw new DomainError('tool_failed', 'The file has no audio stream to transcribe');
    const wanted = (await wantedLanguages(ctx, proc)).filter((l) => l !== 'auto');
    const language = wanted[0] ?? null;
    const adapter = await pickAsr(ctx, proc, language);
    const audio = await tools.normalizeAudio(runner, cwd, file, limits.maxMediaSeconds);
    let reservation: string | null = null;
    if (!adapter.local && ports.budget !== undefined) reservation = (await ports.budget.reserve(portCtx(ctx), { category: 'processing.transcription', amount: Math.ceil(audio.durationMs / 1000), unit: 'audio_seconds', subject: procRef(proc.id), idempotencyKey: `e06:asr:${proc.id}:${adapter.id}` })).reservationId;
    let result: adapters.AsrResult;
    try { result = await adapter.transcribe({ rawPath: audio.raw, wavPath: audio.wav, durationMs: audio.durationMs, language, cwd, signal }); }
    catch (error) { if (reservation !== null) await ports.budget?.release(portCtx(ctx), reservation, 'transcription failed'); throw error; }
    if (reservation !== null) await ports.budget?.commit(portCtx(ctx), reservation, { amount: Math.ceil(audio.durationMs / 1000) });
    const turns = await sql.query<{ label: string; start_ms: number; end_ms: number }>(`select label, start_ms, end_ms from ${S}.speaker_turn where processing_id=$1 order by start_ms`, [proc.id]);
    const speakerAt = (s: number, e: number): string | null => {
      let best: string | null = null, overlap = 0;
      for (const t of turns) { const o = Math.min(e, t.end_ms) - Math.max(s, t.start_ms); if (o > overlap) { overlap = o; best = t.label; } }
      if (best === null) { const mid = (s + e) / 2; const near = turns.filter((t) => Math.abs((t.start_ms + t.end_ms) / 2 - mid) <= (t.end_ms - t.start_ms) / 2 + 400)[0]; best = near?.label ?? null; }
      return best;
    };
    const segments: SegmentDraft[] = [];
    if (result.words.length > 0) {
      let current: { words: Word[]; speaker: string | null } | null = null;
      const flush = (): void => {
        if (current === null || current.words.length === 0) return;
        const ws = current.words, conf = ws.map((w) => w.c).filter((c): c is number => typeof c === 'number');
        segments.push({ kind: 'utterance', source: 'asr', text: ws.map((w) => w.t).join(' '), startMs: ws[0]?.s as number, endMs: ws[ws.length - 1]?.e as number, words: ws, confidence: mean(conf), speaker: current.speaker });
        current = null;
      };
      for (const w of result.words) {
        const speaker = speakerAt(w.s as number, w.e as number);
        const last: Word | undefined = current === null ? undefined : (current as { words: Word[] }).words.at(-1);
        if (current !== null && (speaker !== (current as { speaker: string | null }).speaker || (last !== undefined && (w.s as number) - (last.e as number) > 700) || (current as { words: Word[] }).words.length >= 40)) flush();
        current ??= { words: [], speaker };
        current.words.push(w);
      }
      flush();
    } else for (const s of result.segments) segments.push({ kind: 'utterance', source: 'asr', text: s.text, startMs: s.startMs, endMs: s.endMs, confidence: s.confidence, speaker: speakerAt(s.startMs, s.endMs) });
    const confs = result.words.map((w) => w.c).filter((c): c is number => typeof c === 'number');
    const meanConfidence = mean(confs.length > 0 ? confs : result.segments.map((s) => s.confidence).filter((c): c is number => typeof c === 'number'));
    const warnings = [...result.warnings];
    if (probe.durationMs !== null && probe.durationMs > limits.maxMediaSeconds * 1000) warnings.push(`Only the first ${limits.maxMediaSeconds} seconds were transcribed (limit).`);
    if (segments.length === 0) warnings.push('The recogniser returned no words.');
    if (meanConfidence !== null && meanConfidence < 0.5) out.lowQuality.push(`transcript: mean recogniser confidence ${meanConfidence}`);
    const guess = languageOf(segments);
    out.observations.push({ kind: 'quality', data: { scope: 'transcription', engine: result.engine, words: result.words.length, meanConfidence, lowConfidenceWords: confs.filter((c) => c < lowConfidence).length, confidenceKind: confs.length > 0 ? 'engine word score (uncalibrated)' : 'not provided by engine', warnings } as unknown as Json, tool: result.engine.id, toolVersion: result.engine.version });
    out.representation = {
      kind: 'transcript', language: result.language ?? guess.language, languageConfidence: result.language !== null && wanted.length > 0 ? null : guess.confidence, languageMethod: result.language !== null && wanted.length > 0 ? 'requested' : guess.method,
      machine: true, engine: result.engine as unknown as Json, sourceRef: null, label: `Machine transcript (${result.engine.local ? 'local' : 'external'} ${result.engine.id})`,
      quality: { durationMs: audio.durationMs, timebase: 'milliseconds from the start of the first audio stream', streamStartMs: probe.streams.find((s) => s.type === 'audio')?.startTimeMs ?? null, meanConfidence, warnings, speakerLabels: 'provisional' }, pages: [], segments,
    };
    out.detail = { engine: result.engine.id, local: result.engine.local, words: result.words.length, segments: segments.length };
    return out;
  });

  const execThumbnails: Exec = (_ctx, _proc, _step, bytes, sniffed, signal) => runner.workdir(async (cwd) => {
    const out = empty();
    const file = await tools.writeInput(cwd, `input.${sniffed.ext}`, bytes);
    const add = async (path: string, page: number | null, kind: string, tool: string): Promise<void> => { out.derivatives.push({ kind, page, mediaType: 'image/png', filename: `${kind}${page === null ? '' : `-${page}`}.png`, bytes: await readFile(path), params: { tool, toolVersion: await runner.version(tool) } }); };
    if (sniffed.family === 'pdf' || (sniffed.family === 'office' && await runner.version('soffice') !== null)) {
      const pdf = sniffed.family === 'pdf' ? file : await tools.officeToPdf(runner, cwd, file);
      const pages = Math.min((await tools.pdfInfo(runner, cwd, pdf)).pages, limits.thumbnailPages);
      for (let p = 1; p <= pages; p++) { if (signal.aborted) break; await add(await tools.pdfRasterize(runner, cwd, pdf, p, 40, `thumb-${p}`, true), p, 'thumbnail', 'pdftoppm'); }
    } else if (sniffed.family === 'image') {
      await tools.imageToPng(runner, cwd, sniffed.imageCoder as string, file, join(cwd, 'thumb.png'), 320);
      await add(join(cwd, 'thumb.png'), 1, 'thumbnail', 'convert');
    } else if (sniffed.family === 'media') {
      const probe = await tools.ffprobe(runner, cwd, file);
      if (probe.hasVideo) { const at = Math.min(Math.round((probe.durationMs ?? 0) * 0.1), 10_000); await tools.videoFrame(runner, cwd, file, at, join(cwd, 'poster.png')); out.derivatives.push({ kind: 'thumbnail', page: null, mediaType: 'image/png', filename: 'poster.png', bytes: await readFile(join(cwd, 'poster.png')), params: { tool: 'ffmpeg', toolVersion: await runner.version('ffmpeg'), atMs: at } }); }
      if (probe.hasAudio) { await tools.waveformImage(runner, cwd, file, join(cwd, 'waveform.png')); await add(join(cwd, 'waveform.png'), null, 'waveform', 'ffmpeg'); }
    } else throw new DomainError('unavailable', `No thumbnail tool for ${sniffed.mediaType}`);
    out.detail = { images: out.derivatives.length };
    return out;
  });

  async function pickTranslator(ctx: ServiceContext, proc: ProcRow, provider: string | undefined, source: string, target: string): Promise<TranslationAdapter> {
    if (provider !== undefined) {
      const local = mtLocal.find((a) => a.id === provider);
      if (local !== undefined) return local;
      const external = mtExternal.get(provider);
      if (external === undefined) throw new DomainError('unavailable', `Translation provider ${provider} is not configured`);
      await requireExternal(ctx, proc, provider, 'translate');
      return external;
    }
    for (const a of mtLocal) if (await a.supports(source, target)) return a;
    throw new DomainError('unavailable', `No local translation engine supports ${source}-${target}; an external provider must be requested explicitly and allowed by policy`);
  }
  const execTranslate: Exec = async (ctx, proc, step, _bytes, _sniffed, signal) => {
    const out = empty();
    const target = step.params.target as string;
    const src = step.params.representationId === undefined
      ? (await sql.query<R>(`select * from ${S}.representation where processing_id=$1 and kind in ('text','transcript','captions') and state='current' order by created_at limit 1`, [proc.id]))[0]
      : (await sql.query<R>(`select * from ${S}.representation where id=$1 and processing_id=$2`, [step.params.representationId, proc.id]))[0];
    if (src === undefined) throw new DomainError('tool_failed', 'There is no source text to translate');
    if (src.blocked === true) throw new DomainError('consent_denied', 'The source representation is blocked');
    const revision = (step.params.revision as number | undefined) ?? (src.current_revision as number);
    const source = (step.params.source as string | undefined) ?? (src.language as string | null);
    if (source === null || source === undefined) throw new DomainError('unavailable', 'The source language is undetermined; translation needs an explicit source language');
    if (source === target) throw new DomainError('tool_failed', 'Source and target language are the same');
    const adapter = await pickTranslator(ctx, proc, step.params.provider as string | undefined, source, target);
    const segs = await sql.query<R>(`${SEG_AT} order by s.ordinal`, [src.id, revision]);
    const texts: string[] = [], warnings = new Set<string>();
    let engine: EngineInfo | null = null;
    const chars = segs.reduce((a, s) => a + (s.text as string).length, 0);
    let reservation: string | null = null;
    if (!adapter.local && ports.budget !== undefined) reservation = (await ports.budget.reserve(portCtx(ctx), { category: 'processing.translation', amount: chars, unit: 'characters', subject: repRef(src.id as string, revision), idempotencyKey: `e06:mt:${step.id}` })).reservationId;
    try {
      await runner.workdir(async (cwd) => {
        for (let i = 0; i < segs.length;) {
          let j = i, size = 0;
          while (j < segs.length && j - i < 60 && size < 12_000) { size += (segs[j]?.text as string).length; j++; }
          const r = await adapter.translate({ source, target, texts: segs.slice(i, j).map((s) => s.text as string), cwd, signal });
          invariant(r.texts.length === j - i, 'provider_invalid_response', 'Translation does not match the source segments');
          texts.push(...r.texts); engine = r.engine; r.warnings.forEach((w) => warnings.add(w));
          i = j;
        }
      });
    } catch (error) { if (reservation !== null) await ports.budget?.release(portCtx(ctx), reservation, 'translation failed'); throw error; }
    if (reservation !== null) await ports.budget?.commit(portCtx(ctx), reservation, { amount: chars });
    const info = engine ?? { id: adapter.id, version: 'unknown', model: null, local: adapter.local };
    const sourceRef = repRef(src.id as string, revision);
    out.representation = {
      kind: 'translation', language: target, languageConfidence: null, languageMethod: 'requested', machine: true, engine: { ...info, sourceLanguage: source, targetLanguage: target } as unknown as Json, sourceRef,
      label: `Machine translation ${source}→${target} (${info.local ? 'local' : 'external'} ${info.id} ${info.version})`,
      quality: { machineTranslation: true, reviewed: false, warnings: [...warnings], note: 'Unreviewed machine translation of the linked source revision. It does not replace the source text.' }, pages: [],
      segments: segs.map((s, i) => ({ kind: s.kind as SegmentDraft['kind'], source: 'translation', text: texts[i] as string, ...(s.page === null ? {} : { page: s.page as number }), ...(s.bbox === null ? {} : { bbox: s.bbox as [number, number, number, number] }), ...(s.start_ms === null ? {} : { startMs: s.start_ms as number, endMs: s.end_ms as number }), ...(s.anchor === null ? {} : { anchor: s.anchor as Record<string, number | string | null> }), speaker: s.speaker as string | null, sourceSegmentId: s.id as string, confidence: null })),
      extraSources: [sourceRef],
    };
    out.detail = { engine: info.id, local: info.local, source, target, sourceRef, segments: segs.length };
    return out;
  };
  const executors: Record<string, Exec> = { metadata: execMetadata, extract: execExtract, diarize: execDiarize, transcribe: execTranscribe, thumbnails: execThumbnails, translate: execTranslate };

  // ───────────────────────────── Pipeline orchestration ─────────────────────────────
  async function toolFor(name: string, family: Family, sniffed: Sniffed | null): Promise<{ tool: string; version: string }> {
    const v = async (...names: string[]): Promise<string> => (await Promise.all(names.map((n) => runner.version(n)))).map((x) => x ?? 'missing').join('+');
    if (name === 'metadata') return family === 'media' ? { tool: 'exiftool+ffprobe', version: await v('exiftool', 'ffprobe') } : family === 'pdf' ? { tool: 'exiftool+pdfinfo', version: await v('exiftool', 'pdfinfo') } : { tool: 'exiftool', version: await v('exiftool') };
    if (name === 'extract') {
      if (family === 'pdf') return { tool: 'pdftotext+pdftoppm+tesseract', version: await v('pdftotext', 'pdftoppm', 'tesseract') };
      if (family === 'image') return { tool: 'convert+tesseract', version: await v('convert', 'tesseract') };
      if (sniffed?.reader === 'pandoc') return { tool: 'pandoc', version: await v('pandoc') };
      if (sniffed?.reader === 'libreoffice') return { tool: 'soffice+pdftotext', version: await v('soffice', 'pdftotext') };
      if (family === 'captions') return { tool: 'webvtt-literal-v1+ffprobe', version: `1+${await v('ffprobe')}` };
      return { tool: sniffed?.reader === 'eml' ? 'eml-reader' : 'plain-text', version: manifest.version };
    }
    if (name === 'diarize') return { tool: 'ffmpeg+diarize.py', version: `${await v('ffmpeg')}+1.0.0` };
    if (name === 'transcribe') { const infos = await Promise.all(asrLocal.map((a) => a.describe())); return { tool: `ffmpeg+asr`, version: `${await v('ffmpeg')}+${infos.map((i) => `${i.id}:${i.available ? i.version : 'missing'}`).join(',') || 'none'}` }; }
    if (name === 'thumbnails') return family === 'media' ? { tool: 'ffmpeg', version: await v('ffmpeg') } : family === 'image' ? { tool: 'convert', version: await v('convert') } : { tool: 'pdftoppm', version: await v('pdftoppm') };
    const infos = await Promise.all(mtLocal.map((a) => a.describe()));
    return { tool: 'translation', version: infos.map((i) => `${i.id}:${i.available ? i.version : 'missing'}`).join(',') || 'none' };
  }
  const stepKind = (name: string): string => name.startsWith('translate:') ? 'translate' : name;
  function planSteps(family: Family, options: R): string[] {
    const base = family === 'pdf' || family === 'image' ? ['metadata', 'extract', 'thumbnails'] : family === 'office' ? ['metadata', 'extract', 'thumbnails'] : family === 'media' ? ['metadata', 'diarize', 'transcribe', 'thumbnails'] : family === 'captions' ? ['extract'] : ['metadata', 'extract'];
    const only = options.steps as string[] | undefined;
    const chosen = only === undefined ? base : base.filter((s) => only.includes(s));
    return [...chosen, ...((options.translateTo as string[] | undefined) ?? []).map((l) => `translate:${l}`)];
  }
  async function addStep(tx: Sql, ctx: ServiceContext, proc: ProcRow, ordinal: number, name: string, params: R, sniffed: Sniffed | null): Promise<StepRow> {
    const t = await toolFor(stepKind(name), (proc.family ?? sniffed?.family ?? 'unknown') as Family, sniffed);
    const id = randomUUID();
    const rows = await tx.query<StepRow>(`insert into ${S}.step (id, tenant_id, project_id, processing_id, ordinal, name, tool, tool_version, params, params_digest, state)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'queued') on conflict (processing_id, name, tool_version, params_digest) do nothing returning *`, [id, ctx.tenantId, ctx.projectId, proc.id, ordinal, name, t.tool, t.version, J(params), dig(params)]);
    return rows[0] ?? (await tx.query<StepRow>(`select * from ${S}.step where processing_id=$1 and name=$2 and tool_version=$3 and params_digest=$4`, [proc.id, name, t.version, dig(params)]))[0] as StepRow;
  }
  async function enqueueStep(tx: Sql, ctx: ServiceContext, step: StepRow): Promise<Job> {
    const job = await kit.enqueueJob(tx, S, ctx, { kind: 'processing.step', payload: { processingId: step.processing_id, stepId: step.id }, dedupeKey: step.id, maxAttempts: config.maxAttempts ?? 4 });
    await tx.query(`update ${S}.step set job_id=$2 where id=$1`, [step.id, job.id]);
    return job;
  }
  /** Enqueues the next queued step, or settles the processing record when none remain. Runs inside the caller's transaction. */
  async function advance(tx: Sql, ctx: ServiceContext, proc: ProcRow): Promise<void> {
    const steps = await tx.query<StepRow>(`select * from ${S}.step where processing_id=$1 order by ordinal`, [proc.id]);
    if (steps.some((s) => s.state === 'running' || (s.state === 'queued' && s.job_id !== null))) return;
    const next = steps.find((s) => s.state === 'queued');
    if (next !== undefined) { await enqueueStep(tx, ctx, next); return; }
    if (proc.state !== 'running' && proc.state !== 'queued') return;
    const primary = steps.filter((s) => s.name === 'extract' || s.name === 'transcribe');
    const state = primary.length > 0 && primary.every((s) => s.state !== 'done') ? 'failed' : steps.every((s) => s.state === 'done') ? 'done' : 'partial';
    const failure = state === 'failed' ? primary.map((s) => `${s.name}: ${s.state}${s.error === null ? '' : ` (${s.error})`}`).join('; ').slice(0, 1000) : null;
    await tx.query(`update ${S}.processing set state=$2, failure=$3, updated_at=$4 where id=$1`, [proc.id, state, failure, ctx.now]);
    const reps = await tx.query<{ id: string; current_revision: number; kind: string }>(`select id, current_revision, kind from ${S}.representation where processing_id=$1 order by created_at`, [proc.id]);
    if (state !== 'failed') {
      // Earlier generations of the same evidence version and options are superseded, never deleted.
      const older = await tx.query<{ id: string }>(`update ${S}.representation r set state='superseded', stale=true, reasons = r.reasons || $5::jsonb from ${S}.processing p
        where p.id=r.processing_id and p.tenant_id=$1 and p.project_id=$2 and p.evidence_ref=$3 and p.options_digest=$4 and p.generation < $6 and r.state='current' returning r.id`, [ctx.tenantId, ctx.projectId, proc.evidence_ref, proc.options_digest, J([`superseded by reprocessing ${procRef(proc.id)}`]), proc.generation]);
      for (const o of older) await kit.emitEvent(tx, S, ctx, 'processing.stale', repRef(o.id), { reason: 'superseded by reprocessing', cause: procRef(proc.id) });
    }
    const payload = { evidenceRef: proc.evidence_ref, state, representations: reps.map((r) => repRef(r.id, r.current_revision)), steps: Object.fromEntries(steps.map((s) => [s.name, s.state])), ...(failure === null ? {} : { failure }) };
    await kit.emitEvent(tx, S, ctx, state === 'failed' ? 'processing.failed' : 'processing.completed', procRef(proc.id), payload);
    await kit.appendAudit(tx, S, ctx, state === 'failed' ? 'processing.failed' : 'processing.completed', procRef(proc.id), payload);
  }
  async function blockProcessing(tx: Sql, ctx: ServiceContext, procId: string, reason: string, cause: string): Promise<string[]> {
    const affected: string[] = [];
    const p = (await tx.query<ProcRow>(`update ${S}.processing set blocked=true, reasons = reasons || $2::jsonb, updated_at=$3 where id=$1 returning *`, [procId, J([reason]), ctx.now]))[0];
    if (p === undefined) return affected;
    affected.push(procRef(p.id));
    for (const s of await tx.query<StepRow>(`update ${S}.step set state='cancelled', error='blocked', finished_at=$2 where processing_id=$1 and state in ('queued','running') returning *`, [procId, ctx.now])) if (s.job_id !== null) await tx.query(`update ${S}._jobs set state='cancelled', lease_owner=null, lease_until=null, updated_at=now() where id=$1 and state in ('queued','leased','paused','failed')`, [s.job_id]);
    await tx.query(`update ${S}._jobs set state='cancelled', lease_owner=null, lease_until=null, updated_at=now() where kind='processing.plan' and payload->>'processingId'=$1 and state in ('queued','leased','paused','failed')`, [procId]);
    if (p.state === 'queued' || p.state === 'running') await tx.query(`update ${S}.processing set state='cancelled' where id=$1`, [procId]);
    for (const r of await tx.query<{ id: string }>(`update ${S}.representation set blocked=true, reasons = reasons || $2::jsonb where processing_id=$1 returning id`, [procId, J([reason])])) affected.push(repRef(r.id));
    for (const d of await tx.query<{ id: string }>(`update ${S}.derivative set blocked=true, reasons = reasons || $2::jsonb where processing_id=$1 returning id`, [procId, J([reason])])) affected.push(derRef(d.id));
    for (const ref of affected) await kit.emitEvent(tx, S, ctx, 'processing.blocked', ref, { reason, cause });
    await kit.appendAudit(tx, S, ctx, 'processing.blocked', procRef(procId), { reason, cause, affected: affected.length });
    return affected;
  }

  async function fetchBytes(ctx: ServiceContext, proc: ProcRow): Promise<Uint8Array> {
    const bytes = await evidence().getBytes(portCtx(ctx), proc.evidence_ref);
    invariant(bytes.byteLength <= limits.maxInputBytes, 'tool_failed', 'Input exceeds the processing size limit');
    if (sha(bytes) !== proc.sha256) throw new DomainError('integrity_failure', 'Evidence bytes do not match the recorded digest');
    return bytes;
  }
  const jobCtx = (job: Job): ServiceContext => ({ ...job.ctx, now: new Date().toISOString() });
  const systemLoad = async (id: string, job: Job): Promise<ProcRow | undefined> => (await sql.query<ProcRow>(`select * from ${S}.processing where id=$1 and tenant_id=$2 and project_id=$3`, [id, job.tenantId, job.projectId]))[0];

  async function handlePlan(job: Job): Promise<Json> {
    const ctx = jobCtx(job);
    const proc = await systemLoad((job.payload as R).processingId as string, job);
    if (proc === undefined || proc.state !== 'queued' || proc.blocked) return { skipped: true };
    const fail = (failure: string): Promise<Json> => sql.tx(async (tx) => {
      await tx.query(`update ${S}.processing set state='failed', failure=$2, updated_at=$3 where id=$1 and state='queued'`, [proc.id, failure.slice(0, 1000), ctx.now]);
      await kit.emitEvent(tx, S, ctx, 'processing.failed', procRef(proc.id), { evidenceRef: proc.evidence_ref, state: 'failed', failure: failure.slice(0, 300) });
      await kit.appendAudit(tx, S, ctx, 'processing.failed', procRef(proc.id), { failure: failure.slice(0, 300) });
      return { state: 'failed', failure };
    });
    try { await gate(ctx, proc); } catch (error) {
      if (error instanceof DomainError && ['consent_denied', 'forbidden'].includes(error.code)) { await sql.tx((tx) => blockProcessing(tx, ctx, proc.id, error.message, 'gate')); return { state: 'blocked' }; }
      throw error;
    }
    let bytes: Uint8Array;
    try {
      const info = await evidence().describe(portCtx(ctx), proc.evidence_ref);
      if (info === null) return fail('The evidence version is no longer visible');
      if (!info.available) throw new Error('evidence version is not released yet');
      bytes = await fetchBytes(ctx, proc);
    } catch (error) {
      if (error instanceof DomainError && ['integrity_failure', 'tool_failed'].includes(error.code)) return fail(error.message);
      if (job.attempts >= job.maxAttempts) return fail(`Evidence bytes could not be read: ${error instanceof Error ? error.message : 'error'}`);
      throw error instanceof DomainError ? new Error(`${error.code}: ${error.message}`) : error;
    }
    const sniffed = tools.sniff(bytes);
    if (sniffed.family === 'unknown') {
      await sql.query(`update ${S}.processing set media_type=$2, family='unknown' where id=$1`, [proc.id, sniffed.mediaType]);
      return fail(`unsupported_media_type: no pipeline for content detected as ${sniffed.mediaType}`);
    }
    return sql.tx(async (tx) => {
      const locked = (await tx.query<ProcRow>(`select * from ${S}.processing where id=$1 for update`, [proc.id]))[0] as ProcRow;
      if (locked.state !== 'queued' || locked.blocked) return { skipped: true };
      const p = { ...locked, family: sniffed.family, media_type: sniffed.mediaType, state: 'running' as const };
      await tx.query(`update ${S}.processing set media_type=$2, family=$3, state='running', updated_at=$4 where id=$1`, [proc.id, sniffed.mediaType, sniffed.family, ctx.now]);
      const names = planSteps(sniffed.family, proc.options);
      for (const [i, name] of names.entries()) await addStep(tx, ctx, p, i + 1, name, name.startsWith('translate:') ? { target: name.slice(10), ...(proc.options.translationProvider === undefined ? {} : { provider: proc.options.translationProvider }) } : { languages: proc.options.languages ?? null, ...(name === 'transcribe' && proc.options.asrProvider !== undefined ? { provider: proc.options.asrProvider } : {}), ...(name === 'extract' && proc.options.captionsFor !== undefined ? { captionsFor: proc.options.captionsFor } : {}) }, sniffed);
      await advance(tx, ctx, p);
      return { mediaType: sniffed.mediaType, family: sniffed.family, steps: names };
    });
  }

  async function handleStep(job: Job): Promise<Json> {
    const ctx = jobCtx(job);
    const payload = job.payload as { processingId: string; stepId: string };
    const proc = await systemLoad(payload.processingId, job);
    const step = (await sql.query<StepRow>(`select * from ${S}.step where id=$1 and processing_id=$2`, [payload.stepId, payload.processingId]))[0];
    if (proc === undefined || step === undefined) return { skipped: true };
    if (['done', 'failed', 'unavailable', 'denied', 'cancelled'].includes(step.state)) { await sql.tx((tx) => advance(tx, ctx, proc)); return { state: step.state, replay: true }; }
    const settle = (state: string, error: string | null, extra?: (tx: Sql, p: ProcRow) => Promise<void>): Promise<Json> => sql.tx(async (tx) => {
      const p = (await tx.query<ProcRow>(`select * from ${S}.processing where id=$1 for update`, [proc.id]))[0] as ProcRow;
      const updated = await tx.query(`update ${S}.step set state=$2, error=$3, finished_at=$4 where id=$1 and state in ('queued','running') returning id`, [step.id, state, error === null ? null : error.slice(0, 1000), ctx.now]);
      if (updated.length === 0) return { state: 'unchanged' };
      if (extra !== undefined) await extra(tx, p);
      await kit.appendAudit(tx, S, ctx, `processing.step_${state}`, procRef(proc.id), { step: step.name, tool: step.tool, toolVersion: step.tool_version, ...(error === null ? {} : { error: error.slice(0, 300) }) });
      if (!p.blocked && p.state !== 'cancelled') await advance(tx, ctx, p);
      return { state, ...(error === null ? {} : { error }) };
    });
    if (proc.blocked || proc.state === 'cancelled') return settle('cancelled', proc.blocked ? 'blocked' : 'cancelled');
    try { await gate(ctx, proc); } catch (error) {
      if (error instanceof DomainError && ['consent_denied', 'forbidden'].includes(error.code)) { await sql.tx((tx) => blockProcessing(tx, ctx, proc.id, error.message, 'gate')); return { state: 'blocked' }; }
      throw error;
    }
    await sql.query(`update ${S}.step set state='running', started_at=coalesce(started_at, $2) where id=$1 and state='queued'`, [step.id, ctx.now]);
    const abort = new AbortController();
    // A cancelled, paused or blocked job stops the running tool instead of letting it finish unobserved.
    const watch = setInterval(() => { void (async () => {
      try {
        const j = await kit.getJob(sql, S, job, job.id);
        if (j === null || j.state !== 'leased' || j.generation !== job.generation) abort.abort(); else await kit.heartbeatJob(sql, S, job, config.jobLeaseMs ?? 120_000);
      } catch { /* lease lost is detected on the next tick or at settlement */ }
    })(); }, 2000);
    let output: StepOutput, stored: StoredDeriv[];
    try {
      const needsBytes = stepKind(step.name) !== 'translate';
      const bytes = needsBytes ? await fetchBytes(ctx, proc) : new Uint8Array();
      const sniffed = needsBytes ? tools.sniff(bytes) : { mediaType: proc.media_type ?? '', family: proc.family ?? 'unknown', ext: 'bin' } as Sniffed;
      output = await (executors[stepKind(step.name)] as Exec)(ctx, proc, step, bytes, sniffed, abort.signal);
      stored = [];
      for (const d of output.derivatives) stored.push(await storeDerivative(ctx, proc, d));
    } catch (error) {
      clearInterval(watch);
      if (error instanceof DomainError) {
        if (error.code === 'process_aborted') throw new DomainError('lease_lost', 'Job was cancelled or paused');
        if (error.code === 'unavailable') return settle('unavailable', error.message);
        if (error.code === 'policy_denied') return settle('denied', error.message);
        if (['tool_failed', 'process_timeout', 'process_output_limit', 'unsupported_media_type', 'integrity_failure', 'provider_invalid_response', 'provider_rejected', 'budget_exhausted', 'consent_denied', 'payload_too_large', 'invalid_input'].includes(error.code)) return settle('failed', `${error.code}: ${error.message}`);
      }
      if (job.attempts >= job.maxAttempts) return settle('failed', error instanceof Error ? error.message : 'error');
      throw error instanceof DomainError ? new Error(`${error.code}: ${error.message}`) : error;
    } finally { clearInterval(watch); }
    return settle('done', null, async (tx, p) => {
      if (p.blocked || p.state === 'cancelled') throw new DomainError('lease_lost', 'Processing was blocked or cancelled while the step ran');
      const toolVersion = step.tool_version;
      for (const o of output.observations) await tx.query(`insert into ${S}.observation (id, tenant_id, project_id, processing_id, step_id, kind, page, data, tool, tool_version, caveat, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`, [randomUUID(), ctx.tenantId, ctx.projectId, proc.id, step.id, o.kind, o.page ?? null, J(o.data), o.tool, o.toolVersion === 'see step' ? toolVersion : o.toolVersion, o.caveat ?? null, ctx.now]);
      for (const t of output.turns ?? []) await tx.query(`insert into ${S}.speaker_turn (id, tenant_id, project_id, processing_id, label, start_ms, end_ms, confidence) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), ctx.tenantId, ctx.projectId, proc.id, t.speaker, t.startMs, t.endMs, t.confidence]);
      let rep: { id: string; revision: number } | undefined;
      if (output.representation !== undefined) {
        const made = await insertRepresentation(tx, ctx, p, step.id, output.representation);
        rep = { id: made.id, revision: 1 };
        if (output.representation.kind === 'translation') await kit.emitEvent(tx, S, ctx, 'translation.completed', repRef(made.id, 1), { evidenceRef: proc.evidence_ref, sourceRef: output.representation.sourceRef, language: output.representation.language, machineTranslation: true, engine: output.representation.engine });
      }
      for (const d of stored) await insertDerivative(tx, ctx, p, step.id, d, d.kind === 'searchable_pdf' ? rep : undefined);
      await tx.query(`update ${S}.step set detail=$2::jsonb where id=$1`, [step.id, J({ ...(output.detail as R), ...(rep === undefined ? {} : { representation: repRef(rep.id, 1) }) })]);
      if (output.lowQuality.length > 0) await kit.emitEvent(tx, S, ctx, 'processing.low_quality', rep === undefined ? procRef(proc.id) : repRef(rep.id, 1), { evidenceRef: proc.evidence_ref, step: step.name, reasons: output.lowQuality.slice(0, 50) });
    });
  }
  const handlers: Record<string, kit.JobHandler> = { 'processing.plan': handlePlan, 'processing.step': handleStep };

  // ───────────────────────────── Service ─────────────────────────────
  async function createProcessing(tx: Sql, ctx: ServiceContext, info: kit.EvidenceVersionInfo, options: R, force: boolean, cause: string | null): Promise<{ proc: ProcRow; created: boolean }> {
    const digest = dig(options);
    const prior = (await tx.query<ProcRow>(`select * from ${S}.processing where tenant_id=$1 and project_id=$2 and evidence_ref=$3 and options_digest=$4 order by generation desc limit 1 for update`, [ctx.tenantId, ctx.projectId, info.ref, digest]))[0];
    if (prior !== undefined && !force && !prior.blocked) return { proc: prior, created: false };
    const sources = [info.ref];
    try { sources.push(kit.uref('E05', 'evidence', info.evidenceId)); } catch { /* evidence id is not expressible as a reference */ }
    const id = randomUUID();
    const proc = (await tx.query<ProcRow>(`insert into ${S}.processing (id, tenant_id, project_id, evidence_ref, evidence_id, evidence_revision, sha256, declared_media_type, filename, compartment, sources, options, options_digest, generation, state, cause, requested_by, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,'queued',$15,$16,$17,$17) returning *`,
      [id, ctx.tenantId, ctx.projectId, info.ref, info.evidenceId, info.revision, info.sha256, info.mediaType, info.filename.slice(0, 500), info.compartment, J(sources), J(options), digest, (prior?.generation ?? 0) + 1, cause, ctx.actor.id, ctx.now]))[0] as ProcRow;
    await kit.enqueueJob(tx, S, ctx, { kind: 'processing.plan', payload: { processingId: id }, dedupeKey: id, maxAttempts: 6 });
    await kit.emitEvent(tx, S, ctx, 'processing.requested', procRef(id), { evidenceRef: info.ref, generation: proc.generation, ...(cause === null ? {} : { cause }) });
    await kit.appendAudit(tx, S, ctx, 'processing.requested', procRef(id), { evidenceRef: info.ref, options: options as Json, generation: proc.generation, ...(cause === null ? {} : { cause }) });
    return { proc, created: true };
  }
  function normalizeOptions(input: RequestProcessingInput): R {
    const o: R = {};
    if (input.languages !== undefined) { const l = strings(input.languages, 'languages', 6); invariant(l.every((x) => x === 'auto' || LANG.test(x)), 'invalid_input', 'languages must be ISO 639-3 codes or "auto"'); if (l.length > 0) o.languages = l; }
    if (input.steps !== undefined) { const s = strings(input.steps, 'steps', 8); invariant(s.every((x) => ['metadata', 'extract', 'diarize', 'transcribe', 'thumbnails'].includes(x)), 'invalid_input', 'Unknown step name'); o.steps = s.sort(); }
    if (input.translateTo !== undefined) { const t = strings(input.translateTo, 'translateTo', 6); invariant(t.every((x) => LANG.test(x)), 'invalid_input', 'translateTo must be ISO 639-3 codes'); if (t.length > 0) o.translateTo = t; }
    for (const k of ['asrProvider', 'translationProvider'] as const) if (input[k] !== undefined) { invariant(typeof input[k] === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(input[k] as string), 'invalid_input', `${k} must be a configured provider id`); o[k] = input[k]; }
    if (input.captionsFor !== undefined) { kit.parseUref(input.captionsFor); o.captionsFor = input.captionsFor; }
    return o;
  }
  async function ownedProc(q: Sql, ctx: ServiceContext, processingId: string): Promise<ProcRow> { return loadProc(q, ctx, processingId); }

  const engine: ProcessingEngine = {
    manifest,
    async getPolicy(ctx) { kit.requireCapability(ctx, 'processing:read'); return policyOf(sql, ctx); },
    async setPolicy(ctx, input) {
      kit.requireCapability(ctx, 'processing:admin');
      invariant(input !== null && typeof input === 'object' && (input.externalTransmission === 'forbidden' || input.externalTransmission === 'allowed'), 'invalid_input', 'externalTransmission must be forbidden or allowed');
      const providers = strings(input.allowedProviders ?? [], 'allowedProviders', 20), languages = strings(input.languages ?? [], 'languages', 10);
      invariant(languages.every((l) => l === 'auto' || LANG.test(l)), 'invalid_input', 'languages must be ISO 639-3 codes or "auto"');
      return sql.tx((tx) => kit.idempotent(tx, S, ctx, input.idempotencyKey, { op: 'setPolicy', e: input.externalTransmission, providers, languages }, async () => {
        const r = (await tx.query<{ revision: number }>(`insert into ${S}.policy (tenant_id, project_id, revision, external_transmission, allowed_providers, languages, updated_at, updated_by) values ($1,$2,1,$3,$4::jsonb,$5::jsonb,$6,$7)
          on conflict (tenant_id, project_id) do update set revision=${S}.policy.revision+1, external_transmission=excluded.external_transmission, allowed_providers=excluded.allowed_providers, languages=excluded.languages, updated_at=excluded.updated_at, updated_by=excluded.updated_by returning revision`,
          [ctx.tenantId, ctx.projectId, input.externalTransmission, J(providers), J(languages), ctx.now, ctx.actor.id]))[0] as { revision: number };
        const policy: ProcessingPolicy = { externalTransmission: input.externalTransmission, allowedProviders: providers, languages, revision: r.revision };
        const subject = kit.uref(E, 'policy', 'project');
        await kit.appendAudit(tx, S, ctx, 'processing.policy_changed', subject, policy as unknown as Json);
        await kit.emitEvent(tx, S, ctx, 'processing.policy_changed', subject, { revision: r.revision, externalTransmission: input.externalTransmission });
        return policy as unknown as Json;
      })) as unknown as Promise<ProcessingPolicy>;
    },
    async describeTools(ctx) {
      kit.requireCapability(ctx, 'processing:read');
      const names = ['pdftotext', 'pdftoppm', 'pdfinfo', 'pdfunite', 'tesseract', 'convert', 'pandoc', 'soffice', 'ffmpeg', 'ffprobe', 'exiftool', 'apertium'];
      const versions = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await runner.version(n)] as const)));
      const python = await tools.which(config.python ?? 'python3');
      return {
        tools: versions, ocrLanguages: await tools.tesseractLanguages(runner),
        asr: [...await Promise.all(asrLocal.map((a) => a.describe())), ...await Promise.all([...asrExternal.values()].map((a) => a.describe()))],
        translation: [...await Promise.all(mtLocal.map((a) => a.describe())), ...await Promise.all([...mtExternal.values()].map((a) => a.describe()))],
        diarization: { id: 'diarize.py', local: true, available: python !== null, version: '1.0.0', ...(python === null ? { missing: config.python ?? 'python3' } : {}), verified: 'runs locally; exercised by the test-suite against two synthesised voices' },
      };
    },
    async requestProcessing(ctx, input) {
      kit.requireCapability(ctx, 'processing:write');
      invariant(input !== null && typeof input === 'object', 'invalid_input', 'Request body required');
      nonempty(input.evidenceRef, 'evidenceRef', 300);
      const parsed = kit.parseUref(input.evidenceRef);
      invariant(parsed.engine === 'E05', 'invalid_input', 'evidenceRef must name an evidence version');
      const options = normalizeOptions(input);
      const info = await evidence().describe(portCtx(ctx), input.evidenceRef);
      if (info === null) throw notFound();
      kit.requireCompartment(ctx, info.compartment);
      invariant(info.size <= limits.maxInputBytes, 'payload_too_large', 'Evidence version exceeds the processing size limit');
      await gate(ctx, { id: '', evidence_ref: info.ref, sources: [info.ref] });
      const out = await sql.tx((tx) => kit.idempotent(tx, S, ctx, input.idempotencyKey, { op: 'requestProcessing', ref: info.ref, options, force: input.force === true }, async () => (await createProcessing(tx, ctx, info, options, input.force === true, null)).proc.id));
      return procView(sql, await loadProc(sql, ctx, out));
    },
    async getProcessing(ctx, id) { kit.requireCapability(ctx, 'processing:read'); return procView(sql, await loadProc(sql, ctx, id)); },
    async listProcessing(ctx, options = {}) {
      kit.requireCapability(ctx, 'processing:read');
      const rows = await sql.query<ProcRow>(`select * from ${S}.processing where ${VIS} and ($4::text is null or evidence_ref=$4) and ($5::text is null or state=$5) order by created_at desc, id limit ${Math.min(Math.max(options.limit ?? 50, 1), 200)}`, [ctx.tenantId, ctx.projectId, cmp(ctx), options.evidenceRef ?? null, options.state ?? null]);
      return Promise.all(rows.map((p) => procView(sql, p)));
    },
    async cancelProcessing(ctx, id, input = {}) {
      kit.requireCapability(ctx, 'processing:write');
      await sql.tx(async (tx) => {
        const p = await loadProc(tx, ctx, id, true);
        if (p.state !== 'queued' && p.state !== 'running') throw new DomainError('invalid_state', `Processing in state ${p.state} cannot be cancelled`);
        await tx.query(`update ${S}.processing set state='cancelled', updated_at=$2 where id=$1`, [p.id, ctx.now]);
        await tx.query(`update ${S}.step set state='cancelled', error='cancelled', finished_at=$2 where processing_id=$1 and state in ('queued','running')`, [p.id, ctx.now]);
        await tx.query(`update ${S}._jobs set state='cancelled', lease_owner=null, lease_until=null, updated_at=now() where tenant_id=$1 and project_id=$2 and payload->>'processingId'=$3 and state in ('queued','leased','paused','failed')`, [ctx.tenantId, ctx.projectId, p.id]);
        await kit.emitEvent(tx, S, ctx, 'processing.cancelled', procRef(p.id), { evidenceRef: p.evidence_ref, reason: String(input.reason ?? '').slice(0, 300) });
        await kit.appendAudit(tx, S, ctx, 'processing.cancelled', procRef(p.id), { reason: String(input.reason ?? '').slice(0, 300) });
      });
      return procView(sql, await loadProc(sql, ctx, id));
    },
    async retryProcessing(ctx, id) {
      kit.requireCapability(ctx, 'processing:write');
      await sql.tx(async (tx) => {
        const p = await loadProc(tx, ctx, id, true);
        if (p.blocked) throw new DomainError('consent_denied', 'Processing is blocked');
        invariant(['failed', 'partial', 'cancelled'].includes(p.state), 'invalid_state', `Processing in state ${p.state} cannot be retried`);
        await gate(ctx, p);
        const steps = await tx.query<StepRow>(`update ${S}.step set state='queued', error=null, job_id=null, finished_at=null where processing_id=$1 and state in ('failed','unavailable','denied','cancelled') returning *`, [p.id]);
        await tx.query(`delete from ${S}._jobs where id = any($1::uuid[]) and state in ('done','dead','cancelled','failed')`, [steps.map((s) => s.job_id).filter((j) => j !== null)]);
        const hadPlan = (await tx.query(`select 1 from ${S}.step where processing_id=$1 limit 1`, [p.id])).length > 0;
        await tx.query(`update ${S}.processing set state=$2, failure=null, updated_at=$3 where id=$1`, [p.id, hadPlan ? 'running' : 'queued', ctx.now]);
        if (hadPlan) await advance(tx, ctx, { ...p, state: 'running' });
        else { await tx.query(`delete from ${S}._jobs where kind='processing.plan' and dedupe_key=$1 and state in ('done','dead','cancelled','failed')`, [p.id]); await kit.enqueueJob(tx, S, ctx, { kind: 'processing.plan', payload: { processingId: p.id }, dedupeKey: p.id, maxAttempts: 6 }); }
        await kit.appendAudit(tx, S, ctx, 'processing.retried', procRef(p.id), { steps: steps.map((s) => s.name) });
      });
      return procView(sql, await loadProc(sql, ctx, id));
    },
    async getAlignment(ctx, processingId) {
      kit.requireCapability(ctx, 'processing:read');
      const p = await loadProc(sql, ctx, processingId);
      if (p.blocked) throw new DomainError('consent_denied', 'Processing outputs are blocked');
      const reps = await sql.query<R>(`select * from ${S}.representation where processing_id=$1 and not blocked order by created_at, id`, [p.id]);
      return { processing: await procView(sql, p), representations: await Promise.all(reps.map((r) => repView(sql, ctx, r as never, r.current_revision as number))), speakers: await engine.listSpeakers(ctx, processingId) };
    },
    async getRepresentation(ctx, ref, options = {}) {
      kit.requireCapability(ctx, 'processing:read');
      const r = await loadRep(sql, ctx, ref);
      const revision = options.revision ?? r.requested ?? r.current_revision;
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > r.current_revision) throw notFound();
      return repView(sql, ctx, r, revision);
    },
    async listRevisions(ctx, ref) {
      kit.requireCapability(ctx, 'processing:read');
      const r = await loadRep(sql, ctx, ref);
      return (await sql.query<R>(`select * from ${S}.representation_revision where representation_id=$1 order by revision`, [r.id])).map((v) => ({ ref: repRef(r.id, v.revision as number), revision: v.revision as number, at: iso(v.at), actorId: v.actor_id as string, actorKind: v.actor_kind as string, reason: v.reason as string, segmentIds: v.segment_ids as string[], textSha256: v.text_sha256 as string }));
    },
    async locate(ctx, ref, point) {
      kit.requireCapability(ctx, 'processing:read');
      const r = await loadRep(sql, ctx, ref);
      if (r.blocked) throw new DomainError('consent_denied', 'This representation is blocked');
      const revision = r.requested ?? r.current_revision;
      let rows: R[];
      if ('ms' in point) {
        invariant(Number.isFinite(point.ms) && point.ms >= 0, 'invalid_input', 'ms must be a non-negative number');
        rows = await sql.query<R>(`${SEG_AT} and s.start_ms <= $3 and s.end_ms > $3 order by s.ordinal limit 1`, [r.id, revision, Math.floor(point.ms)]);
      } else {
        invariant(Number.isSafeInteger(point.page) && Number.isFinite(point.x) && Number.isFinite(point.y), 'invalid_input', 'page, x and y are required');
        rows = await sql.query<R>(`${SEG_AT} and s.page=$3 and (s.bbox->>0)::float <= $4 and (s.bbox->>2)::float >= $4 and (s.bbox->>1)::float <= $5 and (s.bbox->>3)::float >= $5 order by ((s.bbox->>2)::float-(s.bbox->>0)::float)*((s.bbox->>3)::float-(s.bbox->>1)::float) limit 1`, [r.id, revision, point.page, point.x, point.y]);
      }
      if (rows[0] === undefined) return null;
      const segment = segView(rows[0], await speakerLabels(sql, ctx, r.processing_id), true);
      const word = (segment.words ?? []).find((w) => 'ms' in point ? (w.s !== undefined && w.e !== undefined && w.s <= point.ms && w.e > point.ms) : (w.b !== undefined && w.b[0] <= point.x && w.b[2] >= point.x && w.b[1] <= point.y && w.b[3] >= point.y)) ?? null;
      return { representationRef: repRef(r.id, revision), evidenceRef: r.evidence_ref, segment, word };
    },
    async correctText(ctx, input) {
      kit.requireCapability(ctx, 'processing:write');
      invariant(input !== null && typeof input === 'object' && Array.isArray(input.corrections) && input.corrections.length > 0 && input.corrections.length <= 500, 'invalid_input', 'Between 1 and 500 corrections are required');
      nonempty(input.reason, 'reason', 1000);
      for (const c of input.corrections) { invariant(c !== null && typeof c === 'object' && typeof c.segmentId === 'string' && UUID.test(c.segmentId) && typeof c.text === 'string' && c.text.length <= 20000 && !c.text.includes('\u0000'), 'invalid_input', 'Each correction needs a segmentId and text'); }
      invariant(new Set(input.corrections.map((c) => c.segmentId)).size === input.corrections.length, 'invalid_input', 'A segment may be corrected once per revision');
      return sql.tx((tx) => kit.idempotent(tx, S, ctx, input.idempotencyKey, { op: 'correctText', r: input.representation, c: input.corrections, reason: input.reason, e: input.expectedRevision ?? null }, async () => {
        const r = await loadRep(tx, ctx, repId(input.representation).id, true);
        if (r.blocked) throw new DomainError('consent_denied', 'This representation is blocked');
        if (input.expectedRevision !== undefined && input.expectedRevision !== r.current_revision) throw new DomainError('revision_conflict', `Representation is at revision ${r.current_revision}`);
        const next = r.current_revision + 1;
        const current = await tx.query<R>(`select t.* from ${S}.segment_text t where t.representation_id=$1 and t.is_current and t.segment_id = any($2::uuid[]) for update`, [r.id, input.corrections.map((c) => c.segmentId)]);
        if (current.length !== input.corrections.length) throw new DomainError('invalid_input', 'A segment does not belong to this representation');
        const changed: string[] = [];
        for (const c of input.corrections) {
          const prior = current.find((t) => t.segment_id === c.segmentId) as R;
          if (prior.text === c.text) continue;
          // Word boxes/timestamps survive only when the correction keeps the word count; corrected words carry no machine confidence.
          const tokens = c.text.trim().split(/\s+/).filter((t) => t !== '');
          const priorWords = prior.words as Word[] | null;
          const words = priorWords !== null && priorWords.length === tokens.length ? priorWords.map((w, i) => w.t === tokens[i] ? w : { ...w, t: tokens[i] as string, c: null }) : null;
          await tx.query(`update ${S}.segment_text set is_current=false where segment_id=$1 and is_current`, [c.segmentId]);
          await tx.query(`insert into ${S}.segment_text (segment_id, revision, tenant_id, project_id, representation_id, text, words, confidence, corrected) values ($1,$2,$3,$4,$5,$6,$7::jsonb,null,true)`, [c.segmentId, next, ctx.tenantId, ctx.projectId, r.id, c.text, words === null ? null : J(words)]);
          changed.push(c.segmentId);
        }
        invariant(changed.length > 0, 'invalid_input', 'The corrections do not change any text');
        const text = (await tx.query<{ text: string }>(`select t.text from ${S}.segment_text t join ${S}.segment s on s.id=t.segment_id where t.representation_id=$1 and t.is_current order by s.ordinal`, [r.id])).map((x) => x.text).join('\n');
        await tx.query(`insert into ${S}.representation_revision (representation_id, revision, tenant_id, project_id, at, actor_id, actor_kind, reason, segment_ids, text_sha256) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [r.id, next, ctx.tenantId, ctx.projectId, ctx.now, ctx.actor.id, ctx.actor.kind, input.reason, J(changed), sha(text)]);
        await tx.query(`update ${S}.representation set current_revision=$2 where id=$1`, [r.id, next]);
        const previousRef = repRef(r.id, r.current_revision), newRef = repRef(r.id, next), reason = `source text corrected in ${newRef}`;
        const staled: string[] = [];
        for (const t of await tx.query<{ id: string; current_revision: number }>(`update ${S}.representation set stale=true, reasons = reasons || $3::jsonb where tenant_id=$1 and project_id=$2 and kind='translation' and source_ref like $4 and not stale returning id, current_revision`, [ctx.tenantId, ctx.projectId, J([reason]), `${repRef(r.id)}@%`])) staled.push(repRef(t.id, t.current_revision));
        for (const d of await tx.query<{ id: string }>(`update ${S}.derivative set stale=true, reasons = reasons || $2::jsonb where representation_id=$1 and representation_revision < $3 and not stale returning id`, [r.id, J([reason]), next])) staled.push(derRef(d.id));
        const payload = { evidenceRef: r.evidence_ref, representationRef: newRef, previousRef, revision: next, previousRevision: r.current_revision, segmentIds: changed, kind: r.kind, actorKind: ctx.actor.kind, stale: staled };
        await kit.emitEvent(tx, S, ctx, 'processing.text_corrected', newRef, payload);
        if (r.kind === 'translation') await kit.emitEvent(tx, S, ctx, 'translation.revised', newRef, payload);
        for (const ref of staled) await kit.emitEvent(tx, S, ctx, 'processing.stale', ref, { reason, cause: newRef });
        await kit.appendAudit(tx, S, ctx, 'processing.text_corrected', newRef, { previousRef, segmentIds: changed, reason: input.reason, stale: staled });
        return { representationRef: newRef, previousRef, revision: next, segmentIds: changed, staled };
      }));
    },
    async requestTranslation(ctx, input) {
      kit.requireCapability(ctx, 'processing:write');
      invariant(input !== null && typeof input === 'object' && typeof input.targetLanguage === 'string' && LANG.test(input.targetLanguage), 'invalid_input', 'targetLanguage must be an ISO 639-3 code');
      invariant(input.provider === undefined || /^[A-Za-z0-9._-]{1,64}$/.test(input.provider), 'invalid_input', 'provider must be a configured provider id');
      const r = await loadRep(sql, ctx, input.representation);
      if (r.blocked) throw new DomainError('consent_denied', 'This representation is blocked');
      invariant(r.kind !== 'translation', 'invalid_input', 'Translate the source representation, not another translation');
      const proc = await loadProc(sql, ctx, r.processing_id);
      await gate(ctx, proc);
      // An external provider is checked now so the caller hears the refusal, and again inside the worker.
      if (input.provider !== undefined && !mtLocal.some((a) => a.id === input.provider)) {
        if (!mtExternal.has(input.provider)) throw new DomainError('unavailable', `Translation provider ${input.provider} is not configured`);
        await requireExternal(ctx, proc, input.provider, 'translate');
      }
      const revision = r.requested ?? r.current_revision;
      return sql.tx((tx) => kit.idempotent(tx, S, ctx, input.idempotencyKey, { op: 'requestTranslation', r: r.id, revision, t: input.targetLanguage, p: input.provider ?? null }, async () => {
        const ordinal = Number((await tx.query<{ n: string }>(`select coalesce(max(ordinal),0)+1 as n from ${S}.step where processing_id=$1`, [proc.id]))[0]?.n);
        const step = await addStep(tx, ctx, proc, ordinal, `translate:${input.targetLanguage}`, { target: input.targetLanguage, representationId: r.id, revision, ...(input.provider === undefined ? {} : { provider: input.provider }) }, null);
        const job = step.job_id === null ? await enqueueStep(tx, ctx, step) : { id: step.job_id };
        await kit.appendAudit(tx, S, ctx, 'translation.requested', repRef(r.id, revision), { target: input.targetLanguage, provider: input.provider ?? 'local' });
        return { processingId: proc.id, stepId: step.id, jobId: job.id };
      }));
    },
    async listObservations(ctx, processingId, options = {}) {
      kit.requireCapability(ctx, 'processing:read');
      const p = await ownedProc(sql, ctx, processingId);
      if (p.blocked) throw new DomainError('consent_denied', 'Processing outputs are blocked');
      return (await sql.query<R>(`select * from ${S}.observation where processing_id=$1 and ($2::text is null or kind=$2) order by created_at, page nulls first, id`, [p.id, options.kind ?? null])).map((o) => ({ id: o.id as string, kind: o.kind as string, page: (o.page as number | null) ?? null, data: o.data as Json, tool: o.tool as string, toolVersion: o.tool_version as string, caveat: (o.caveat as string | null) ?? null }));
    },
    async listSpeakers(ctx, processingId) {
      kit.requireCapability(ctx, 'processing:read');
      const p = await ownedProc(sql, ctx, processingId);
      const turns = await sql.query<R>(`select * from ${S}.speaker_turn where processing_id=$1 order by start_ms`, [p.id]);
      return { turns: turns.map((t) => ({ label: t.label as string, startMs: t.start_ms as number, endMs: t.end_ms as number, confidence: (t.confidence as number | null) ?? null, provisional: true as const })), labels: [...(await speakerLabels(sql, ctx, p.id)).values()] };
    },
    async attributeSpeaker(ctx, input) {
      kit.requireCapability(ctx, 'processing:attribute_speaker');
      // Naming a person is a human judgement. Agents and services may propose elsewhere; they cannot record it here.
      if (ctx.actor.kind !== 'human') throw new DomainError('forbidden', 'Speaker attribution requires human review');
      invariant(input !== null && typeof input === 'object' && typeof input.label === 'string' && /^Speaker [A-Z0-9]+$/.test(input.label), 'invalid_input', 'label must be a provisional speaker label');
      nonempty(input.basis, 'basis', 2000); nonempty(input.identityRef, 'identityRef', 300); kit.parseUref(input.identityRef);
      return sql.tx((tx) => kit.idempotent(tx, S, ctx, input.idempotencyKey, { op: 'attributeSpeaker', ...input }, async () => {
        const p = await loadProc(tx, ctx, input.processingId, true);
        if (p.blocked) throw new DomainError('consent_denied', 'Processing outputs are blocked');
        if ((await tx.query(`select 1 from ${S}.speaker_turn where processing_id=$1 and label=$2 limit 1`, [p.id, input.label])).length === 0) throw notFound();
        await tx.query(`update ${S}.speaker_attribution set status='revoked', revoked_by=$3, revoked_at=$4, revoke_reason='replaced by a newer attribution' where processing_id=$1 and label=$2 and status='attributed'`, [p.id, input.label, ctx.actor.id, ctx.now]);
        const id = randomUUID();
        await tx.query(`insert into ${S}.speaker_attribution (id, tenant_id, project_id, processing_id, label, identity_ref, basis, reviewed_by, reviewed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, ctx.tenantId, ctx.projectId, p.id, input.label, input.identityRef, input.basis, ctx.actor.id, ctx.now]);
        const detail = { label: input.label, identityRef: input.identityRef, status: 'attributed', verified: false, attributionId: id };
        await kit.emitEvent(tx, S, ctx, 'processing.speaker_attributed', procRef(p.id), detail);
        await kit.appendAudit(tx, S, ctx, 'processing.speaker_attributed', procRef(p.id), detail);
        return { label: input.label, provisional: true, attribution: { id, identityRef: input.identityRef, status: 'attributed', verified: false, basis: input.basis, reviewedBy: ctx.actor.id, reviewedAt: iso(ctx.now) } };
      })) as unknown as Promise<SpeakerView>;
    },
    async revokeSpeakerAttribution(ctx, input) {
      kit.requireCapability(ctx, 'processing:attribute_speaker');
      if (ctx.actor.kind !== 'human') throw new DomainError('forbidden', 'Speaker attribution requires human review');
      nonempty(input?.reason, 'reason', 1000);
      return sql.tx(async (tx) => {
        const a = (await tx.query<R>(`select a.* from ${S}.speaker_attribution a join ${S}.processing p on p.id=a.processing_id where a.id=$4 and p.tenant_id=$1 and p.project_id=$2 and (p.compartment is null or p.compartment = any($3::text[])) for update of a`, [ctx.tenantId, ctx.projectId, cmp(ctx), uuid(input.attributionId)]))[0];
        if (a === undefined) throw notFound();
        if (a.status === 'attributed') {
          await tx.query(`update ${S}.speaker_attribution set status='revoked', revoked_by=$2, revoked_at=$3, revoke_reason=$4 where id=$1`, [a.id, ctx.actor.id, ctx.now, input.reason]);
          await kit.appendAudit(tx, S, ctx, 'processing.speaker_attribution_revoked', procRef(a.processing_id as string), { attributionId: a.id as string, label: a.label as string });
        }
        return { id: a.id as string, status: 'revoked' as const };
      });
    },
    async createRedactedDerivative(ctx, input) {
      kit.requireCapability(ctx, 'processing:write');
      invariant(input !== null && typeof input === 'object' && Array.isArray(input.redactions) && input.redactions.length > 0 && input.redactions.length <= 2000, 'invalid_input', 'Between 1 and 2000 redactions are required');
      for (const s of input.redactions) nonempty(s?.reason, 'redaction reason', 500);
      const r = await loadRep(sql, ctx, input.representation);
      if (r.blocked) throw new DomainError('consent_denied', 'This representation is blocked');
      const proc = await loadProc(sql, ctx, r.processing_id);
      await gate(ctx, proc);
      const revision = r.requested ?? r.current_revision;
      const segs = await sql.query<R>(`${SEG_AT} order by s.ordinal`, [r.id, revision]);
      const spans = new Map<string, [number, number][]>();
      const addSpan = (id: string, a: number, b: number): void => { if (b > a) spans.set(id, [...(spans.get(id) ?? []), [a, b]]); };
      const wordSpans = (s: R, pick: (w: Word) => boolean, whole: boolean): void => {
        const text = s.text as string, words = s.words as Word[] | null;
        if (words === null || words.map((w) => w.t).join(' ') !== text) { if (whole) addSpan(s.id as string, 0, text.length); return; }
        let at = 0;
        for (const w of words) { if (pick(w)) addSpan(s.id as string, at, at + w.t.length); at += w.t.length + 1; }
      };
      for (const sel of input.redactions) {
        if ('segmentId' in sel) {
          const s = segs.find((x) => x.id === sel.segmentId);
          invariant(s !== undefined, 'invalid_input', 'A redaction names a segment outside this representation');
          const len = (s.text as string).length, a = sel.start ?? 0, b = sel.end ?? len;
          invariant(Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b <= len && a < b, 'invalid_input', 'Redaction offsets are outside the segment text');
          addSpan(sel.segmentId, a, b);
        } else if ('page' in sel) {
          invariant(Array.isArray(sel.bbox) && sel.bbox.length === 4 && sel.bbox.every((n) => Number.isFinite(n)), 'invalid_input', 'bbox must be [x0,y0,x1,y1]');
          const [x0, y0, x1, y1] = sel.bbox;
          const hit = (b: number[] | null | undefined): boolean => b !== null && b !== undefined && (b[0] as number) < x1 && (b[2] as number) > x0 && (b[1] as number) < y1 && (b[3] as number) > y0;
          for (const s of segs) if (s.page === sel.page && hit(s.bbox as number[] | null)) wordSpans(s, (w) => hit(w.b), true);
        } else {
          invariant(Number.isFinite(sel.startMs) && Number.isFinite(sel.endMs) && sel.endMs > sel.startMs, 'invalid_input', 'startMs/endMs must describe a time range');
          for (const s of segs) if (s.start_ms !== null && (s.start_ms as number) < sel.endMs && (s.end_ms as number) > sel.startMs) wordSpans(s, (w) => w.s !== undefined && w.e !== undefined && w.s < sel.endMs && w.e > sel.startMs, true);
        }
      }
      invariant(spans.size > 0, 'invalid_input', 'The redactions do not select any text');
      const MARK = '[REDACTED]';
      const outSegs = segs.map((s) => {
        const list = (spans.get(s.id as string) ?? []).sort((a, b) => a[0] - b[0]);
        let text = s.text as string;
        if (list.length > 0) {
          const merged: [number, number][] = [];
          for (const sp of list) { const last = merged.at(-1); if (last !== undefined && sp[0] <= last[1] + 1) last[1] = Math.max(last[1], sp[1]); else merged.push([sp[0], sp[1]]); }
          let built = '', at = 0;
          for (const [a, b] of merged) { built += text.slice(at, a) + MARK; at = b; }
          text = built + text.slice(at);
        }
        return { segmentId: s.id as string, ordinal: s.ordinal as number, text, redacted: list.length > 0, page: s.page ?? null, bbox: list.length > 0 ? null : s.bbox ?? null, startMs: s.start_ms ?? null, endMs: s.end_ms ?? null, speaker: s.speaker ?? null };
      });
      const doc = { type: 'redacted_text', representationRef: repRef(r.id, revision), evidenceRef: r.evidence_ref, marker: MARK, kind: r.kind, language: r.language, machine: r.machine, note: 'Working copy with redactions applied to extracted text. The original and the unredacted representation are unchanged. Positions of redacted segments are withheld.', redactions: input.redactions.map((s) => ({ ...s })), segments: outSegs, text: outSegs.map((s) => s.text).join('\n') };
      const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
      const stored = await storeDerivative(ctx, proc, { kind: 'redacted_text', page: null, mediaType: 'application/json', filename: 'redacted-text.json', bytes, params: { representationRef: repRef(r.id, revision), redactedSegments: [...spans.keys()], redactionCount: input.redactions.length } });
      const id = await sql.tx((tx) => kit.idempotent(tx, S, ctx, input.idempotencyKey, { op: 'redact', r: r.id, revision, s: input.redactions }, async () => {
        const derivativeId = await insertDerivative(tx, ctx, proc, null, stored, { id: r.id, revision });
        const detail = { representationRef: repRef(r.id, revision), evidenceRef: r.evidence_ref, redactedSegments: spans.size, sha256: stored.sha256 };
        await kit.emitEvent(tx, S, ctx, 'processing.redacted', derRef(derivativeId), detail);
        await kit.appendAudit(tx, S, ctx, 'processing.redacted', derRef(derivativeId), detail);
        return derivativeId;
      }));
      return derView((await sql.query<R>(`select * from ${S}.derivative where id=$1`, [id]))[0] as R);
    },
    async listDerivatives(ctx, processingId) {
      kit.requireCapability(ctx, 'processing:read');
      const p = await ownedProc(sql, ctx, processingId);
      return (await sql.query<R>(`select * from ${S}.derivative where processing_id=$1 order by created_at, kind, page nulls first, id`, [p.id])).map(derView);
    },
    async getDerivativeBytes(ctx, id) {
      kit.requireCapability(ctx, 'processing:read');
      const d = (await sql.query<R>(`select * from ${S}.derivative where id=$4 and ${VIS}`, [ctx.tenantId, ctx.projectId, cmp(ctx), uuid(id)]))[0];
      if (d === undefined) throw notFound();
      if (d.blocked === true) throw new DomainError('consent_denied', 'This derivative is blocked');
      const key = d.object_key as string | null;
      // Keys are generated by this engine and always start with the caller's tenant/project; verified again before reading.
      invariant(key === null || key.startsWith(`${ctx.tenantId}/${ctx.projectId}/`), 'not_found', 'Not found');
      const bytes = key !== null && deps.objects !== undefined ? await deps.objects.get(key) : await evidence().getBytes(portCtx(ctx), d.evidence_derivative_ref as string);
      if (sha(bytes) !== d.sha256) throw new DomainError('integrity_failure', 'Derivative bytes do not match the recorded digest');
      return { derivative: derView(d), bytes };
    },
    async exportSearchable(ctx, input) {
      kit.requireCapability(ctx, 'processing:export');
      invariant(input !== null && typeof input === 'object' && ['txt', 'json', 'vtt'].includes(input.format), 'invalid_input', 'format must be txt, json or vtt');
      const view = await engine.getRepresentation({ ...ctx, capabilities: [...ctx.capabilities, 'processing:read'] }, input.representation, input.revision === undefined ? {} : { revision: input.revision });
      const stamp = (ms: number): string => `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
      const header = `${view.label}. Source ${view.evidenceRef}; representation ${view.ref}.${view.machine ? ' Machine-produced; not verified.' : ''}${view.stale ? ' STALE: ' + view.reasons.join('; ') : ''}`;
      let body: string, mediaType: string;
      if (input.format === 'json') { body = JSON.stringify(view); mediaType = 'application/json'; }
      else if (input.format === 'vtt') {
        invariant(view.segments.some((s) => s.startMs !== null), 'invalid_input', 'This representation has no media timestamps');
        body = `WEBVTT\n\nNOTE ${header.replace(/-->/g, '->')}\n\n${view.segments.filter((s) => s.startMs !== null && s.endMs !== null && s.text.trim() !== '').map((s) => `${s.id}\n${stamp(s.startMs as number)} --> ${stamp(Math.max(s.endMs as number, (s.startMs as number) + 1))}\n${s.speaker === null ? '' : `<v ${s.speaker.label} (provisional)>`}${s.text.replace(/-->/g, '->').replace(/\n{2,}/g, '\n')}`).join('\n\n')}\n`;
        mediaType = 'text/vtt';
      } else { body = `# ${header}\n${view.segments.map((s) => `${s.page !== null ? `[p.${s.page}] ` : s.startMs !== null ? `[${stamp(s.startMs)}] ` : ''}${s.speaker === null ? '' : `${s.speaker.label} (provisional): `}${s.text}`).join('\n')}\n`; mediaType = 'text/plain; charset=utf-8'; }
      await sql.tx((tx) => kit.appendAudit(tx, S, ctx, 'processing.exported', view.ref, { format: input.format, segments: view.segments.length }));
      return { mediaType, filename: `representation-${view.id}-r${view.revision}.${input.format}`, bytes: Buffer.from(body, 'utf8'), representationRef: view.ref };
    },
    async searchSegments(ctx, query) {
      kit.requireCapability(ctx, 'processing:read');
      invariant(query !== null && typeof query === 'object' && typeof query.q === 'string' && query.q.length <= 500, 'invalid_input', 'q is required');
      if (query.q.trim() === '') return [];
      const rows = await sql.query<R>(`select t.segment_id, t.revision as text_revision, t.corrected, t.confidence, ts_headline('simple', t.text, query, 'MaxWords=24,MinWords=6,StartSel=«,StopSel=»') as snippet, ts_rank(t.tsv, query) as rank,
          s.kind, s.page, s.bbox, s.start_ms, s.end_ms, s.speaker, r.id as rep_id, r.current_revision, r.kind as rep_kind, r.evidence_ref, r.language, r.machine, r.stale, r.processing_id, r.quality
        from ${S}.segment_text t join ${S}.segment s on s.id=t.segment_id join ${S}.representation r on r.id=t.representation_id, websearch_to_tsquery('simple', $4) query
        where t.is_current and t.tenant_id=$1 and t.project_id=$2 and r.tenant_id=$1 and r.project_id=$2 and (r.compartment is null or r.compartment = any($3::text[])) and not r.blocked and r.state='current' and t.tsv @@ query
          and ($5::text is null or r.evidence_ref=$5) and ($6::text is null or r.language=$6) and ($7::text[] is null or r.kind = any($7))
        order by rank desc, r.created_at, s.ordinal limit ${Math.min(Math.max(query.limit ?? 20, 1), 200)}`, [ctx.tenantId, ctx.projectId, cmp(ctx), query.q, query.evidenceRef ?? null, query.language ?? null, query.kinds ?? null]);
      const labels = new Map<string, Map<string, SpeakerView>>();
      const out: SegmentHit[] = [];
      for (const h of rows) {
        const pid = h.processing_id as string;
        if (h.speaker !== null && !labels.has(pid)) labels.set(pid, await speakerLabels(sql, ctx, pid));
        out.push({ representationRef: repRef(h.rep_id as string, h.current_revision as number), evidenceRef: h.evidence_ref as string, segmentId: h.segment_id as string, kind: h.kind as string, representationKind: h.rep_kind as string, snippet: h.snippet as string, rank: Number(h.rank), page: (h.page as number | null) ?? null, bbox: (h.bbox as SegmentHit['bbox']) ?? null, unit: ((h.quality as R).coordinateUnit as string | undefined) ?? null, startMs: (h.start_ms as number | null) ?? null, endMs: (h.end_ms as number | null) ?? null, speaker: h.speaker === null ? null : labels.get(pid)?.get(h.speaker as string) ?? { label: h.speaker as string, provisional: true, attribution: null }, language: h.language as string | null, machineTranslation: h.rep_kind === 'translation' && h.machine === true, stale: h.stale as boolean, corrected: h.corrected as boolean, confidence: (h.confidence as number | null) ?? null });
      }
      return out;
    },
    async listJobs(ctx, options = {}) { kit.requireCapability(ctx, 'processing:admin'); return (await kit.listJobs(sql, S, ctx, options)).map((j) => ({ ...j, ctx: { ...j.ctx, capabilities: [] } })); },
    async controlJob(ctx, id, action) {
      kit.requireCapability(ctx, 'processing:admin');
      invariant(['cancel', 'pause', 'resume', 'retry'].includes(action), 'invalid_input', 'Unknown job action');
      const job = await kit.controlJob(sql, S, ctx, uuid(id), action);
      await sql.tx((tx) => kit.appendAudit(tx, S, ctx, `processing.job_${action}`, kit.uref(E, 'job', job.id), { kind: job.kind }));
      return { ...job, ctx: { ...job.ctx, capabilities: [] } };
    },
    runJobs(options = {}) { return kit.runJobsOnce(sql, S, handlers, { worker: options.worker ?? `e06-${process.pid}`, limit: options.limit ?? 2, leaseMs: options.leaseMs ?? config.jobLeaseMs ?? 120_000 }); },

    // ── standard surface ──
    async inspect(ctx, ref) {
      kit.requireCapability(ctx, 'processing:read');
      let p: ReturnType<typeof kit.parseUref>;
      try { p = kit.parseUref(ref); } catch { return null; }
      if (p.engine !== E || !UUID.test(p.id)) return null;
      const history = async (subjectPrefix: string): Promise<Inspection['history']> => (await sql.query<R>(`select at, actor_id, action, detail from ${S}._audit where tenant_id=$1 and project_id=$2 and (subject=$3 or subject like $4) order by seq limit 200`, [ctx.tenantId, ctx.projectId, subjectPrefix, `${subjectPrefix}@%`])).map((a) => ({ at: iso(a.at), actorId: a.actor_id as string, action: a.action as string, detail: a.detail as Json }));
      try {
        if (p.kind === 'processing') {
          const row = await loadProc(sql, ctx, p.id);
          const view = await procView(sql, row);
          const ders = await sql.query<{ id: string }>(`select id from ${S}.derivative where processing_id=$1`, [row.id]);
          return { ref: view.ref, kind: 'processing', title: `Processing of ${row.filename}`, state: row.blocked ? 'blocked' : row.stale ? 'stale' : row.state, stale: row.stale, blocked: row.blocked, staleReasons: row.reasons, versions: [{ revision: row.generation, at: view.createdAt, actorId: (row as unknown as R).requested_by as string, summary: `generation ${row.generation}` }], sources: row.sources, dependents: [...view.representations, ...ders.map((d) => derRef(d.id))], permissions: [], decisions: [], history: await history(view.ref), data: view as unknown as Json };
        }
        if (p.kind === 'representation') {
          const r = await loadRep(sql, ctx, ref);
          const revision = r.requested ?? r.current_revision;
          const revs = await sql.query<R>(`select * from ${S}.representation_revision where representation_id=$1 order by revision`, [r.id]);
          const deps_ = [...(await sql.query<{ id: string; current_revision: number }>(`select id, current_revision from ${S}.representation where tenant_id=$1 and project_id=$2 and source_ref like $3`, [ctx.tenantId, ctx.projectId, `${repRef(r.id)}@%`])).map((t) => repRef(t.id, t.current_revision)), ...(await sql.query<{ id: string }>(`select id from ${S}.derivative where representation_id=$1`, [r.id])).map((d) => derRef(d.id))];
          const segCount = Number((await sql.query<{ n: string }>(`select count(*) as n from ${S}.segment where representation_id=$1`, [r.id]))[0]?.n);
          // Blocked content is not readable; the object and the reasons stay visible.
          const data = r.blocked ? { blocked: true, kind: r.kind } : { ...(await repView(sql, ctx, r, revision, false)), segments: undefined, segmentCount: segCount };
          return { ref: repRef(r.id, revision), kind: 'representation', title: r.label as string, state: r.blocked ? 'blocked' : r.stale ? 'stale' : r.state as string, stale: r.stale as boolean, blocked: r.blocked, staleReasons: r.reasons as string[], versions: revs.map((v) => ({ revision: v.revision as number, at: iso(v.at), actorId: v.actor_id as string, summary: v.reason as string })), sources: r.sources as string[], dependents: deps_, permissions: [], decisions: [], history: await history(repRef(r.id)), data: JSON.parse(JSON.stringify(data)) as Json };
        }
        if (p.kind === 'derivative') {
          const d = (await sql.query<R>(`select * from ${S}.derivative where id=$4 and ${VIS}`, [ctx.tenantId, ctx.projectId, cmp(ctx), p.id]))[0];
          if (d === undefined) return null;
          const view = derView(d);
          const proc = await loadProc(sql, ctx, view.processingId);
          return { ref: view.ref, kind: 'derivative', title: `${view.kind}${view.page === null ? '' : ` page ${view.page}`}`, state: view.blocked ? 'blocked' : view.stale ? 'stale' : 'current', stale: view.stale, blocked: view.blocked, staleReasons: view.reasons, versions: [{ revision: 1, at: iso(d.created_at), actorId: d.created_by as string }], sources: [...proc.sources, ...(view.representationRef === null ? [] : [view.representationRef])], dependents: view.evidenceDerivativeRef === null ? [] : [view.evidenceDerivativeRef], permissions: [], decisions: [], history: await history(view.ref), data: view as unknown as Json };
        }
      } catch (error) { if (error instanceof DomainError && error.code === 'not_found') return null; throw error; }
      return null;
    },
    async search(ctx, query) {
      const hits = await engine.searchSegments(ctx, { q: query?.q ?? '', ...(query?.limit === undefined ? {} : { limit: query.limit }) });
      return hits.map((h): SearchHit => ({ ref: h.representationRef, kind: `segment:${h.representationKind}`, title: `${h.evidenceRef}${h.page !== null ? ` p.${h.page}` : h.startMs !== null ? ` @${h.startMs}ms` : ''}`, snippet: h.snippet, state: h.stale ? 'stale' : 'current' }));
    },
    async audit(ctx, options = {}) { kit.requireCapability(ctx, 'processing:read'); return kit.listAudit(sql, S, ctx, options) as Promise<AuditRecord[]>; },
    async events(ctx, options = {}) { kit.requireCapability(ctx, 'processing:events'); return (await kit.readEvents(sql, S, { ...options, tenantId: ctx.tenantId })).map((e): EngineEvent => ({ ...e, engine: E })); },
    async applyUpstreamChange(ctx, change) {
      kit.requireCapability(ctx, 'processing:write');
      invariant(change !== null && typeof change === 'object' && typeof change.eventId === 'string' && change.eventId.length > 0 && change.eventId.length <= 200 && Array.isArray(change.refs) && change.refs.length <= 1000 && typeof change.kind === 'string', 'invalid_input', 'Invalid upstream change');
      const reason = String(change.reason ?? '').slice(0, 500) || change.kind;
      const parsed = change.refs.map((r) => ({ ref: r, p: kit.parseUref(r) }));
      const reprocess: { old: ProcRow; candidates: string[] }[] = [];
      const result = await sql.tx(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`e06-upstream:${ctx.tenantId}:${ctx.projectId}:${change.eventId}`]);
        const prior = (await tx.query<{ affected: string[] }>(`select affected from ${S}.upstream_change where tenant_id=$1 and project_id=$2 and event_id=$3`, [ctx.tenantId, ctx.projectId, change.eventId]))[0];
        if (prior !== undefined) return { affected: prior.affected, replay: true };
        const affected: string[] = [];
        const procs = await tx.query<ProcRow>(`select * from ${S}.processing where tenant_id=$1 and project_id=$2 for update`, [ctx.tenantId, ctx.projectId]);
        const blocking = change.kind === 'permission_withdrawn' || change.kind === 'source_removed' || change.kind === 'rights_changed';
        if (blocking) for (const r of parsed) await tx.query(`insert into ${S}.block (tenant_id, project_id, ref, reason, event_id, at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [ctx.tenantId, ctx.projectId, r.ref, reason, change.eventId, ctx.now]);
        for (const proc of procs) {
          const sources = proc.sources.map((s) => kit.parseUref(s));
          // A change naming a newer revision of the same evidence supersedes this record; one naming an older revision does not touch it.
          const hits = parsed.filter(({ p }) => sources.some((s) => s.engine === p.engine && s.id === p.id && (s.kind === p.kind || (p.kind === 'evidence' || s.kind === 'evidence'))));
          const reps = await tx.query<{ id: string; sources: string[] }>(`select id, sources from ${S}.representation where processing_id=$1`, [proc.id]);
          const viaRep = reps.some((r) => r.sources.some((s) => change.refs.some((c) => sameObject(c, s))));
          if (hits.length === 0 && !viaRep) continue;
          if (blocking || change.kind === 'permission_changed') {
            if (change.kind === 'permission_changed') {
              // Re-decide where a port exists; otherwise flag for review rather than assume either outcome.
              let denied: string | null = null;
              try { await gate(ctx, proc); } catch (error) { if (error instanceof DomainError && ['consent_denied', 'forbidden'].includes(error.code)) denied = error.message; else throw error; }
              if (denied === null) continue;
            }
            if (!proc.blocked) affected.push(...await blockProcessing(tx, ctx, proc.id, reason, change.eventId));
            continue;
          }
          const superseding = hits.filter(({ p }) => p.revision === undefined || p.revision >= proc.evidence_revision);
          if (hits.length > 0 && superseding.length === 0 && !viaRep) continue;
          const local: string[] = [];
          if (!proc.stale) { await tx.query(`update ${S}.processing set stale=true, reasons = reasons || $2::jsonb, updated_at=$3 where id=$1`, [proc.id, J([reason]), ctx.now]); local.push(procRef(proc.id)); }
          for (const r of await tx.query<{ id: string; current_revision: number }>(`update ${S}.representation set stale=true, reasons = reasons || $2::jsonb where processing_id=$1 and not stale returning id, current_revision`, [proc.id, J([reason])])) local.push(repRef(r.id, r.current_revision));
          for (const d of await tx.query<{ id: string }>(`update ${S}.derivative set stale=true, reasons = reasons || $2::jsonb where processing_id=$1 and not stale returning id`, [proc.id, J([reason])])) local.push(derRef(d.id));
          for (const ref of local) await kit.emitEvent(tx, S, ctx, 'processing.stale', ref, { reason, cause: change.eventId });
          affected.push(...local);
          if ((change.kind === 'source_superseded' || change.kind === 'source_corrected') && hits.length > 0) reprocess.push({ old: proc, candidates: [...superseding.filter(({ p }) => p.kind !== 'evidence' && p.revision !== undefined && p.revision > proc.evidence_revision).map(({ ref }) => ref), kit.uref('E05', kit.parseUref(proc.evidence_ref).kind, proc.evidence_id)] });
        }
        await tx.query(`insert into ${S}.upstream_change (tenant_id, project_id, event_id, kind, affected, at) values ($1,$2,$3,$4,$5::jsonb,$6)`, [ctx.tenantId, ctx.projectId, change.eventId, change.kind, J(affected), ctx.now]);
        await kit.appendAudit(tx, S, ctx, 'processing.upstream_change_applied', kit.uref(E, 'upstream_change', sha(change.eventId).slice(0, 32)), { eventId: change.eventId, kind: change.kind, refs: change.refs.slice(0, 50), affected: affected.length });
        return { affected, replay: false };
      });
      // Reprocessing of the superseding version is enqueued after the stale marks are committed; it is idempotent per evidence version and options.
      if (!result.replay && ports.evidence !== undefined) for (const { old, candidates } of reprocess) {
        for (const candidate of candidates) {
          let info: kit.EvidenceVersionInfo | null = null;
          try { info = await ports.evidence.describe(portCtx(ctx), candidate); } catch { info = null; }
          if (info === null || info.ref === old.evidence_ref || info.evidenceId !== old.evidence_id || info.revision <= old.evidence_revision) continue;
          try { await gate(ctx, { id: '', evidence_ref: info.ref, sources: [info.ref, ...old.sources.filter((s) => kit.parseUref(s).kind === 'evidence')] }); } catch { break; }
          const found = info;
          await sql.tx((tx) => createProcessing(tx, ctx, found, old.options, false, change.eventId));
          break;
        }
      }
      return { affected: result.affected };
    },
    async health() {
      let db = true;
      try { await sql.query('select 1'); } catch { db = false; }
      const names = ['pdftotext', 'tesseract', 'ffmpeg', 'pandoc', 'soffice', 'exiftool', 'convert', 'apertium'];
      const versions = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await runner.version(n)] as const)));
      return { ok: db, detail: { database: db, tools: versions, evidencePort: ports.evidence !== undefined, useDecisionPort: ports.useDecisions !== undefined ? 'port' : config.standalone?.useDecisions === 'allow' ? 'standalone-allow' : 'absent-deny', objectStore: deps.objects !== undefined } };
    },
  };
  return engine;
}

// ───────────────────────────── HTTP ─────────────────────────────
/** The kit maps unknown error codes to 500; policy refusals are client-visible decisions, so they are answered as 403 here. */
function guard(handler: Route['handler']): Route['handler'] {
  return async (r) => {
    try { return await handler(r); } catch (error) {
      if (error instanceof DomainError && error.code === 'policy_denied') return { status: 403, json: { error: { code: 'policy_denied', message: error.message } } };
      if (error instanceof DomainError && error.code === 'integrity_failure') return { status: 409, json: { error: { code: 'integrity_failure', message: error.message } } };
      throw error;
    }
  };
}
export function routes(engine: ProcessingEngine): Route[] {
  const body = (r: kit.HttpRequest): Record<string, unknown> => { invariant(r.body !== null && typeof r.body === 'object' && !Array.isArray(r.body), 'invalid_input', 'JSON object body required'); return r.body as Record<string, unknown>; };
  const idem = (r: kit.HttpRequest): { idempotencyKey?: string } => { const k = r.headers['idempotency-key']; return typeof k === 'string' && k !== '' ? { idempotencyKey: k } : {}; };
  const num = (v: string | null): number | undefined => v === null ? undefined : Number(v);
  const P = (r: kit.HttpRequest, name: string): string => r.params[name] as string;
  const own: Route[] = [
    { method: 'GET', path: '/v1/policy', handler: async (r) => (await engine.getPolicy(r.ctx)) as unknown as Json },
    { method: 'PUT', path: '/v1/policy', handler: async (r) => (await engine.setPolicy(r.ctx, { ...body(r), ...idem(r) } as never)) as unknown as Json },
    { method: 'GET', path: '/v1/tools', handler: async (r) => (await engine.describeTools(r.ctx)) as unknown as Json },
    { method: 'POST', path: '/v1/processing/jobs', handler: async (r) => ({ status: 202, json: await engine.requestProcessing(r.ctx, { ...body(r), ...idem(r) } as never) }) },
    { method: 'GET', path: '/v1/processing', handler: async (r) => { const limit = num(r.query.get('limit')); return (await engine.listProcessing(r.ctx, { ...(r.query.get('evidenceRef') === null ? {} : { evidenceRef: r.query.get('evidenceRef') as string }), ...(r.query.get('state') === null ? {} : { state: r.query.get('state') as string }), ...(limit === undefined ? {} : { limit }) })) as unknown as Json; } },
    { method: 'GET', path: '/v1/processing/:id', handler: async (r) => (await engine.getProcessing(r.ctx, P(r, 'id'))) as unknown as Json },
    { method: 'POST', path: '/v1/processing/:id/cancel', handler: async (r) => (await engine.cancelProcessing(r.ctx, P(r, 'id'), (r.body ?? {}) as never)) as unknown as Json },
    { method: 'POST', path: '/v1/processing/:id/retry', handler: async (r) => (await engine.retryProcessing(r.ctx, P(r, 'id'))) as unknown as Json },
    { method: 'GET', path: '/v1/processing/:id/alignment', handler: async (r) => (await engine.getAlignment(r.ctx, P(r, 'id'))) as unknown as Json },
    { method: 'GET', path: '/v1/processing/:id/observations', handler: async (r) => (await engine.listObservations(r.ctx, P(r, 'id'), r.query.get('kind') === null ? {} : { kind: r.query.get('kind') as string })) as unknown as Json },
    { method: 'GET', path: '/v1/processing/:id/speakers', handler: async (r) => (await engine.listSpeakers(r.ctx, P(r, 'id'))) as unknown as Json },
    { method: 'POST', path: '/v1/processing/:id/speaker-attributions', handler: async (r) => (await engine.attributeSpeaker(r.ctx, { ...body(r), processingId: P(r, 'id'), ...idem(r) } as never)) as unknown as Json },
    { method: 'POST', path: '/v1/speaker-attributions/:id/revoke', handler: async (r) => (await engine.revokeSpeakerAttribution(r.ctx, { attributionId: P(r, 'id'), reason: String(body(r).reason ?? '') })) as unknown as Json },
    { method: 'GET', path: '/v1/processing/:id/derivatives', handler: async (r) => (await engine.listDerivatives(r.ctx, P(r, 'id'))) as unknown as Json },
    { method: 'GET', path: '/v1/derivatives/:id/bytes', handler: async (r) => { const d = await engine.getDerivativeBytes(r.ctx, P(r, 'id')); return { bytes: d.bytes, headers: { 'content-type': d.derivative.mediaType, 'content-disposition': 'attachment', 'x-content-sha256': d.derivative.sha256 } }; } },
    { method: 'GET', path: '/v1/representations/:id', handler: async (r) => { const revision = num(r.query.get('revision')); return (await engine.getRepresentation(r.ctx, P(r, 'id'), revision === undefined ? {} : { revision })) as unknown as Json; } },
    { method: 'GET', path: '/v1/representations/:id/revisions', handler: async (r) => (await engine.listRevisions(r.ctx, P(r, 'id'))) as unknown as Json },
    { method: 'POST', path: '/v1/representations/:id/revisions', handler: async (r) => ({ status: 201, json: await engine.correctText(r.ctx, { ...body(r), representation: P(r, 'id'), ...idem(r) } as never) }) },
    { method: 'POST', path: '/v1/transcripts/:id/revisions', handler: async (r) => ({ status: 201, json: await engine.correctText(r.ctx, { ...body(r), representation: P(r, 'id'), ...idem(r) } as never) }) },
    { method: 'POST', path: '/v1/representations/:id/translations', handler: async (r) => ({ status: 202, json: await engine.requestTranslation(r.ctx, { ...body(r), representation: P(r, 'id'), ...idem(r) } as never) }) },
    { method: 'POST', path: '/v1/representations/:id/redactions', handler: async (r) => ({ status: 201, json: await engine.createRedactedDerivative(r.ctx, { ...body(r), representation: P(r, 'id'), ...idem(r) } as never) }) },
    { method: 'GET', path: '/v1/representations/:id/locate', handler: async (r) => { const ms = num(r.query.get('ms')); const out = await engine.locate(r.ctx, P(r, 'id'), ms !== undefined ? { ms } : { page: Number(r.query.get('page')), x: Number(r.query.get('x')), y: Number(r.query.get('y')) }); if (out === null) throw new DomainError('not_found', 'Not found'); return out as unknown as Json; } },
    { method: 'GET', path: '/v1/representations/:id/export', handler: async (r) => { const revision = num(r.query.get('revision')); const out = await engine.exportSearchable(r.ctx, { representation: P(r, 'id'), format: (r.query.get('format') ?? 'txt') as 'txt', ...(revision === undefined ? {} : { revision }) }); return { bytes: out.bytes, headers: { 'content-type': out.mediaType, 'content-disposition': `attachment; filename="${out.filename}"` } }; } },
    { method: 'GET', path: '/v1/segments/search', handler: async (r) => { const limit = num(r.query.get('limit')); return (await engine.searchSegments(r.ctx, { q: r.query.get('q') ?? '', ...(limit === undefined ? {} : { limit }), ...(r.query.get('evidenceRef') === null ? {} : { evidenceRef: r.query.get('evidenceRef') as string }), ...(r.query.get('language') === null ? {} : { language: r.query.get('language') as string }) })) as unknown as Json; } },
    { method: 'GET', path: '/v1/jobs', handler: async (r) => (await engine.listJobs(r.ctx)) as unknown as Json },
    { method: 'POST', path: '/v1/jobs/:id/:action', handler: async (r) => (await engine.controlJob(r.ctx, P(r, 'id'), P(r, 'action') as 'cancel')) as unknown as Json },
  ];
  return [...kit.standardRoutes(engine), ...own].map((route) => ({ ...route, handler: guard(route.handler) }));
}
