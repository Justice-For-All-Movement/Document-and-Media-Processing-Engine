// Service-layer tests against real PostgreSQL and the real local tools (poppler, tesseract, LibreOffice, pandoc,
// ImageMagick, ffmpeg, exiftool, PocketSphinx, Apertium). Fixtures are generated, fictional and local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import * as kit from '../src/service-kit.ts';
import { SCHEMA, createEngine, manifest, migrate, routes } from '../src/engine/index.ts';
import type { EngineConfig, ProcessingEngine, ProcessingView, RepresentationView } from '../src/engine/index.ts';
import { KNOWN, ctxOf, evidenceDouble, fakeProvider, fakeWhisper, fixtures, has } from './engine-fixture.ts';
import type { EvidenceDouble } from './engine-fixture.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
const code = (c: string) => (e: unknown): boolean => e instanceof DomainError && e.code === c;
const PNG = '\x89PNG\r\n\x1a\n';
const isPng = (b: Uint8Array): boolean => Buffer.from(b.subarray(0, 8)).toString('latin1') === PNG;
const SECRET = 'sk-test-PROVIDER-SECRET-12345';

async function drain(engine: ProcessingEngine, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) { if (await engine.runJobs({ worker: 'test-worker', limit: 3 }) === 0) return; }
  throw new Error('jobs did not drain');
}
async function settle(engine: ProcessingEngine, ctx: kit.ServiceContext, id: string): Promise<ProcessingView> {
  for (let i = 0; i < 300; i++) {
    await engine.runJobs({ worker: 'test-worker', limit: 3 });
    const p = await engine.getProcessing(ctx, id);
    if (p.state !== 'queued' && p.state !== 'running') { await drain(engine); return engine.getProcessing(ctx, id); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('processing did not settle');
}
const stepState = (p: ProcessingView, name: string): string | undefined => p.steps.find((s) => s.name === name)?.state;

test('E06 engine: documents, OCR, search, corrections, translation, policy, redaction, isolation', needsPg, async (t) => {
  const f = fixtures();
  const work = mkdtempSync(join(tmpdir(), 'e06-test-'));
  const provider = await fakeProvider();
  t.after(async () => { await provider.close(); rmSync(work, { recursive: true, force: true }); });
  await kit.withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    assert.deepEqual(await migrate(sql), ['001_processing']);
    assert.deepEqual(await migrate(sql), []);
    const evidence = evidenceDouble();
    const objects = new kit.FsObjectStore(join(work, 'objects'));
    const config: EngineConfig = {
      tempRoot: work, standalone: { useDecisions: 'allow' }, defaultLanguages: ['auto'],
      translation: { providers: { lt: { kind: 'libretranslate', baseUrl: provider.url, apiKey: SECRET }, llm: { kind: 'llm', baseUrl: `${provider.url}/v1`, apiKey: SECRET, model: 'test-model' }, badllm: { kind: 'llm', baseUrl: `${provider.url}/bad/v1`, apiKey: SECRET, model: 'test-model' } } },
    };
    const engine = createEngine({ sql, objects, ports: { evidence }, config });
    const ctx = ctxOf();
    const put = async (bytes: Uint8Array, mediaType: string, filename: string, c = ctx, compartment?: string): Promise<kit.EvidenceVersionInfo> => evidence.accept(c, { bytes, mediaType, filename, origin: { test: true }, ...(compartment === undefined ? {} : { compartment }) });
    const process = async (bytes: Uint8Array, mediaType: string, filename: string, extra: Record<string, unknown> = {}): Promise<{ info: kit.EvidenceVersionInfo; proc: ProcessingView; rep: RepresentationView }> => {
      const info = await put(bytes, mediaType, filename);
      const requested = await engine.requestProcessing(ctx, { evidenceRef: info.ref, ...extra });
      const proc = await settle(engine, ctx, requested.id);
      const rep = await engine.getRepresentation(ctx, proc.representations[0] as string);
      return { info, proc, rep };
    };

    await t.test('tools are real and reported with versions', async () => {
      const d = await engine.describeTools(ctx);
      for (const tool of ['pdftotext', 'pdftoppm', 'tesseract', 'ffmpeg', 'ffprobe', 'exiftool', 'pandoc', 'soffice', 'convert']) assert.match(String(d.tools[tool]), /\d+\.\d+/, `${tool} version`);
      assert.ok(d.ocrLanguages.includes('eng'));
      assert.equal(d.diarization.available, true);
      assert.ok(d.translation.some((x) => x.id === 'lt' && x.local === false && /not a live provider/.test(x.verified)));
      assert.equal((await engine.health()).ok, true);
    });

    let pdf!: Awaited<ReturnType<typeof process>>;
    await t.test('born-digital PDF: words with page coordinates, search anchors, thumbnails, metadata, idempotent replay', async () => {
      pdf = await process(f.pdf, 'application/pdf', 'doc.pdf');
      assert.equal(pdf.proc.state, 'done', JSON.stringify(pdf.proc.steps));
      assert.equal(pdf.proc.family, 'pdf');
      assert.deepEqual(pdf.proc.steps.map((s) => [s.name, s.state]), [['metadata', 'done'], ['extract', 'done'], ['thumbnails', 'done']]);
      assert.match(pdf.proc.steps[1]?.toolVersion ?? '', /^\d+\.\d+.*\+.*\d/);
      const rep = pdf.rep;
      assert.equal(rep.kind, 'text'); assert.equal(rep.revision, 1); assert.equal(rep.evidenceRef, pdf.info.ref);
      assert.equal(rep.language, 'eng'); assert.equal(rep.languageMethod, 'stopword-profile');
      const pages = rep.pages as { page: number; width: number; height: number; unit: string; source: string }[];
      assert.deepEqual(pages.map((p) => [p.page, p.width, p.height, p.unit, p.source]), [[1, 612, 792, 'pt', 'text_layer']]);
      const line = rep.segments.find((s) => s.text === KNOWN.pdfLine1);
      assert.ok(line, 'known line extracted'); assert.equal(line.page, 1); assert.equal(line.source, 'text_layer'); assert.equal(line.confidence, null);
      const harbor = line.words?.find((w) => w.t === 'harbor');
      assert.ok(harbor?.b, 'word box present');
      const [x0, y0, x1, y1] = harbor.b;
      assert.ok(x0 > 150 && x1 < 300 && y0 > 100 && y1 < 160 && x1 > x0 && y1 > y0, `harbor box ${harbor.b}`);
      // coordinates round-trip to the original segment and word
      const at = await engine.locate(ctx, rep.ref, { page: 1, x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
      assert.equal(at?.segment.id, line.id); assert.equal(at?.word?.t, 'harbor'); assert.equal(at?.evidenceRef, pdf.info.ref);
      assert.equal(await engine.locate(ctx, rep.ref, { page: 1, x: 600, y: 780 }), null);
      // search
      const hits = await engine.searchSegments(ctx, { q: 'invoice 4471' });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.evidenceRef, pdf.info.ref); assert.equal(hits[0]?.representationRef, rep.ref); assert.equal(hits[0]?.page, 1); assert.equal(hits[0]?.unit, 'pt');
      assert.equal(hits[0]?.bbox?.length, 4); assert.match(hits[0]?.snippet ?? '', /«invoice»/);
      const std = await engine.search(ctx, { q: 'harbor' });
      assert.equal(std[0]?.ref, rep.ref); assert.match(std[0]?.title ?? '', /p\.1$/);
      // thumbnails are valid images, stored under the tenant prefix and registered with evidence
      const ders = await engine.listDerivatives(ctx, pdf.proc.id);
      const thumb = ders.find((d) => d.kind === 'thumbnail');
      assert.ok(thumb); assert.equal(thumb.page, 1); assert.match(thumb.evidenceDerivativeRef ?? '', /^E05:evidence_version:/);
      const bytes = (await engine.getDerivativeBytes(ctx, thumb.id)).bytes;
      assert.ok(isPng(bytes));
      assert.match(execFileSync('identify', ['-format', '%m %w %h', '-'], { input: bytes }).toString(), /^PNG \d+ \d+$/);
      assert.equal(evidence.derivatives(pdf.info.ref).filter((d) => d.relation === 'thumbnail').length, 1);
      // metadata is an observation, flagged forgeable
      const meta = await engine.listObservations(ctx, pdf.proc.id, { kind: 'metadata' });
      const exif = meta.find((o) => o.tool === 'exiftool');
      assert.ok(exif); assert.match(exif.caveat ?? '', /forged/);
      assert.equal((exif.data as { forgeable: boolean; verified: boolean }).forgeable, true); assert.equal((exif.data as { verified: boolean }).verified, false);
      assert.ok(Object.keys((exif.data as { tags: Record<string, unknown> }).tags).some((k) => /Producer|Creator/.test(k)));
      // idempotent: same evidence version + options returns the same record and enqueues nothing
      const again = await engine.requestProcessing(ctx, { evidenceRef: pdf.info.ref });
      assert.equal(again.id, pdf.proc.id);
      assert.equal(await engine.runJobs({ worker: 'w' }), 0);
      const k1 = await engine.requestProcessing(ctx, { evidenceRef: pdf.info.ref, languages: ['eng'], idempotencyKey: 'k-1' });
      const k2 = await engine.requestProcessing(ctx, { evidenceRef: pdf.info.ref, languages: ['eng'], idempotencyKey: 'k-1' });
      assert.equal(k1.id, k2.id); assert.notEqual(k1.id, pdf.proc.id);
      await assert.rejects(engine.requestProcessing(ctx, { evidenceRef: pdf.info.ref, languages: ['spa'], idempotencyKey: 'k-1' }), code('idempotency_conflict'));
      await engine.cancelProcessing(ctx, k1.id, { reason: 'duplicate' });
      assert.equal(await engine.runJobs({ worker: 'w' }), 0, 'cancelled processing leaves no runnable job');
      assert.equal((await engine.getProcessing(ctx, k1.id)).state, 'cancelled');
      const events = await engine.events(ctx);
      assert.ok(events.some((e) => e.type === 'processing.completed' && e.subject === pdf.proc.ref && (e.payload as { evidenceRef: string }).evidenceRef === pdf.info.ref));
    });

    let scan!: Awaited<ReturnType<typeof process>>;
    await t.test('pages without a text layer are rasterised and OCRed; coordinates stay in page space; quality is observed', async () => {
      const mixed = await process(f.mixedPdf, 'application/pdf', 'mixed.pdf');
      assert.equal(mixed.proc.state, 'done', JSON.stringify(mixed.proc.steps));
      const pages = mixed.rep.pages as { page: number; source: string; width: number; height: number; ocr?: { meanConfidence: number; words: number; languages: string[]; script: string | null } }[];
      assert.deepEqual(pages.map((p) => p.source), ['text_layer', 'ocr']);
      assert.ok((pages[1]?.ocr?.meanConfidence ?? 0) > 0.8); assert.ok((pages[1]?.ocr?.words ?? 0) >= 10);
      assert.deepEqual(pages[1]?.ocr?.languages.includes('eng'), true);
      const ocrLine = mixed.rep.segments.find((s) => s.page === 2 && /Payment 4471 was approved in March/.test(s.text));
      assert.ok(ocrLine, `OCR text: ${mixed.rep.segments.filter((s) => s.page === 2).map((s) => s.text).join(' | ')}`);
      assert.equal(ocrLine.source, 'ocr'); assert.ok((ocrLine.confidence ?? 0) > 0.8);
      const w = ocrLine.words?.find((x) => x.t === '4471');
      assert.ok(w?.b && typeof w.c === 'number' && w.c > 0.5);
      assert.ok(w.b[0] >= 0 && w.b[2] <= (pages[1]?.width ?? 0) && w.b[3] <= (pages[1]?.height ?? 0), 'OCR boxes are in PDF points of the original page');
      const hit = await engine.locate(ctx, mixed.rep.ref, { page: 2, x: (w.b[0] + w.b[2]) / 2, y: (w.b[1] + w.b[3]) / 2 });
      assert.equal(hit?.segment.id, ocrLine.id); assert.equal(hit?.word?.t, '4471');
      assert.ok(mixed.rep.segments.some((s) => s.page === 1 && s.text === KNOWN.pdfLine1 && s.source === 'text_layer'));
      const q = await engine.listObservations(ctx, mixed.proc.id, { kind: 'quality' });
      assert.equal(q.length, 1); assert.equal(q[0]?.page, 2); assert.match(q[0]?.toolVersion ?? '', /\d/);

      scan = await process(f.scanPng, 'image/png', 'scan.png');
      assert.equal(scan.proc.state, 'done', JSON.stringify(scan.proc.steps));
      assert.equal(scan.rep.label, 'Machine-read text (OCR)'); assert.equal(scan.rep.machine, true);
      assert.deepEqual(scan.rep.segments.map((s) => s.text), [KNOWN.scan1, KNOWN.scan2]);
      const page = (scan.rep.pages as { unit: string; width: number; ocr: { script: string } }[])[0];
      assert.equal(page?.unit, 'px'); assert.equal(page?.width, 1600); assert.equal(page?.ocr.script, 'Latin');
      const box = scan.rep.segments[0]?.words?.find((x) => x.t === 'harbor')?.b;
      assert.ok(box && box[0] > 150 && box[2] < 340 && box[1] > 70 && box[3] < 130, `harbor px box ${box}`);
      const spdf = (await engine.listDerivatives(ctx, scan.proc.id)).find((d) => d.kind === 'searchable_pdf');
      assert.ok(spdf); assert.equal(spdf.representationRef, scan.rep.ref);
      const pdfBytes = (await engine.getDerivativeBytes(ctx, spdf.id)).bytes;
      assert.equal(Buffer.from(pdfBytes.subarray(0, 5)).toString(), '%PDF-');
      assert.match(execFileSync('pdftotext', ['-', '-'], { input: pdfBytes }).toString(), /harbor audit/);

      const scanned = await process(f.scannedPdf, 'application/pdf', 'scan.pdf', { languages: ['eng'] });
      assert.ok(scanned.rep.segments.some((s) => /harbor audit found missing invoices/.test(s.text)));
      assert.ok((await engine.listDerivatives(ctx, scanned.proc.id)).some((d) => d.kind === 'searchable_pdf'));

      const tiny = await process(f.tinyPng, 'image/png', 'tiny.png');
      const warnings = ((tiny.rep.pages as { warnings: string[] }[])[0]?.warnings ?? []).join(' ');
      assert.match(warnings, /Low resolution/);
    });

    await t.test('unavailable OCR language data is reported, never substituted', async () => {
      const info = await put(f.scanPng, 'image/png', 'scan-fra.png');
      const p = await settle(engine, ctx, (await engine.requestProcessing(ctx, { evidenceRef: info.ref, languages: ['fra'] })).id);
      assert.equal(stepState(p, 'extract'), 'unavailable');
      assert.match(p.steps.find((s) => s.name === 'extract')?.error ?? '', /not installed for fra/);
      assert.equal(p.state, 'failed'); assert.equal(p.representations.length, 0);
    });

    await t.test('office, HTML, mail and text keep paragraph anchors; hostile content is not fetched or executed', async () => {
      const docx = await process(f.docx, 'application/octet-stream', 'doc.docx');
      assert.equal(docx.proc.family, 'office'); assert.equal(docx.proc.state, 'done', JSON.stringify(docx.proc.steps));
      assert.deepEqual(docx.rep.segments.map((s) => s.text), ['Title', KNOWN.pdfLine1, KNOWN.pdfLine2]);
      assert.deepEqual(docx.rep.segments.map((s) => (s.anchor as { paragraph: number }).paragraph), [1, 2, 3]);
      assert.equal((docx.rep.engine as { id: string }).id, 'pandoc');
      assert.ok(isPng((await engine.getDerivativeBytes(ctx, ((await engine.listDerivatives(ctx, docx.proc.id)).find((d) => d.kind === 'thumbnail') as { id: string }).id)).bytes));
      const before = provider.requests.length;
      const html = await process(f.html, 'text/plain', 'notice.html');
      assert.equal(html.proc.mediaType, 'text/html');
      const text = html.rep.segments.map((s) => s.text).join('\n');
      assert.match(text, /ferry timetable changes in April/); assert.doesNotMatch(text, /injected/);
      assert.equal(provider.requests.length, before);
      const warn = await engine.listObservations(ctx, html.proc.id, { kind: 'warning' });
      assert.ok(warn.some((o) => (o.data as { code: string }).code === 'media_type_mismatch'));
      const eml = await process(f.eml, 'message/rfc822', 'minutes.eml');
      const mail = eml.rep.segments.map((s) => s.text).join('\n');
      assert.match(mail, /Subject: Minutes of the café meeting/); assert.match(mail, /attached for the café meeting/); assert.doesNotMatch(mail, /ignored html/);
      const txt = await process(f.txt, 'text/plain', 'note.txt');
      assert.equal(txt.rep.machine, false); assert.equal(txt.rep.segments[0]?.text, KNOWN.english);
      // A playlist is text, so it never reaches ffmpeg (which could otherwise be steered to read local files).
      const playlist = await process(Buffer.from('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n'), 'audio/x-mpegurl', 'a.m3u8');
      assert.equal(playlist.proc.family, 'text'); assert.ok(!playlist.rep.segments.some((s) => /root:/.test(s.text)));
      const junk = await put(Buffer.from([0, 1, 2, 3, 255, 254, 0, 9, 8, 7]), 'application/pdf', 'junk.pdf');
      const failed = await settle(engine, ctx, (await engine.requestProcessing(ctx, { evidenceRef: junk.ref })).id);
      assert.equal(failed.state, 'failed'); assert.match(failed.failure ?? '', /unsupported_media_type/);
      const broken = await put(Buffer.from('%PDF-1.7\nthis is not really a pdf'), 'application/pdf', 'broken.pdf');
      const bad = await settle(engine, ctx, (await engine.requestProcessing(ctx, { evidenceRef: broken.ref, steps: ['extract'] })).id);
      assert.equal(bad.state, 'failed'); assert.equal(stepState(bad, 'extract'), 'failed');
      assert.deepEqual(readdirSync(work).filter((n) => n.startsWith('e06-')), [], 'working directories are removed');
    });

    await t.test('corrections create addressable revisions, keep prior text, emit processing.text_corrected and flag dependents', async () => {
      const rep = scan.rep;
      const seg = rep.segments[1] as RepresentationView['segments'][number];
      const translated = await engine.requestTranslation(ctx, { representation: rep.ref, targetLanguage: 'spa' });
      await drain(engine);
      const redacted = await engine.createRedactedDerivative(ctx, { representation: rep.ref, redactions: [{ segmentId: seg.id, start: 8, end: 12, reason: 'account number' }] });
      const agent = ctxOf({ actor: { id: 'agent-7', kind: 'agent', roles: [] } });
      await assert.rejects(engine.correctText(agent, { representation: rep.ref, corrections: [{ segmentId: seg.id, text: 'x' }], reason: 'r', expectedRevision: 5 }), code('revision_conflict'));
      const fixed = 'Payment 4417 was approved in March.';
      const out = await engine.correctText(agent, { representation: rep.ref, corrections: [{ segmentId: seg.id, text: fixed }], reason: 'Digits transposed; checked against the scan', expectedRevision: 1, idempotencyKey: 'fix-1' });
      assert.equal(out.revision, 2); assert.equal(out.previousRef, rep.ref); assert.equal(out.representationRef, `E06:representation:${rep.id}@2`); assert.deepEqual(out.segmentIds, [seg.id]);
      assert.deepEqual(await engine.correctText(agent, { representation: rep.ref, corrections: [{ segmentId: seg.id, text: fixed }], reason: 'Digits transposed; checked against the scan', expectedRevision: 1, idempotencyKey: 'fix-1' }), out);
      const v1 = await engine.getRepresentation(ctx, `E06:representation:${rep.id}@1`);
      const v2 = await engine.getRepresentation(ctx, rep.id);
      assert.equal(v1.segments[1]?.text, KNOWN.scan2); assert.equal(v1.segments[1]?.corrected, false); assert.equal(v1.revision, 1);
      assert.equal(v2.segments[1]?.text, fixed); assert.equal(v2.segments[1]?.corrected, true); assert.equal(v2.segments[1]?.id, seg.id, 'segment ids are stable');
      assert.equal(v2.segments[1]?.confidence, null, 'a human/agent correction carries no machine confidence');
      const word = v2.segments[1]?.words?.find((w) => w.t === '4417');
      assert.ok(word?.b && word.c === null, 'corrected word keeps its box, loses machine confidence');
      assert.equal(v2.segments[0]?.textRevision, 1); assert.equal(v2.segments[1]?.textRevision, 2);
      const revs = await engine.listRevisions(ctx, rep.id);
      assert.deepEqual(revs.map((r) => [r.revision, r.actorKind]), [[1, 'human'], [2, 'agent']]);
      assert.equal(revs[1]?.actorId, 'agent-7'); assert.match(revs[1]?.reason ?? '', /transposed/); assert.notEqual(revs[0]?.textSha256, revs[1]?.textSha256);
      // search follows the current revision only
      assert.equal((await engine.searchSegments(ctx, { q: '4417', evidenceRef: scan.info.ref })).length, 1);
      assert.equal((await engine.searchSegments(ctx, { q: '4471', evidenceRef: scan.info.ref, kinds: ['text'] })).length, 0);
      const corrected = (await engine.searchSegments(ctx, { q: '4417', evidenceRef: scan.info.ref }))[0];
      assert.equal(corrected?.corrected, true); assert.equal(corrected?.representationRef, out.representationRef);
      // event: root of the correction chain
      const ev = (await engine.events(ctx)).filter((e) => e.type === 'processing.text_corrected');
      assert.equal(ev.length, 1); assert.equal(ev[0]?.subject, out.representationRef);
      const payload = ev[0]?.payload as { evidenceRef: string; representationRef: string; previousRef: string; segmentIds: string[]; stale: string[] };
      assert.equal(payload.evidenceRef, scan.info.ref); assert.equal(payload.representationRef, out.representationRef); assert.equal(payload.previousRef, rep.ref); assert.deepEqual(payload.segmentIds, [seg.id]);
      // dependents: the translation of revision 1 and the redacted copy are stale, with reasons, and say so in inspect
      const translation = (await engine.getProcessing(ctx, translated.processingId)).representations.map((r) => r).find((r) => !r.startsWith(`E06:representation:${rep.id}`)) as string;
      assert.ok(out.staled.includes(translation)); assert.ok(out.staled.includes(redacted.ref));
      const tv = await engine.getRepresentation(ctx, translation);
      assert.equal(tv.stale, true); assert.match(tv.reasons[0] ?? '', /source text corrected/); assert.equal(tv.sourceRef, rep.ref);
      const insp = await engine.inspect(ctx, translation);
      assert.equal(insp?.stale, true); assert.equal(insp?.state, 'stale'); assert.ok(insp?.sources.includes(rep.ref));
      assert.ok((await engine.events(ctx)).some((e) => e.type === 'processing.stale' && e.subject === translation && (e.payload as { cause: string }).cause === out.representationRef));
      const ri = await engine.inspect(ctx, out.representationRef);
      assert.deepEqual(ri?.versions.map((v) => v.revision), [1, 2]); assert.ok(ri?.dependents.includes(translation)); assert.ok(ri?.history.some((h) => h.action === 'processing.text_corrected'));
      assert.equal((await engine.inspect(ctx, `E06:representation:${rep.id}@1`))?.ref, rep.ref);
      assert.equal(await engine.inspect(ctx, `E06:representation:${rep.id}@9`), null);
      await assert.rejects(engine.correctText(ctx, { representation: rep.ref, corrections: [{ segmentId: pdf.rep.segments[0]?.id as string, text: 'x' }], reason: 'wrong representation' }), code('invalid_input'));
      // correcting a translation is a translation revision
      const tfix = await engine.correctText(ctx, { representation: translation, corrections: [{ segmentId: tv.segments[0]?.id as string, text: 'La auditoría del puerto encontró facturas faltantes.' }], reason: 'Reviewed by a translator' });
      assert.ok((await engine.events(ctx)).some((e) => e.type === 'translation.revised' && e.subject === tfix.representationRef));
      assert.ok(kit.verifyAuditChain(await kit.listAudit(sql, SCHEMA, ctx, { allProjects: true, limit: 1000 })));
    });

    await t.test('local machine translation is a separate representation linked segment by segment', async (st) => {
      const tr = await engine.describeTools(ctx);
      const apertium = tr.translation.find((x) => x.id === 'apertium');
      const txt = await process(f.txt, 'text/plain', 'budget.txt', { translateTo: ['spa'] });
      if (apertium?.available !== true || !(apertium.languages ?? []).includes('eng-spa')) {
        assert.equal(stepState(txt.proc, 'translate:spa'), 'unavailable'); assert.equal(txt.proc.state, 'partial');
        st.diagnostic('apertium eng-spa is not installed: asserted the explicit unavailable state instead');
        return;
      }
      assert.equal(txt.proc.state, 'done', JSON.stringify(txt.proc.steps));
      assert.equal(txt.proc.representations.length, 2);
      const tv = await engine.getRepresentation(ctx, txt.proc.representations[1] as string);
      assert.equal(tv.kind, 'translation'); assert.equal(tv.machineTranslation, true); assert.equal(tv.language, 'spa'); assert.equal(tv.sourceRef, txt.rep.ref);
      assert.match(tv.label, /Machine translation eng→spa \(local apertium \d/);
      assert.deepEqual(tv.engine, { id: 'apertium', version: (tv.engine as { version: string }).version, model: 'eng-spa', local: true, sourceLanguage: 'eng', targetLanguage: 'spa' });
      assert.deepEqual(tv.segments.map((s) => s.sourceSegmentId), txt.rep.segments.map((s) => s.id));
      assert.match(tv.segments[0]?.text ?? '', /consejo aprobó el presupuesto/i);
      assert.equal((await engine.getRepresentation(ctx, txt.rep.ref)).segments[0]?.text, KNOWN.english, 'the source text is untouched');
      assert.ok((await engine.events(ctx)).some((e) => e.type === 'translation.completed' && e.subject === tv.ref));
      const hits = await engine.searchSegments(ctx, { q: 'presupuesto' });
      assert.equal(hits[0]?.machineTranslation, true); assert.equal(hits[0]?.language, 'spa');
      // a pair that is not installed is an explicit unavailable state
      const none = await engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'ukr' });
      await drain(engine);
      const step = (await engine.getProcessing(ctx, none.processingId)).steps.find((s) => s.id === none.stepId);
      assert.equal(step?.state, 'unavailable'); assert.match(step?.error ?? '', /No local translation engine supports eng-ukr/);
    });

    await t.test('external transmission is forbidden by default; allowed providers work; secrets never leak', async () => {
      const txt = await process(f.txt, 'text/plain', 'policy.txt');
      assert.deepEqual(await engine.getPolicy(ctx), { externalTransmission: 'forbidden', allowedProviders: [], languages: [], revision: 0 });
      const before = provider.requests.length;
      await assert.rejects(engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'fra', provider: 'lt' }), code('policy_denied'));
      await assert.rejects(engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'fra', provider: 'nobody' }), code('unavailable'));
      const inPipeline = await process(f.txt, 'text/plain', 'policy2.txt', { translateTo: ['fra'], translationProvider: 'lt' });
      assert.equal(stepState(inPipeline.proc, 'translate:fra'), 'denied'); assert.equal(inPipeline.proc.state, 'partial'); assert.equal(inPipeline.proc.representations.length, 1);
      assert.equal(provider.requests.length, before, 'nothing was transmitted while forbidden');
      const denied = (await engine.audit(ctx, { limit: 1000 })).filter((a) => a.action === 'processing.policy_denied');
      assert.equal(denied.length, 2); assert.deepEqual((denied[0]?.detail as { provider: string }).provider, 'lt');
      await assert.rejects(engine.setPolicy(ctxOf({ capabilities: ['processing:read', 'processing:write'] }), { externalTransmission: 'allowed' }), code('forbidden'));
      const policy = await engine.setPolicy(ctx, { externalTransmission: 'allowed', allowedProviders: ['lt'], languages: ['eng'] });
      assert.equal(policy.revision, 1);
      await assert.rejects(engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'fra', provider: 'llm' }), code('policy_denied'));
      const ok = await engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'fra', provider: 'lt' });
      await drain(engine);
      const proc = await engine.getProcessing(ctx, ok.processingId);
      assert.equal(proc.steps.find((s) => s.id === ok.stepId)?.state, 'done', JSON.stringify(proc.steps));
      const tv = await engine.getRepresentation(ctx, proc.representations.at(-1) as string);
      assert.equal(tv.segments[0]?.text, `[fr] ${KNOWN.english}`); assert.match(tv.label, /external lt/); assert.equal((tv.engine as { local: boolean }).local, false);
      const sent = provider.requests.at(-1);
      assert.equal(sent?.path, '/translate'); assert.match(sent?.body ?? '', new RegExp(SECRET)); assert.match(sent?.body ?? '', /"source":"en","target":"fr"/);
      await engine.setPolicy(ctx, { externalTransmission: 'allowed', allowedProviders: ['lt', 'llm', 'badllm'], languages: ['eng'] });
      const llm = await engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'deu', provider: 'llm' });
      const bad = await engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'por', provider: 'badllm' });
      await drain(engine);
      const after = await engine.getProcessing(ctx, llm.processingId);
      assert.equal(after.steps.find((s) => s.id === llm.stepId)?.state, 'done');
      assert.equal(provider.requests.find((r) => r.path === '/v1/chat/completions')?.authorization, `Bearer ${SECRET}`);
      const badStep = after.steps.find((s) => s.id === bad.stepId);
      assert.equal(badStep?.state, 'failed'); assert.match(badStep?.error ?? '', /provider_invalid_response/);
      assert.ok(!after.representations.some((r) => /Ignore the task/.test(r)));
      // the provider secret appears nowhere in stored state
      for (const table of ['_audit', '_events', '_jobs', 'step', 'representation', 'observation', 'derivative', 'policy']) {
        const dump = JSON.stringify(await sql.query(`select * from ${SCHEMA}.${table}`));
        assert.ok(!dump.includes(SECRET), `secret leaked into ${table}`);
      }
      assert.ok(!JSON.stringify(await engine.describeTools(ctx)).includes(SECRET));
      await engine.setPolicy(ctx, { externalTransmission: 'forbidden' });
      await assert.rejects(engine.requestTranslation(ctx, { representation: txt.rep.ref, targetLanguage: 'ita', provider: 'lt' }), code('policy_denied'));
    });

    await t.test('redacted derivatives are offset- and region-based working copies pinned to a revision', async () => {
      const rep = await engine.getRepresentation(ctx, pdf.rep.ref);
      const line = rep.segments.find((s) => s.text === KNOWN.pdfLine2) as RepresentationView['segments'][number];
      const harbor = rep.segments.find((s) => s.text === KNOWN.pdfLine1)?.words?.find((w) => w.t === 'harbor')?.b as number[];
      const d = await engine.createRedactedDerivative(ctx, { representation: rep.ref, redactions: [
        { segmentId: line.id, start: KNOWN.pdfLine2.indexOf('4471'), end: KNOWN.pdfLine2.indexOf('4471') + 4, reason: 'invoice number' },
        { page: 1, bbox: [harbor[0] as number + 1, harbor[1] as number + 1, harbor[2] as number - 1, harbor[3] as number - 1], reason: 'location' },
      ], idempotencyKey: 'redact-1' });
      assert.equal(d.kind, 'redacted_text'); assert.equal(d.representationRef, rep.ref); assert.match(d.evidenceDerivativeRef ?? '', /^E05:/);
      const doc = JSON.parse(Buffer.from((await engine.getDerivativeBytes(ctx, d.id)).bytes).toString('utf8')) as { text: string; segments: { segmentId: string; text: string; bbox: unknown; redacted: boolean }[]; representationRef: string };
      assert.ok(!doc.text.includes('4471') && !doc.text.includes('harbor'));
      assert.match(doc.text, /First paragraph about the \[REDACTED\] audit\./); assert.match(doc.text, /Second paragraph mentions invoice \[REDACTED\]\./);
      assert.equal(doc.segments.find((s) => s.segmentId === line.id)?.bbox, null); assert.equal(doc.representationRef, rep.ref);
      assert.equal((await engine.getRepresentation(ctx, rep.ref)).segments.find((s) => s.id === line.id)?.text, KNOWN.pdfLine2, 'the unredacted representation is unchanged');
      assert.equal(evidence.derivatives(pdf.info.ref).filter((x) => x.relation === 'redacted_text').length, 1);
      await assert.rejects(engine.createRedactedDerivative(ctx, { representation: rep.ref, redactions: [{ segmentId: line.id, start: 5, end: 500, reason: 'r' }] }), code('invalid_input'));
      assert.ok((await engine.events(ctx)).some((e) => e.type === 'processing.redacted' && e.subject === d.ref));
    });

    await t.test('searchable exports carry anchors and honest labels', async () => {
      const txt = await engine.exportSearchable(ctx, { representation: pdf.rep.ref, format: 'txt' });
      const body = Buffer.from(txt.bytes).toString('utf8');
      assert.match(body, /^# Text layer extracted from PDF\. Source E05:evidence_version:.*Machine-produced; not verified\./); assert.match(body, /\[p\.1\] First paragraph/);
      const json = JSON.parse(Buffer.from((await engine.exportSearchable(ctx, { representation: pdf.rep.ref, format: 'json' })).bytes).toString('utf8')) as RepresentationView;
      assert.equal(json.ref, pdf.rep.ref); assert.ok(json.segments[0]?.words?.[0]?.b);
      await assert.rejects(engine.exportSearchable(ctx, { representation: pdf.rep.ref, format: 'vtt' }), code('invalid_input'));
      await assert.rejects(engine.exportSearchable(ctxOf({ capabilities: ['processing:*'] }), { representation: pdf.rep.ref, format: 'txt' }), code('forbidden'));
    });

    await t.test('authorization fails closed; other tenants, projects and compartments see nothing', async () => {
      await assert.rejects(engine.getProcessing(undefined as unknown as kit.ServiceContext, pdf.proc.id), code('unauthenticated'));
      const none = ctxOf({ capabilities: [] });
      for (const call of [() => engine.getProcessing(none, pdf.proc.id), () => engine.searchSegments(none, { q: 'harbor' }), () => engine.requestProcessing(none, { evidenceRef: pdf.info.ref }), () => engine.correctText(none, { representation: pdf.rep.ref, corrections: [], reason: 'x' }), () => engine.events(ctxOf({ capabilities: ['processing:*'] })), () => engine.listJobs(ctxOf({ capabilities: ['processing:read', 'processing:write'] })), () => engine.inspect(none, pdf.rep.ref), () => engine.audit(none), () => engine.applyUpstreamChange(none, { eventId: 'e', kind: 'source_removed', refs: [], reason: 'x' })]) await assert.rejects(call(), code('forbidden'));
      await assert.rejects(engine.correctText(ctxOf({ capabilities: ['processing:read'] }), { representation: pdf.rep.ref, corrections: [{ segmentId: pdf.rep.segments[0]?.id as string, text: 'x' }], reason: 'x' }), code('forbidden'));
      const thumb = (await engine.listDerivatives(ctx, pdf.proc.id))[0] as { id: string; ref: string };
      for (const other of [ctxOf({ tenantId: 't2' }), ctxOf({ projectId: 'p2' })]) {
        await assert.rejects(engine.getProcessing(other, pdf.proc.id), code('not_found'));
        await assert.rejects(engine.getRepresentation(other, pdf.rep.ref), code('not_found'));
        await assert.rejects(engine.getAlignment(other, pdf.proc.id), code('not_found'));
        await assert.rejects(engine.listRevisions(other, pdf.rep.id), code('not_found'));
        await assert.rejects(engine.locate(other, pdf.rep.ref, { page: 1, x: 100, y: 100 }), code('not_found'));
        await assert.rejects(engine.listObservations(other, pdf.proc.id), code('not_found'));
        await assert.rejects(engine.listDerivatives(other, pdf.proc.id), code('not_found'));
        await assert.rejects(engine.getDerivativeBytes(other, thumb.id), code('not_found'));
        await assert.rejects(engine.exportSearchable(other, { representation: pdf.rep.ref, format: 'txt' }), code('not_found'));
        await assert.rejects(engine.correctText(other, { representation: pdf.rep.ref, corrections: [{ segmentId: pdf.rep.segments[0]?.id as string, text: 'x' }], reason: 'x' }), code('not_found'));
        await assert.rejects(engine.requestTranslation(other, { representation: pdf.rep.ref, targetLanguage: 'spa' }), code('not_found'));
        await assert.rejects(engine.createRedactedDerivative(other, { representation: pdf.rep.ref, redactions: [{ segmentId: pdf.rep.segments[0]?.id as string, reason: 'x' }] }), code('not_found'));
        await assert.rejects(engine.cancelProcessing(other, pdf.proc.id), code('not_found'));
        await assert.rejects(engine.requestProcessing(other, { evidenceRef: pdf.info.ref }), code('not_found'));
        assert.deepEqual(await engine.listProcessing(other), []);
        assert.deepEqual(await engine.searchSegments(other, { q: 'harbor' }), []);
        assert.deepEqual(await engine.search(other, { q: 'harbor OR invoice OR paragraph' }), []);
        assert.equal(await engine.inspect(other, pdf.rep.ref), null); assert.equal(await engine.inspect(other, pdf.proc.ref), null); assert.equal(await engine.inspect(other, thumb.ref), null);
        assert.deepEqual(await engine.audit(other), []);
        assert.deepEqual(await engine.listJobs(other), []);
        assert.deepEqual((await engine.applyUpstreamChange(other, { eventId: 'iso-1', kind: 'source_removed', refs: [pdf.info.ref], reason: 'x' })).affected, []);
      }
      assert.deepEqual(await engine.events(ctxOf({ tenantId: 't2' })), []);
      assert.equal((await engine.getProcessing(ctx, pdf.proc.id)).blocked, false, 'another tenant cannot block this tenant\'s records');
      const keys = await objects.list('');
      assert.ok(keys.length > 5 && keys.every((k) => k.startsWith('t1/p1/')), 'object keys start with tenant/project');
      const jobs = await engine.listJobs(ctx);
      assert.ok(jobs.length > 0 && jobs.every((j) => j.tenantId === 't1' && j.ctx.capabilities.length === 0));
      // compartments
      const secretCtx = ctxOf({ compartments: ['sources'] });
      const info = await put(f.txt, 'text/plain', 'confidential.txt', secretCtx, 'sources');
      await assert.rejects(engine.requestProcessing(ctx, { evidenceRef: info.ref }), code('not_found'));
      const hidden = await settle(engine, secretCtx, (await engine.requestProcessing(secretCtx, { evidenceRef: info.ref, languages: ['eng', 'spa'] })).id);
      assert.equal((await engine.searchSegments(secretCtx, { q: 'council', evidenceRef: info.ref })).length, 1);
      assert.equal((await engine.searchSegments(ctx, { q: 'council', evidenceRef: info.ref })).length, 0);
      await assert.rejects(engine.getProcessing(ctx, hidden.id), code('not_found'));
      await assert.rejects(engine.getRepresentation(ctx, hidden.representations[0] as string), code('not_found'));
      assert.equal(await engine.inspect(ctx, hidden.representations[0] as string), null);
      assert.ok(!(await engine.listProcessing(ctx)).some((p) => p.id === hidden.id));
    });

    await t.test('use decisions and authorization are consulted; absent port denies unless standalone mode is selected', async () => {
      const strict = createEngine({ sql, objects, ports: { evidence }, config: { tempRoot: work } });
      await assert.rejects(strict.requestProcessing(ctx, { evidenceRef: pdf.info.ref, languages: ['ukr'] }), code('consent_denied'));
      let verdict: 'allow' | 'deny' | 'review' = 'deny';
      const asked: { subjects: readonly string[]; action: string; destination?: string }[] = [];
      const useDecisions: kit.UseDecisionPort = { async decide(_c, r) { asked.push({ subjects: r.subjects, action: r.action, ...(r.destination === undefined ? {} : { destination: r.destination }) }); return { decision: verdict, reasons: ['test verdict'], permissionRefs: [], restrictions: [], decidedAt: new Date().toISOString() }; } };
      let authz = true;
      const authorization: kit.AuthorizationPort = { async authorize() { return { allowed: authz, reason: authz ? 'ok' : 'revoked', policyVersion: '1' }; } };
      const governed = createEngine({ sql, objects, ports: { evidence, useDecisions, authorization }, config: { tempRoot: work } });
      const info = await put(Buffer.from('The archive opens on Tuesday.\n'), 'text/plain', 'governed.txt');
      await assert.rejects(governed.requestProcessing(ctx, { evidenceRef: info.ref }), code('consent_denied'));
      verdict = 'review';
      await assert.rejects(governed.requestProcessing(ctx, { evidenceRef: info.ref }), code('consent_denied'));
      assert.deepEqual(asked[0], { subjects: [info.ref], action: 'process' });
      verdict = 'allow'; authz = false;
      await assert.rejects(governed.requestProcessing(ctx, { evidenceRef: info.ref }), code('forbidden'));
      authz = true;
      const requested = await governed.requestProcessing(ctx, { evidenceRef: info.ref });
      // the decision is re-checked inside the worker: a denial after the request blocks processing and its outputs
      verdict = 'deny';
      await drain(governed);
      const blocked = await governed.getProcessing(ctx, requested.id);
      assert.equal(blocked.blocked, true); assert.equal(blocked.state, 'cancelled'); assert.equal(blocked.representations.length, 0);
      assert.ok((await governed.events(ctx)).some((e) => e.type === 'processing.blocked' && e.subject === blocked.ref));
      assert.equal((await governed.inspect(ctx, blocked.ref))?.blocked, true);
    });

    await t.test('jobs resume after a crash, tolerate unreleased evidence, detect tampering, and can be paused', async () => {
      const info = await put(Buffer.from('Resume test: the ledger lists seventeen payments.\n'), 'text/plain', 'resume.txt');
      const requested = await engine.requestProcessing(ctx, { evidenceRef: info.ref });
      assert.equal(await engine.runJobs({ worker: 'w1', limit: 1 }), 1); // plan
      // a worker leases the metadata step and dies without settling it
      const leased = await kit.leaseJobs(sql, SCHEMA, { worker: 'crashed-worker', kinds: ['processing.step'], leaseMs: 60 });
      assert.equal(leased.length, 1);
      assert.equal(await engine.runJobs({ worker: 'w2' }), 0, 'the lease is still held');
      await new Promise((r) => setTimeout(r, 120));
      const done = await settle(engine, ctx, requested.id);
      assert.equal(done.state, 'done', JSON.stringify(done.steps)); assert.equal(done.representations.length, 1);
      await assert.rejects(kit.completeJob(sql, SCHEMA, leased[0] as kit.Job, { late: true }), code('lease_lost'));
      assert.equal((await engine.listObservations(ctx, done.id, { kind: 'metadata' })).length, 1, 'the re-run did not duplicate outputs');
      const job = (await engine.listJobs(ctx)).find((j) => j.id === done.steps[0]?.jobId);
      assert.equal(job?.attempts, 2);
      // a step replayed after completion changes nothing
      await sql.query(`update ${SCHEMA}._jobs set state='queued', run_at=now() where id=$1`, [done.steps[1]?.jobId]);
      await drain(engine);
      assert.equal((await engine.getProcessing(ctx, done.id)).representations.length, 1);
      assert.equal((await engine.events(ctx, { limit: 1000 })).filter((e) => e.type === 'processing.completed' && e.subject === done.ref).length, 1);

      // evidence that has not been released by the evidence engine yet: the plan waits and retries
      const quarantined = evidenceDouble({ quarantineNew: true });
      const q = createEngine({ sql, objects, ports: { evidence: quarantined }, config });
      const pending = await quarantined.accept(ctx, { bytes: Buffer.from('Released later: the tender closed in June.\n'), mediaType: 'text/plain', filename: 'later.txt', origin: {} });
      assert.equal(pending.available, false);
      const waiting = await q.requestProcessing(ctx, { evidenceRef: pending.ref });
      await q.runJobs({ worker: 'w' });
      assert.equal((await q.getProcessing(ctx, waiting.id)).state, 'queued');
      assert.equal(quarantined.calls.getBytes, 0);
      quarantined.release(pending.ref);
      await sql.query(`update ${SCHEMA}._jobs set run_at=now() where state='queued'`);
      assert.equal((await settle(q, ctx, waiting.id)).state, 'done');

      // bytes that no longer match the recorded digest are refused
      const tampered = await put(Buffer.from('Original wording of the notice.\n'), 'text/plain', 'tamper.txt');
      const tp = await engine.requestProcessing(ctx, { evidenceRef: tampered.ref });
      evidence.corrupt(tampered.ref);
      const failed = await settle(engine, ctx, tp.id);
      assert.equal(failed.state, 'failed'); assert.match(failed.failure ?? '', /digest/);

      // pause/resume through the operator control
      const pausedInfo = await put(Buffer.from('Paused text about a bridge inspection.\n'), 'text/plain', 'pause.txt');
      const pp = await engine.requestProcessing(ctx, { evidenceRef: pausedInfo.ref });
      const planJob = (await engine.listJobs(ctx, { states: ['queued'] }))[0] as kit.Job;
      assert.equal((await engine.controlJob(ctx, planJob.id, 'pause')).state, 'paused');
      assert.equal(await engine.runJobs({ worker: 'w' }), 0);
      await engine.controlJob(ctx, planJob.id, 'resume');
      assert.equal((await settle(engine, ctx, pp.id)).state, 'done');
      // retry of a failed record re-queues only the failed work
      await assert.rejects(engine.retryProcessing(ctx, pp.id), code('invalid_state'));
    });

    await t.test('upstream changes: new evidence version marks outputs stale and reprocesses; withdrawal blocks; idempotent by event', async () => {
      const first = await process(Buffer.from('The contract value was nine million.\n'), 'text/plain', 'contract.txt');
      const derived = await engine.createRedactedDerivative(ctx, { representation: first.rep.ref, redactions: [{ segmentId: first.rep.segments[0]?.id as string, start: 23, end: 27, reason: 'amount' }] });
      const v2 = evidence.addVersion(ctx, first.info.evidenceId, Buffer.from('The contract value was eleven million.\n'));
      assert.equal(v2.revision, 2);
      // a change that names only an older or unrelated version does nothing
      assert.deepEqual((await engine.applyUpstreamChange(ctx, { eventId: 'evt-0', kind: 'source_superseded', refs: ['E05:evidence_version:00000000-0000-4000-8000-000000000000@1'], reason: 'unrelated' })).affected, []);
      const change: kit.UpstreamChange = { eventId: 'evt-1', kind: 'source_superseded', refs: [v2.ref], reason: 'A corrected copy was published' };
      const out = await engine.applyUpstreamChange(ctx, change);
      assert.deepEqual([...out.affected].sort(), [first.proc.ref, first.rep.ref, derived.ref].sort());
      assert.deepEqual(await engine.applyUpstreamChange(ctx, change), out, 'replay returns the same result');
      const stale = (await engine.events(ctx, { limit: 1000 })).filter((e) => e.type === 'processing.stale' && (e.payload as { cause: string }).cause === 'evt-1');
      assert.equal(stale.length, 3);
      const old = await engine.getRepresentation(ctx, first.rep.ref);
      assert.equal(old.stale, true); assert.deepEqual(old.reasons, ['A corrected copy was published']); assert.equal(old.segments[0]?.text, 'The contract value was nine million.', 'old output is kept, not rewritten');
      const insp = await engine.inspect(ctx, first.proc.ref);
      assert.equal(insp?.stale, true); assert.deepEqual(insp?.staleReasons, ['A corrected copy was published']);
      assert.equal((await engine.searchSegments(ctx, { q: 'contract nine' }))[0]?.stale, true);
      // reprocessing of the new version was enqueued with the same options
      const queued = (await engine.listProcessing(ctx, { evidenceRef: v2.ref }))[0] as ProcessingView;
      assert.equal(queued.state, 'queued');
      const fresh = await settle(engine, ctx, queued.id);
      assert.equal(fresh.state, 'done'); assert.equal(fresh.evidenceRef, v2.ref);
      assert.equal((await engine.getRepresentation(ctx, fresh.representations[0] as string)).segments[0]?.text, 'The contract value was eleven million.');
      assert.equal((await engine.searchSegments(ctx, { q: 'eleven million' }))[0]?.stale, false);
      assert.equal((await engine.listProcessing(ctx, { evidenceRef: v2.ref })).length, 1);

      // permission withdrawal blocks outputs and any further processing of that evidence
      const withdrawn = await engine.applyUpstreamChange(ctx, { eventId: 'evt-2', kind: 'permission_withdrawn', refs: [`E05:evidence:${first.info.evidenceId}`], reason: 'The contributor withdrew permission' });
      assert.ok(withdrawn.affected.includes(first.proc.ref) && withdrawn.affected.includes(fresh.ref) && withdrawn.affected.includes(derived.ref));
      assert.deepEqual((await engine.applyUpstreamChange(ctx, { eventId: 'evt-2', kind: 'permission_withdrawn', refs: [`E05:evidence:${first.info.evidenceId}`], reason: 'The contributor withdrew permission' })).affected, withdrawn.affected);
      await assert.rejects(engine.getRepresentation(ctx, fresh.representations[0] as string), code('consent_denied'));
      await assert.rejects(engine.getDerivativeBytes(ctx, derived.id), code('consent_denied'));
      await assert.rejects(engine.getAlignment(ctx, fresh.id), code('consent_denied'));
      await assert.rejects(engine.exportSearchable(ctx, { representation: fresh.representations[0] as string, format: 'txt' }), code('consent_denied'));
      await assert.rejects(engine.correctText(ctx, { representation: fresh.representations[0] as string, corrections: [{ segmentId: first.rep.segments[0]?.id as string, text: 'x' }], reason: 'x' }), code('consent_denied'));
      assert.deepEqual(await engine.searchSegments(ctx, { q: 'million' }), []);
      const bi = await engine.inspect(ctx, fresh.representations[0] as string);
      assert.equal(bi?.blocked, true); assert.equal(bi?.state, 'blocked'); assert.ok(bi?.staleReasons.includes('The contributor withdrew permission')); assert.deepEqual(bi?.data, { blocked: true, kind: 'text' });
      await assert.rejects(engine.requestProcessing(ctx, { evidenceRef: v2.ref, force: true }), code('consent_denied'));
      await assert.rejects(engine.requestProcessing(ctx, { evidenceRef: first.info.ref, languages: ['eng'] }), code('consent_denied'));
      assert.ok((await engine.events(ctx, { limit: 1000 })).some((e) => e.type === 'processing.blocked' && e.subject === fresh.ref && (e.payload as { cause: string }).cause === 'evt-2'));
      // withdrawal while work is queued cancels it before any tool runs
      const pendingInfo = await put(Buffer.from('Queued text that must not be processed.\n'), 'text/plain', 'queued.txt');
      const pending = await engine.requestProcessing(ctx, { evidenceRef: pendingInfo.ref });
      await engine.applyUpstreamChange(ctx, { eventId: 'evt-3', kind: 'permission_withdrawn', refs: [pendingInfo.ref], reason: 'Withdrawn before processing' });
      const calls = evidence.calls.getBytes;
      await drain(engine);
      const cancelled = await engine.getProcessing(ctx, pending.id);
      assert.equal(cancelled.blocked, true); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.representations.length, 0); assert.equal(evidence.calls.getBytes, calls);
    });

    await t.test('HTTP API: catalog routes, bearer auth, tenant scoping and policy refusals', async () => {
      const key = kit.generateSigningKey('k1');
      const now = Math.floor(Date.now() / 1000);
      const token = (tid: string, caps = ['processing:read', 'processing:write', 'evidence:read', 'evidence:write']): string => kit.signAccessToken({ iss: 'iap', sub: 'u-http', kind: 'human', tid, pid: 'p1', roles: [], caps, cmp: [], purpose: 'research', pv: '1', iat: now, exp: now + 600, jti: `j-${tid}` }, key);
      const server = await kit.serve(kit.createHttpHandler({ name: manifest.id, version: manifest.version, routes: routes(engine), verify: kit.createTokenVerifier({ publicKeys: { k1: key.publicKeyPem } }), health: () => engine.health() }), 0);
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        assert.equal(((await (await fetch(`${base}/v1/manifest`)).json()) as { id: string }).id, 'E06');
        assert.equal((await fetch(`${base}/v1/processing`)).status, 401);
        const client = kit.engineClient(base, () => token('t1'));
        const info = await put(Buffer.from('The harbour board met on Thursday.\n'), 'text/plain', 'http.txt');
        const created = await fetch(`${base}/v1/processing/jobs`, { method: 'POST', headers: { authorization: `Bearer ${token('t1')}`, 'content-type': 'application/json', 'idempotency-key': 'http-1' }, body: JSON.stringify({ evidenceRef: info.ref }) });
        assert.equal(created.status, 202);
        const proc = await created.json() as ProcessingView;
        await settle(engine, ctx, proc.id);
        const alignment = await client.call<{ representations: RepresentationView[] }>('GET', `/v1/processing/${proc.id}/alignment`);
        const rep = alignment.representations[0] as RepresentationView;
        assert.equal(rep.segments[0]?.text, 'The harbour board met on Thursday.');
        const revised = await client.call<{ revision: number }>('POST', `/v1/transcripts/${rep.id}/revisions`, { corrections: [{ segmentId: rep.segments[0]?.id, text: 'The harbour board met on Tuesday.' }], reason: 'Checked against the minutes' });
        assert.equal(revised.revision, 2);
        assert.equal((await client.call<RepresentationView>('GET', `/v1/representations/${rep.id}?revision=1`)).segments[0]?.text, 'The harbour board met on Thursday.');
        assert.equal((await client.call<unknown[]>('GET', '/v1/segments/search?q=Tuesday')).length, 1);
        assert.equal((await client.call<{ ref: string }>('GET', `/v1/inspect?ref=${encodeURIComponent(rep.ref)}`)).ref, `E06:representation:${rep.id}@1`);
        const other = kit.engineClient(base, () => token('t2'));
        await assert.rejects(other.call('GET', `/v1/processing/${proc.id}/alignment`), code('not_found'));
        await assert.rejects(other.call('GET', `/v1/representations/${rep.id}`), code('not_found'));
        assert.deepEqual(await other.call('GET', '/v1/segments/search?q=harbour'), []);
        await assert.rejects(client.call('GET', '/v1/events'), code('forbidden'));
        await assert.rejects(client.call('PUT', '/v1/policy', { externalTransmission: 'allowed' }), code('forbidden'));
        const refused = await fetch(`${base}/v1/representations/${rep.id}/translations`, { method: 'POST', headers: { authorization: `Bearer ${token('t1')}`, 'content-type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fra', provider: 'lt' }) });
        assert.equal(refused.status, 403); assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'policy_denied');
        assert.equal((await fetch(`${base}/v1/representations/${rep.id}/export?format=txt`, { headers: { authorization: `Bearer ${token('t1')}` } })).status, 403);
        const exported = await fetch(`${base}/v1/representations/${rep.id}/export?format=txt`, { headers: { authorization: `Bearer ${token('t1', ['processing:export'])}` } });
        assert.equal(exported.status, 200); assert.match(await exported.text(), /met on Tuesday/);
      } finally { await new Promise((r) => server.close(r)); }
    });
  });
});

