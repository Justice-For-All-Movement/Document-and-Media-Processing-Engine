// Structured extraction proposals on real PostgreSQL: rule-based candidates stored as observations whose selectors
// round-trip to the exact span of the stored segment. Fictional text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import * as kit from '../src/service-kit.ts';
import { createEngine, migrate } from '../src/engine/index.ts';
import type { ProcessingEngine, ProcessingView } from '../src/engine/index.ts';
import { extractCandidates, parseAmount } from '../src/engine/extract.ts';
import { ctxOf, evidenceDouble } from './engine-fixture.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};

test('extractor: dates (ambiguous order keeps both readings), amounts, references, links, tables; no e-mail or phone', () => {
  const c = extractCandidates([{ text: 'Signed 03/04/2019 by clerk@example.org (+1 555 0100), paid EUR 1,234.50 under Contract No. CT-2019/88.' }, { text: 'a;b;c' }, { text: '1;2;3' }]);
  const date = c.find((x) => x.type === 'date');
  assert.ok(date && date.type === 'date' && date.normalized === null && date.readings?.length === 2);
  const amount = c.find((x) => x.type === 'amount');
  assert.ok(amount && amount.type === 'amount' && amount.currency === 'EUR' && amount.minorUnits === 123_450);
  assert.ok(c.some((x) => x.type === 'reference' && x.value === 'CT-2019/88'));
  assert.ok(c.some((x) => x.type === 'table' && x.rows.length === 2));
  assert.ok(!JSON.stringify(c).includes('clerk@example.org') && !JSON.stringify(c).includes('555'), 'personal contact data is not extracted');
  assert.equal(parseAmount('1,234', 'EUR'), null, 'thousands or decimals? undecided, so no value');
  assert.equal(parseAmount('1.234.567', 'EUR'), 123_456_700);
  assert.equal(parseAmount('1 234,5', 'EUR'), 123_450);
});

async function settle(engine: ProcessingEngine, ctx: kit.ServiceContext, id: string): Promise<ProcessingView> {
  for (let i = 0; i < 300; i++) {
    await engine.runJobs({ worker: 'w', limit: 3 });
    const p = await engine.getProcessing(ctx, id);
    if (p.state !== 'queued' && p.state !== 'running') { for (let j = 0; j < 50 && await engine.runJobs({ worker: 'w', limit: 3 }) > 0; j++); return engine.getProcessing(ctx, id); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('processing did not settle');
}

test('processing stores extraction proposals whose selectors round-trip to the stored text; other tenants see none', needsPg, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'e06-extract-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  await kit.withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const evidence = evidenceDouble();
    const engine = createEngine({ sql, objects: new kit.FsObjectStore(join(work, 'objects')), ports: { evidence }, config: { tempRoot: work, standalone: { useDecisions: 'allow' }, defaultLanguages: ['auto'] } });
    const ctx = ctxOf();
    const text = 'Minutes of the Example Works board.\n\nThe board met on 3 March 2019 and approved €12.500,00 for Contract No. EW-2019/14.\n\nDetails: https://records.example.org/ew/14\n';
    const info = await evidence.accept(ctx, { bytes: new TextEncoder().encode(text), mediaType: 'text/plain', filename: 'minutes.txt', origin: { test: true } });
    const proc = await settle(engine, ctx, (await engine.requestProcessing(ctx, { evidenceRef: info.ref })).id);
    assert.equal(proc.state, 'done');
    const found = await engine.listObservations(ctx, proc.id, { kind: 'extraction' });
    const types = found.map((o) => (o.data as { type: string }).type).sort();
    assert.deepEqual(types, ['amount', 'date', 'link', 'reference'], JSON.stringify(found.map((o) => o.data)));
    const rep = await engine.getRepresentation(ctx, proc.representations[0] as string);
    for (const o of found) {
      const d = o.data as { quote: string; selector: { representation: string; segmentId: string; start: number; end: number } };
      assert.equal(d.selector.representation.split('@')[0], (rep.ref as string).split('@')[0]);
      const seg = rep.segments.find((s) => s.id === d.selector.segmentId)!;
      assert.equal(seg.text.slice(d.selector.start, d.selector.end), d.quote, 'the selector points at exactly the quoted span');
      assert.match(String(o.caveat), /not a verified fact/);
    }
    const amount = found.find((o) => (o.data as { type: string }).type === 'amount')!.data as { currency: string; minorUnits: number };
    assert.deepEqual([amount.currency, amount.minorUnits], ['EUR', 1_250_000]);
    await assert.rejects(engine.listObservations(ctxOf({ tenantId: 'other-tenant' }), proc.id, { kind: 'extraction' }), (e: { code?: string }) => e.code === 'not_found');
  });
});
