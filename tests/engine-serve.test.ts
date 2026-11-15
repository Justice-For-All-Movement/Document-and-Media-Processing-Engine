// Standalone server: env configuration, migrations, HTTP and the worker loop, end to end over a socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import * as kit from '../src/service-kit.ts';
import { main } from '../src/engine/serve.ts';
import type { ProcessingView } from '../src/engine/index.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};

test('npm run serve entry: upload (standalone evidence), process, search', needsPg, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e06-serve-'));
  try {
    await kit.withDisposableDatabase(pg, ADMIN, async (url) => {
      const key = kit.generateSigningKey('k1');
      await assert.rejects(main({ DATABASE_URL: url, PORT: '0' }), /IDENTITY_PUBLIC_KEYS/);
      const server = await main({ DATABASE_URL: url, PORT: '0', IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: key.publicKeyPem }), OBJECT_STORE_PATH: join(dir, 'objects'), PROCESSING_TEMP_DIR: dir, PROCESSING_STANDALONE_EVIDENCE: '1', PROCESSING_STANDALONE_USE_DECISIONS: 'allow', WORKER_POLL_MS: '50' });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const now = Math.floor(Date.now() / 1000);
        const token = (tid: string): string => kit.signAccessToken({ iss: 'iap', sub: 'u1', kind: 'human', tid, pid: 'p1', roles: [], caps: ['processing:read', 'processing:write', 'evidence:read', 'evidence:write'], cmp: [], purpose: 'research', pv: '1', iat: now, exp: now + 600, jti: 'j' }, key);
        const client = kit.engineClient(base, () => token('t1'));
        const health = await (await fetch(`${base}/healthz`)).json() as { ok: boolean; detail: { useDecisionPort: string } };
        assert.equal(health.ok, true); assert.equal(health.detail.useDecisionPort, 'standalone-allow');
        const info = await client.call<kit.EvidenceVersionInfo>('POST', '/v1/standalone/evidence?filename=note.txt', new TextEncoder().encode('The reservoir survey was completed in autumn.\n'));
        assert.match(info.ref, /^E05:evidence_version:[0-9a-f-]{36}@1$/);
        const proc = await client.call<ProcessingView>('POST', '/v1/processing/jobs', { evidenceRef: info.ref });
        let state = proc.state;
        for (let i = 0; i < 200 && (state === 'queued' || state === 'running'); i++) { await new Promise((r) => setTimeout(r, 100)); state = (await client.call<ProcessingView>('GET', `/v1/processing/${proc.id}`)).state; }
        assert.equal(state, 'done');
        const hits = await client.call<{ evidenceRef: string; snippet: string }[]>('GET', '/v1/segments/search?q=reservoir');
        assert.equal(hits[0]?.evidenceRef, info.ref); assert.match(hits[0]?.snippet ?? '', /«reservoir»/);
        assert.deepEqual(await kit.engineClient(base, () => token('t2')).call('GET', '/v1/segments/search?q=reservoir'), []);
        await assert.rejects(kit.engineClient(base, () => token('t2')).call('POST', '/v1/processing/jobs', { evidenceRef: info.ref }), /Not found/);
      } finally { await server.close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
