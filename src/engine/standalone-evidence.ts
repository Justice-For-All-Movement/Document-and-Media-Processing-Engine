// Standalone-mode evidence port. This is NOT the evidence engine (E05): it keeps bytes in the configured object store
// so the processing engine can be run and tried on its own. It has no scanning, custody chain, retention or encryption.
// Refs follow the E05 shape `E05:evidence_version:<id>@<revision>`.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { requireCapability, parseUref, uref } from '../service-kit.ts';
import type { EvidencePort, EvidenceVersionInfo, ObjectStore, ServiceContext } from '../service-kit.ts';

type Stored = EvidenceVersionInfo & { parent?: string; relation?: string; tool?: Json; origin?: Json };
export type StandaloneEvidence = EvidencePort & { derivativesOf(ctx: ServiceContext, parent: string): Promise<EvidenceVersionInfo[]> };

export function createStandaloneEvidencePort(objects: ObjectStore): StandaloneEvidence {
  const base = (ctx: ServiceContext): string => `${ctx.tenantId}/${ctx.projectId}/standalone-evidence`;
  const load = async (ctx: ServiceContext, ref: string): Promise<Stored | null> => {
    let p: ReturnType<typeof parseUref>;
    try { p = parseUref(ref); } catch { return null; }
    if (p.engine !== 'E05' || p.kind !== 'evidence_version' || !/^[0-9a-f-]{36}$/.test(p.id)) return null;
    try {
      const meta = JSON.parse(Buffer.from(await objects.get(`${base(ctx)}/${p.id}/meta.json`)).toString('utf8')) as Stored;
      if (p.revision !== undefined && p.revision !== meta.revision) return null;
      return meta.compartment !== null && !ctx.compartments.includes(meta.compartment) ? null : meta;
    } catch (error) { if (error instanceof DomainError && error.code === 'not_found') return null; throw error; }
  };
  const store = async (ctx: ServiceContext, bytes: Uint8Array, fields: Pick<Stored, 'mediaType' | 'filename' | 'compartment'> & Partial<Stored>, key: string | undefined): Promise<EvidenceVersionInfo> => {
    invariant(bytes instanceof Uint8Array && bytes.byteLength > 0, 'invalid_input', 'Bytes are required');
    const id = key === undefined ? randomUUID() : createHash('sha256').update(`${base(ctx)}|${key}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
    const existing = await load({ ...ctx, compartments: fields.compartment === null ? ctx.compartments : [...ctx.compartments, fields.compartment] }, uref('E05', 'evidence_version', id, 1));
    if (existing !== null) return existing;
    const info: Stored = { ...fields, ref: uref('E05', 'evidence_version', id, 1), evidenceId: id, revision: 1, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength, available: true };
    await objects.put(`${base(ctx)}/${id}/v1.bin`, bytes);
    await objects.put(`${base(ctx)}/${id}/meta.json`, Buffer.from(JSON.stringify(info)));
    return info;
  };
  return {
    async describe(ctx, ref) { requireCapability(ctx, 'evidence:read'); return load(ctx, ref); },
    async getBytes(ctx, ref) {
      requireCapability(ctx, 'evidence:read');
      const meta = await load(ctx, ref);
      if (meta === null) throw new DomainError('not_found', 'Not found');
      return objects.get(`${base(ctx)}/${meta.evidenceId}/v1.bin`);
    },
    async accept(ctx, input) {
      requireCapability(ctx, 'evidence:write');
      return store(ctx, input.bytes, { mediaType: input.mediaType, filename: input.filename, compartment: input.compartment ?? null, origin: input.origin }, input.idempotencyKey);
    },
    async addDerivative(ctx, input) {
      requireCapability(ctx, 'evidence:write');
      const parent = await load(ctx, input.parent);
      if (parent === null) throw new DomainError('not_found', 'Not found');
      return store(ctx, input.bytes, { mediaType: input.mediaType, filename: input.filename, compartment: parent.compartment, parent: parent.ref, relation: input.relation, tool: input.tool }, input.idempotencyKey);
    },
    async derivativesOf(ctx, parent) {
      requireCapability(ctx, 'evidence:read');
      const out: EvidenceVersionInfo[] = [];
      for (const key of await objects.list(`${base(ctx)}/`)) {
        if (!key.endsWith('/meta.json')) continue;
        const meta = JSON.parse(Buffer.from(await objects.get(key)).toString('utf8')) as Stored;
        if (meta.parent === parent) out.push(meta);
      }
      return out;
    },
  };
}