test('E06 engine: audio and video — metadata, speaker segmentation, transcription, adapters', needsPg, async (t) => {
  const f = fixtures();
  const work = mkdtempSync(join(tmpdir(), 'e06-media-'));
  const provider = await fakeProvider();
  t.after(async () => { await provider.close(); rmSync(work, { recursive: true, force: true }); });
  await kit.withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const evidence: EvidenceDouble = evidenceDouble();
    const objects = new kit.FsObjectStore(join(work, 'objects'));
    const base: EngineConfig = { tempRoot: work, standalone: { useDecisions: 'allow' }, defaultLanguages: ['eng'], asr: { providers: { 'remote-asr': { baseUrl: `${provider.url}/v1`, apiKey: SECRET, model: 'whisper-1' } } } };
    const engine = createEngine({ sql, objects, ports: { evidence }, config: base });
    const ctx = ctxOf();
    const run = async (e: ProcessingEngine, c: kit.ServiceContext, bytes: Uint8Array, mediaType: string, filename: string, extra: Record<string, unknown> = {}): Promise<{ info: kit.EvidenceVersionInfo; proc: ProcessingView }> => {
      const info = await evidence.accept(c, { bytes, mediaType, filename, origin: {} });
      const proc = await settle(e, c, (await e.requestProcessing(c, { evidenceRef: info.ref, ...extra })).id);
      return { info, proc };
    };
    const asr = (await engine.describeTools(ctx)).asr.find((a) => a.id === 'pocketsphinx');

    let audio!: Awaited<ReturnType<typeof run>>;
    await t.test('two synthesised voices: ffprobe metadata, ≥2 provisional speakers, real local ASR with timestamps', async (st) => {
      audio = await run(engine, ctx, f.audio, 'audio/wav', 'talk.wav');
      assert.equal(audio.proc.family, 'media');
      const probe = (await engine.listObservations(ctx, audio.proc.id, { kind: 'metadata' })).find((o) => o.tool === 'ffprobe');
      assert.ok(probe); assert.match(probe.caveat ?? '', /forged/);
      const data = probe.data as { durationMs: number; streams: { type: string; sampleRate: number; codec: string }[] };
      assert.ok(data.durationMs > 15_000 && data.durationMs < 30_000); assert.equal(data.streams[0]?.type, 'audio'); assert.equal(data.streams[0]?.codec, 'pcm_s16le');
      // diarization
      assert.equal(stepState(audio.proc, 'diarize'), 'done', JSON.stringify(audio.proc.steps));
      const speakers = await engine.listSpeakers(ctx, audio.proc.id);
      assert.ok(speakers.labels.length >= 2, `speakers: ${JSON.stringify(speakers.labels)}`);
      assert.ok(speakers.labels.every((l) => /^Speaker [A-Z]$/.test(l.label) && l.provisional === true && l.attribution === null));
      assert.ok(speakers.turns.length >= 4 && speakers.turns.every((x) => x.provisional === true && x.endMs > x.startMs));
      // the four spoken stretches alternate A B A B
      const order = speakers.turns.map((x) => x.label).filter((l, i, a) => i === 0 || l !== a[i - 1]);
      assert.deepEqual(order.slice(0, 4), ['Speaker A', 'Speaker B', 'Speaker A', 'Speaker B']);
      const dq = (await engine.listObservations(ctx, audio.proc.id, { kind: 'quality' })).find((o) => (o.data as { scope: string }).scope === 'speaker_segmentation');
      assert.match(dq?.caveat ?? '', /do not identify any person/);
      // waveform preview
      const wave = (await engine.listDerivatives(ctx, audio.proc.id)).find((d) => d.kind === 'waveform');
      assert.ok(wave && isPng((await engine.getDerivativeBytes(ctx, wave.id)).bytes));
      // transcription
      if (asr?.available !== true) {
        assert.equal(stepState(audio.proc, 'transcribe'), 'unavailable');
        assert.match(audio.proc.steps.find((s) => s.name === 'transcribe')?.error ?? '', /No local speech recognition engine is available/);
        assert.equal(audio.proc.state, 'failed');
        st.diagnostic('NO LOCAL ASR INSTALLED: asserted the explicit unavailable state');
        return;
      }
      assert.equal(audio.proc.state, 'done', JSON.stringify(audio.proc.steps));
      const rep = await engine.getRepresentation(ctx, audio.proc.representations[0] as string);
      assert.equal(rep.kind, 'transcript'); assert.equal(rep.machine, true); assert.match(rep.label, /Machine transcript \(local pocketsphinx\)/);
      assert.deepEqual((rep.engine as { id: string; local: boolean }).local, true); assert.match((rep.engine as { version: string }).version, /^\d+\.\d+/);
      const words = rep.segments.flatMap((s) => s.words ?? []);
      const heard = new Set(words.map((w) => w.t.toLowerCase()));
      const overlap = KNOWN.spoken.filter((w) => heard.has(w));
      st.diagnostic(`ASR heard: ${rep.segments.map((s) => s.text).join(' | ')}`);
      assert.ok(overlap.length >= 6, `recognised known words: ${overlap.join(', ')}`);
      assert.ok(words.length >= 20 && words.every((w) => typeof w.s === 'number' && typeof w.e === 'number' && w.e > w.s && typeof w.c === 'number' && w.c >= 0 && w.c <= 1));
      assert.ok(words.every((w, i) => i === 0 || (w.s as number) >= (words[i - 1]?.s as number)), 'word timestamps are monotonic');
      assert.ok((words.at(-1)?.e as number) <= data.durationMs + 500);
      // segments carry provisional speaker labels from both voices and never an identity
      const labels = new Set(rep.segments.map((s) => s.speaker?.label));
      assert.ok(labels.has('Speaker A') && labels.has('Speaker B'));
      assert.ok(rep.segments.every((s) => s.speaker === null || (s.speaker.provisional === true && s.speaker.attribution === null)));
      // media timestamps round-trip to the segment and word
      const target = rep.segments.find((s) => (s.words ?? []).some((w) => w.t === 'meeting')) ?? rep.segments[2] as RepresentationView['segments'][number];
      const w = (target.words ?? []).find((x) => x.t === 'meeting') ?? (target.words ?? [])[0] as { s: number; e: number; t: string };
      const at = await engine.locate(ctx, rep.ref, { ms: ((w.s as number) + (w.e as number)) / 2 });
      assert.equal(at?.segment.id, target.id); assert.equal(at?.word?.t, w.t); assert.equal(at?.evidenceRef, audio.info.ref);
      const hit = (await engine.searchSegments(ctx, { q: w.t, evidenceRef: audio.info.ref }))[0];
      assert.ok(hit && hit.startMs !== null && hit.endMs !== null && hit.startMs <= (w.s as number) && hit.endMs >= (w.e as number)); assert.equal(hit.speaker?.provisional, true);
      const tq = (await engine.listObservations(ctx, audio.proc.id, { kind: 'quality' })).find((o) => (o.data as { scope: string }).scope === 'transcription');
      assert.match((tq?.data as { confidenceKind: string }).confidenceKind, /uncalibrated/);
      assert.ok((rep.quality as { warnings: string[] }).warnings.some((x) => /expect substitutions/.test(x)));
    });

    await t.test('an identity is a separate human-reviewed attribution; the label stays provisional and unverified', async () => {
      const agent = ctxOf({ actor: { id: 'agent-1', kind: 'agent', roles: [] } });
      const input = { processingId: audio.proc.id, label: 'Speaker A', identityRef: 'E07:entity:person-alba-reyes', basis: 'Introduced by name at 00:01 and matches the published agenda' };
      await assert.rejects(engine.attributeSpeaker(agent, input), code('forbidden'));
      await assert.rejects(engine.attributeSpeaker(ctxOf({ capabilities: ['processing:*'] }), input), code('forbidden'));
      await assert.rejects(engine.attributeSpeaker(ctx, { ...input, label: 'Speaker Z' }), code('not_found'));
      await assert.rejects(engine.attributeSpeaker(ctx, { ...input, label: 'Alba Reyes' }), code('invalid_input'));
      const view = await engine.attributeSpeaker(ctx, input);
      assert.equal(view.provisional, true);
      assert.deepEqual({ status: view.attribution?.status, verified: view.attribution?.verified, identityRef: view.attribution?.identityRef, reviewedBy: view.attribution?.reviewedBy }, { status: 'attributed', verified: false, identityRef: input.identityRef, reviewedBy: 'reviewer-1' });
      const labels = (await engine.listSpeakers(ctx, audio.proc.id)).labels;
      assert.equal(labels.find((l) => l.label === 'Speaker A')?.attribution?.verified, false);
      assert.equal(labels.find((l) => l.label === 'Speaker B')?.attribution, null);
      if (audio.proc.representations.length > 0) {
        const rep = await engine.getRepresentation(ctx, audio.proc.representations[0] as string);
        const a = rep.segments.find((s) => s.speaker?.label === 'Speaker A');
        assert.equal(a?.speaker?.provisional, true); assert.equal(a?.speaker?.attribution?.status, 'attributed');
        const vtt = Buffer.from((await engine.exportSearchable(ctx, { representation: rep.ref, format: 'vtt' })).bytes).toString('utf8');
        assert.match(vtt, /^WEBVTT/); assert.match(vtt, /<v Speaker A \(provisional\)>/); assert.doesNotMatch(vtt, /alba/i); assert.match(vtt, /\d\d:\d\d:\d\d\.\d{3} --> /);
      }
      assert.ok((await engine.events(ctx)).some((e) => e.type === 'processing.speaker_attributed' && (e.payload as { verified: boolean }).verified === false));
      assert.deepEqual(await engine.revokeSpeakerAttribution(ctx, { attributionId: view.attribution?.id as string, reason: 'Misheard the introduction' }), { id: view.attribution?.id as string, status: 'revoked' });
      assert.equal((await engine.listSpeakers(ctx, audio.proc.id)).labels.find((l) => l.label === 'Speaker A')?.attribution, null);
      await assert.rejects(engine.revokeSpeakerAttribution(ctxOf({ tenantId: 't2' }), { attributionId: view.attribution?.id as string, reason: 'x' }), code('not_found'));
      await assert.rejects(engine.listSpeakers(ctxOf({ tenantId: 't2' }), audio.proc.id), code('not_found'));
    });

    await t.test('video: stream metadata, poster frame, transcript on the media timebase', async () => {
      const video = await run(engine, ctx, f.video, 'video/mp4', 'clip.mp4');
      assert.equal(video.proc.mediaType, 'video/mp4');
      const probe = (await engine.listObservations(ctx, video.proc.id, { kind: 'metadata' })).find((o) => o.tool === 'ffprobe')?.data as { streams: { type: string; width: number | null; frameRate: string | null }[]; durationMs: number };
      assert.ok(probe.streams.some((s) => s.type === 'video' && s.width === 320 && s.frameRate === '10/1')); assert.ok(probe.streams.some((s) => s.type === 'audio'));
      const ders = await engine.listDerivatives(ctx, video.proc.id);
      const poster = ders.find((d) => d.kind === 'thumbnail');
      assert.ok(poster);
      assert.match(execFileSync('identify', ['-format', '%m %w', '-'], { input: (await engine.getDerivativeBytes(ctx, poster.id)).bytes }).toString(), /^PNG 480$/);
      assert.ok(ders.some((d) => d.kind === 'waveform'));
      if (asr?.available === true) {
        const rep = await engine.getRepresentation(ctx, video.proc.representations[0] as string);
        assert.equal(rep.kind, 'transcript');
        assert.ok(rep.segments.every((s) => s.startMs !== null && s.endMs !== null && (s.endMs as number) <= probe.durationMs + 500));
        assert.match((rep.quality as { timebase: string }).timebase, /milliseconds from the start/);
      }
    });

    await t.test('supplied captions are imported literally and bound to the media version', async () => {
      const media = await evidence.accept(ctx, { bytes: f.video, mediaType: 'video/mp4', filename: 'clip2.mp4', origin: {} });
      const caps = await run(engine, ctx, f.vtt, 'text/vtt', 'clip.vtt', { captionsFor: media.ref });
      assert.equal(caps.proc.state, 'done', JSON.stringify(caps.proc.steps));
      const rep = await engine.getRepresentation(ctx, caps.proc.representations[0] as string);
      assert.equal(rep.kind, 'captions'); assert.equal(rep.machine, false); assert.match(rep.label, /unverified wording and timing/);
      assert.deepEqual(rep.segments.map((s) => [s.startMs, s.endMs, s.text]), [[500, 2000, 'One two three four five.'], [2200, 3900, 'This is a test of the system.']]);
      assert.equal((await engine.locate(ctx, rep.ref, { ms: 2500 }))?.segment.text, 'This is a test of the system.');
      assert.ok((await engine.inspect(ctx, rep.ref))?.sources.includes(media.ref));
      // captions that run past the end of the media are rejected, not clipped
      const long = await run(engine, ctx, Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:09:00.000\nToo long.\n'), 'text/vtt', 'long.vtt', { captionsFor: media.ref });
      assert.equal(long.proc.state, 'failed'); assert.match(long.proc.failure ?? '', /Caption import rejected/);
    });

    await t.test('external ASR is refused while policy forbids transmission and used once it is allowed', async () => {
      const before = provider.requests.length;
      const denied = await run(engine, ctx, f.audio, 'audio/wav', 'remote1.wav', { asrProvider: 'remote-asr', steps: ['transcribe'] });
      assert.equal(stepState(denied.proc, 'transcribe'), 'denied'); assert.equal(denied.proc.state, 'failed'); assert.equal(denied.proc.representations.length, 0);
      assert.equal(provider.requests.length, before);
      assert.ok((await engine.audit(ctx, { limit: 1000 })).some((a) => a.action === 'processing.policy_denied' && (a.detail as { operation: string }).operation === 'transcribe'));
      await engine.setPolicy(ctx, { externalTransmission: 'allowed', allowedProviders: ['remote-asr'] });
      const allowed = await engine.retryProcessing(ctx, denied.proc.id);
      assert.equal(allowed.state, 'running');
      const done = await settle(engine, ctx, denied.proc.id);
      assert.equal(done.state, 'done', JSON.stringify(done.steps));
      const rep = await engine.getRepresentation(ctx, done.representations[0] as string);
      assert.match(rep.label, /external remote-asr/); assert.deepEqual(rep.segments.flatMap((s) => (s.words ?? []).map((w) => w.t)), ['remote', 'words', 'here']);
      assert.equal(rep.segments[0]?.words?.[0]?.c, null, 'no confidence is invented when the provider gives none');
      const sent = provider.requests.find((r) => r.path === '/v1/audio/transcriptions');
      assert.equal(sent?.authorization, `Bearer ${SECRET}`); assert.match(sent?.body ?? '', /name="model"\r\n\r\nwhisper-1/); assert.match(sent?.body ?? '', /RIFF/);
      assert.ok((await engine.audit(ctx, { limit: 1000 })).some((a) => a.action === 'processing.external_transmission_allowed'));
      assert.ok(!JSON.stringify(await sql.query(`select * from ${SCHEMA}._audit`)).includes(SECRET));
      await engine.setPolicy(ctx, { externalTransmission: 'forbidden' });
    });

    await t.test('whisper command adapter is used automatically when a binary and model are configured (fake binary; parser contract only)', async () => {
      const fake = fakeWhisper(work);
      const c2 = ctxOf({ projectId: 'p-whisper' });
      const w = createEngine({ sql, objects, ports: { evidence }, config: { ...base, asr: { whisper: { kind: 'whisper.cpp', binary: fake.binary, model: fake.model } } } });
      const out = await run(w, c2, f.audio, 'audio/wav', 'w.wav', { steps: ['transcribe'] });
      assert.equal(out.proc.state, 'done', JSON.stringify(out.proc.steps));
      const rep = await w.getRepresentation(c2, out.proc.representations[0] as string);
      assert.equal((rep.engine as { id: string }).id, 'whisper.cpp');
      assert.deepEqual(rep.segments.flatMap((s) => (s.words ?? []).map((x) => [x.t, x.s, x.e, x.c])), [['Fake', 100, 400, 0.91], ['whisper', 450, 900, 0.6], ['output.', 950, 1500, 0.77]]);
      const missing = createEngine({ sql, objects, ports: { evidence }, config: { ...base, asr: { pocketsphinx: false, whisper: { kind: 'whisper.cpp', binary: fake.binary, model: join(work, 'absent.bin') } } } });
      const c3 = ctxOf({ projectId: 'p-none' });
      const none = await run(missing, c3, f.audio, 'audio/wav', 'n.wav', { steps: ['transcribe'] });
      assert.equal(stepState(none.proc, 'transcribe'), 'unavailable'); assert.equal(none.proc.state, 'failed');
      assert.match(none.proc.steps[0]?.error ?? '', /whisper\.cpp: missing model/);
      assert.equal((await missing.describeTools(c3)).asr[0]?.available, false);
    });

    await t.test('a running step is stopped when its processing is cancelled', async () => {
      const info = await evidence.accept(ctx, { bytes: f.audio, mediaType: 'audio/wav', filename: 'cancel.wav', origin: {} });
      const p = await engine.requestProcessing(ctx, { evidenceRef: info.ref, steps: ['diarize', 'transcribe'], languages: ['eng', 'auto'] });
      await engine.runJobs({ worker: 'w' }); // plan
      const running = engine.runJobs({ worker: 'w' });
      await new Promise((r) => setTimeout(r, 150));
      const cancelled = await engine.cancelProcessing(ctx, p.id, { reason: 'operator stop' });
      assert.equal(cancelled.state, 'cancelled');
      await running; await drain(engine);
      const after = await engine.getProcessing(ctx, p.id);
      assert.equal(after.state, 'cancelled'); assert.equal(after.representations.length, 0);
      assert.ok(after.steps.every((s) => s.state === 'cancelled' || s.state === 'done'));
      assert.deepEqual(readdirSync(work).filter((n) => n.startsWith('e06-')), []);
    });
    assert.ok(has('ffmpeg'));
  });
});
