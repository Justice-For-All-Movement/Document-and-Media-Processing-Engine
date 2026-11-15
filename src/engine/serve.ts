// Standalone server for the processing engine: migrations, HTTP API and the job worker loop.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import * as kit from '../service-kit.ts';
import { createEngine, manifest, migrate, routes } from './index.ts';
import type { EngineConfig } from './index.ts';
import { createStandaloneEvidencePort } from './standalone-evidence.ts';

function publicKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.IDENTITY_PUBLIC_KEYS !== undefined && env.IDENTITY_PUBLIC_KEYS !== '') return JSON.parse(env.IDENTITY_PUBLIC_KEYS) as Record<string, string>;
  if (env.IDENTITY_JWKS_FILE !== undefined && env.IDENTITY_JWKS_FILE !== '') {
    const doc = JSON.parse(readFileSync(env.IDENTITY_JWKS_FILE, 'utf8')) as Record<string, string> | { keys: { kid: string; pem?: string; publicKeyPem?: string }[] };
    if (Array.isArray((doc as { keys?: unknown }).keys)) return Object.fromEntries((doc as { keys: { kid: string; pem?: string; publicKeyPem?: string }[] }).keys.map((k) => [k.kid, (k.publicKeyPem ?? k.pem) as string]));
    return doc as Record<string, string>;
  }
  throw new DomainError('invalid_config', 'IDENTITY_PUBLIC_KEYS (JSON map kid→PEM) or IDENTITY_JWKS_FILE is required');
}
/** Provider settings are deployment configuration (PROCESSING_CONFIG_FILE); API keys are read from named environment variables. */
function engineConfig(env: NodeJS.ProcessEnv): EngineConfig {
  const file = env.PROCESSING_CONFIG_FILE === undefined || env.PROCESSING_CONFIG_FILE === '' ? {} : JSON.parse(readFileSync(env.PROCESSING_CONFIG_FILE, 'utf8')) as EngineConfig & { asr?: { providers?: Record<string, { apiKeyEnv?: string }> }; translation?: { providers?: Record<string, { apiKeyEnv?: string }> } };
  const withKeys = <T extends { apiKeyEnv?: string }>(providers: Record<string, T> | undefined): Record<string, T & { apiKey?: string }> | undefined => providers === undefined ? undefined : Object.fromEntries(Object.entries(providers).map(([id, p]) => { const { apiKeyEnv, ...rest } = p; const apiKey = apiKeyEnv === undefined ? undefined : env[apiKeyEnv]; return [id, { ...(rest as T), ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }) }]; }));
  const config: EngineConfig = { ...file };
  if (file.asr !== undefined) config.asr = { ...file.asr, ...(file.asr.providers === undefined ? {} : { providers: withKeys(file.asr.providers as never) as never }) };
  if (file.translation !== undefined) config.translation = { ...file.translation, ...(file.translation.providers === undefined ? {} : { providers: withKeys(file.translation.providers as never) as never }) };
  if (env.PROCESSING_DEFAULT_LANGUAGES !== undefined && env.PROCESSING_DEFAULT_LANGUAGES !== '') config.defaultLanguages = env.PROCESSING_DEFAULT_LANGUAGES.split(',').map((l) => l.trim()).filter((l) => l !== '');
  if (env.PROCESSING_TEMP_DIR !== undefined && env.PROCESSING_TEMP_DIR !== '') config.tempRoot = env.PROCESSING_TEMP_DIR;
  if (env.PROCESSING_STANDALONE_USE_DECISIONS === 'allow') config.standalone = { useDecisions: 'allow' };
  if (env.WHISPER_BINARY !== undefined && env.WHISPER_MODEL !== undefined && env.WHISPER_BINARY !== '' && env.WHISPER_MODEL !== '') config.asr = { ...config.asr, whisper: { kind: env.WHISPER_KIND === 'faster-whisper' ? 'faster-whisper' : 'whisper.cpp', binary: env.WHISPER_BINARY, model: env.WHISPER_MODEL } };
  return config;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ close(): Promise<void>; port: number }> {
  invariant(typeof env.DATABASE_URL === 'string' && env.DATABASE_URL !== '', 'invalid_config', 'DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX ?? 8) });
  const sql = kit.pgSql(pool);
  await migrate(sql);
  const objects = kit.objectStoreFromEnv(env, join(tmpdir(), 'e06-objects'));
  // Standalone evidence is a stand-in for E05 so the server is usable alone; a host embeds createEngine with the real port instead.
  const evidence = env.PROCESSING_STANDALONE_EVIDENCE === '1' ? createStandaloneEvidencePort(objects) : undefined;
  const engine = createEngine({ sql, objects, ...(evidence === undefined ? {} : { ports: { evidence } }), config: engineConfig(env) });
  const own = routes(engine);
  if (evidence !== undefined) own.push({ method: 'POST', path: '/v1/standalone/evidence', handler: async (r) => {
    kit.requireCapability(r.ctx, 'processing:write');
    invariant(r.raw.byteLength > 0, 'invalid_input', 'Send the file bytes as the request body');
    const name = r.query.get('filename') ?? 'upload.bin';
    invariant(/^[A-Za-z0-9._ -]{1,200}$/.test(name), 'invalid_input', 'Invalid filename');
    const ctx = { ...r.ctx, capabilities: [...r.ctx.capabilities, 'evidence:write', 'evidence:read'] };
    return (await evidence.accept(ctx, { bytes: r.raw, mediaType: String(r.headers['content-type'] ?? 'application/octet-stream'), filename: name, origin: { via: 'standalone-upload' } })) as unknown as Json;
  } });
  const handler = kit.createHttpHandler({ name: manifest.id, version: manifest.version, routes: own, verify: kit.createTokenVerifier({ publicKeys: publicKeys(env), ...(env.IDENTITY_ISSUER === undefined ? {} : { issuer: env.IDENTITY_ISSUER }) }), health: () => engine.health(), maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 256 * 1024 * 1024), onError: (error, info) => console.error(JSON.stringify({ level: 'error', requestId: info.requestId, method: info.method, path: info.path, error: error instanceof Error ? error.name : 'error' })) });
  const server = await kit.serve(handler, Number(env.PORT ?? 8006), env.HOST ?? '127.0.0.1');
  let stopping = false;
  const worker = `e06-${process.pid}`;
  const loop = (async () => {
    while (!stopping) {
      let n = 0;
      try { n = await engine.runJobs({ worker, limit: Number(env.WORKER_CONCURRENCY ?? 1) }); } catch (error) { console.error(JSON.stringify({ level: 'error', worker, error: error instanceof Error ? error.name : 'error' })); }
      if (n === 0) await new Promise((r) => setTimeout(r, Number(env.WORKER_POLL_MS ?? 1000)));
    }
  })();
  const port = (server.address() as { port: number }).port;
  console.log(JSON.stringify({ level: 'info', engine: manifest.id, listening: port }));
  return { port, async close() { stopping = true; await new Promise<void>((r) => server.close(() => r())); await loop; await pool.end(); } };
}
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((s) => { for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void s.close().then(() => process.exit(0)); }); }, (error) => { console.error(error instanceof Error ? error.message : 'startup failed'); process.exit(1); });
}
