// Tool-layer tests that need no database: content sniffing, parsers for real tool output, bounded subprocesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '../src/contracts.ts';
import * as tools from '../src/engine/tools.ts';
import { parseOpenAiWhisper, parseWhisperCpp, diarize } from '../src/engine/adapters.ts';
import { fixtures, KNOWN } from './engine-fixture.ts';

const code = (c: string) => (e: unknown): boolean => e instanceof DomainError && e.code === c;

test('sniffing follows content, not names or declared types', () => {
  const f = fixtures();
  assert.equal(tools.sniff(f.pdf).family, 'pdf'); assert.equal(tools.sniff(f.scanPng).mediaType, 'image/png');
  assert.deepEqual([tools.sniff(f.docx).family, tools.sniff(f.docx).pandocFormat], ['office', 'docx']);
  assert.equal(tools.sniff(f.audio).mediaType, 'audio/wav'); assert.equal(tools.sniff(f.video).mediaType, 'video/mp4');
  assert.equal(tools.sniff(f.html).family, 'html'); assert.equal(tools.sniff(f.eml).family, 'email'); assert.equal(tools.sniff(f.vtt).family, 'captions'); assert.equal(tools.sniff(f.txt).family, 'text');
  assert.equal(tools.sniff(Buffer.from('{\\rtf1 hello}')).pandocFormat, 'rtf');
  assert.equal(tools.sniff(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])).reader, 'libreoffice');
  assert.equal(tools.sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>')).family, 'text', 'SVG never reaches an image decoder');
  assert.equal(tools.sniff(Buffer.from('#EXTM3U\nfile:///etc/passwd\n')).family, 'text');
  assert.equal(tools.sniff(Buffer.from([0, 159, 146, 150, 0, 1, 2])).family, 'unknown');
  assert.equal(tools.sniff(Buffer.from('Привіт, це звичайний текст.')).family, 'text');
});

test('pdftotext bbox-layout and tesseract TSV parsers keep geometry and confidence', () => {
  const layout = tools.parseBboxLayout('<doc><page width="612.000000" height="792.000000"><flow><block xMin="1" yMin="2" xMax="3" yMax="4"><line xMin="72.1" yMin="96.018" xMax="140.5" yMax="115.538"><word xMin="72.1" yMin="96.018" xMax="101.444" yMax="115.538">Tom &amp; Co</word><word xMin="105" yMin="96" xMax="140.5" yMax="115.5">&#233;t&#xe9;</word></line></block></flow></page><page width="612" height="792"></page></doc>', 3);
  assert.deepEqual(layout.pages.map((p) => [p.page, p.source, p.unit]), [[3, 'text_layer', 'pt'], [4, 'empty', 'pt']]);
  assert.equal(layout.segments[0]?.text, 'Tom & Co été'); assert.deepEqual(layout.segments[0]?.words?.[0]?.b, [72.1, 96.02, 101.44, 115.54]); assert.equal(layout.segments[0]?.page, 3);
  const tsv = ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext', '1\t1\t0\t0\t0\t0\t0\t0\t800\t200\t-1\t', '5\t1\t1\t1\t1\t1\t10\t20\t50\t30\t96.5\tAlpha', '5\t1\t1\t1\t1\t2\t70\t21\t40\t30\t41.0\tbeta', '5\t1\t1\t1\t1\t3\t120\t22\t40\t30\t90\tgamma', '5\t1\t1\t1\t1\t4\t170\t23\t40\t30\t90\tdelta', '5\t1\t1\t1\t2\t1\t10\t80\t40\t30\t-1\t '].join('\n');
  const parsed = tools.parseTesseractTsv(tsv, 0.6);
  assert.deepEqual([parsed.width, parsed.height, parsed.lines.length], [800, 200, 1]);
  assert.deepEqual(parsed.lines[0]?.words[1], { t: 'beta', b: [70, 21, 110, 51], c: 0.41 });
  assert.deepEqual([parsed.stats.words, parsed.stats.low, parsed.stats.min], [4, 1, 0.41]);
  assert.ok(parsed.stats.skew !== null && parsed.stats.skew > 0.5 && parsed.stats.skew < 2, `skew ${parsed.stats.skew}`);
});

test('language identification reports confidence and declines to guess', () => {
  const p = tools.BUILTIN_PROFILES;
  assert.equal(tools.detectLanguage('The council approved the budget and it was sent to the board for review before the meeting.', p).language, 'eng');
  assert.equal(tools.detectLanguage('El consejo aprobó el presupuesto y lo envió a la junta para su revisión antes de la reunión.', p).language, 'spa');
  const ukr = tools.detectLanguage('Рада затвердила бюджет і надіслала його до правління для розгляду, але це не було остаточним рішенням.', p);
  assert.equal(ukr.language, 'ukr'); assert.equal(ukr.script, 'Cyrillic'); assert.ok(ukr.confidence > 0.2 && ukr.confidence < 1);
  assert.deepEqual([tools.detectLanguage('4471 2026 77', p).language, tools.detectLanguage('Zxq vrrt plomb', p).language, tools.detectLanguage('', p).confidence], [null, null, 0]);
  assert.deepEqual(Object.keys(tools.detectLanguage('the and of', { xx: { script: 'Latin', stopwords: ['the'] } }).scores), ['xx'], 'profiles are deployment data');
});

test('mail reader decodes headers and parts and ignores attachments', () => {
  const mail = tools.parseEml(fixtures().eml);
  assert.equal(mail.headers.subject, 'Minutes of the café meeting'); assert.match(mail.text ?? '', /café meeting\.\r?\n\r?\nPlease confirm/); assert.match(mail.html ?? '', /ignored html/);
  const attach = tools.parseEml(Buffer.from('From: a@example.org\r\nDate: x\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\nSECRET ATTACHMENT\r\n--z\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nQm9keSB0ZXh0\r\n--z--\r\n'));
  assert.equal(attach.text, 'Body text');
  assert.deepEqual(tools.paragraphsOf('One\nstill one\n\n\nTwo\n').map((s) => [s.text, s.anchor?.paragraph, s.anchor?.charStart]), [['One\nstill one', 1, 0], ['Two', 2, 16]]);
});

test('whisper output parsers build words with timestamps and never invent confidence', () => {
  const cpp = parseWhisperCpp({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 900 }, text: ' Hi there', tokens: [{ text: '[_BEG_]', offsets: { from: 0, to: 0 } }, { text: ' Hi', offsets: { from: 10, to: 200 }, p: 0.9 }, { text: ' the', offsets: { from: 300, to: 500 }, p: 0.8 }, { text: 're', offsets: { from: 500, to: 900 }, p: 0.5 }] }] });
  assert.deepEqual(cpp.words, [{ t: 'Hi', s: 10, e: 200, c: 0.9 }, { t: 'there', s: 300, e: 900, c: 0.5 }]);
  const oa = parseOpenAiWhisper({ language: 'es', segments: [{ start: 0, end: 1.5, text: ' hola mundo', avg_logprob: -0.1, words: [{ word: ' hola', start: 0.1, end: 0.5, probability: 0.93 }, { word: ' mundo', start: 0.6, end: 1.4 }] }] });
  assert.deepEqual(oa.words, [{ t: 'hola', s: 100, e: 500, c: 0.93 }, { t: 'mundo', s: 600, e: 1400, c: null }]); assert.equal(oa.segments[0]?.confidence, 0.9048);
});

test('subprocesses: argument arrays, timeouts, output caps, cleaned working directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e06-run-'));
  try {
    const runner = new tools.ToolRunner({ tempRoot: root });
    await runner.workdir(async (cwd) => {
      // shell metacharacters are plain argument text
      const marker = join(cwd, 'pwned');
      const r = await runner.run('printf', ['%s', `$(touch ${marker}); echo \`id\` > ${marker}`], { cwd });
      assert.match(r.stdout.toString(), /\$\(touch/); assert.deepEqual(readdirSync(cwd), []);
      await assert.rejects(runner.run('sleep', ['5'], { cwd, timeoutMs: 150 }), code('process_timeout'));
      await assert.rejects(runner.run('yes', [], { cwd, maxStdoutBytes: 4096 }), code('process_output_limit'));
      await assert.rejects(runner.run('false', [], { cwd }), code('tool_failed'));
      await assert.rejects(runner.run('definitely-not-installed-tool', [], { cwd }), code('unavailable'));
      const env = (await runner.run('env', [], { cwd })).stdout.toString();
      assert.match(env, /https_proxy=http:\/\/127\.0\.0\.1:9/); assert.match(env, new RegExp(`HOME=${cwd}`)); assert.ok(!/TEST_DATABASE_URL|TOKEN|SECRET/i.test(env), 'the parent environment is not inherited');
      const abort = new AbortController(); setTimeout(() => abort.abort(), 100);
      await assert.rejects(runner.run('sleep', ['5'], { cwd, signal: abort.signal }), code('process_aborted'));
      const limited = new tools.ToolRunner({ tempRoot: root, limits: { maxFileBytes: 4096 } });
      await assert.rejects(limited.run('dd', ['if=/dev/zero', 'of=big.bin', 'bs=1024', 'count=64'], { cwd }), code('tool_failed'));
    });
    await assert.rejects(runner.workdir(async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(readdirSync(root), [], 'working directories are removed on success and failure');
    assert.equal(await runner.version('definitely-not-installed-tool'), null);
    assert.match(String(await runner.version('pdftotext')), /^\d+\.\d+/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('diarization separates two synthesised voices and reports one cluster for one voice, silence as no speech', async () => {
  const f = fixtures();
  const runner = new tools.ToolRunner();
  await runner.workdir(async (cwd) => {
    const two = await tools.normalizeAudio(runner, cwd, await tools.writeInput(cwd, 'talk.wav', f.audio), 600);
    const d = await diarize(runner, cwd, two.raw);
    assert.equal(d.speakers, 2); assert.ok(d.turns.every((t) => t.provisional === true && t.confidence !== null && t.confidence > 0 && t.confidence <= 1));
  });
  await runner.workdir(async (cwd) => {
    await runner.run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-f', 's16le', join(cwd, 'silence.raw')], { cwd, noMemoryLimit: true });
    const d = await diarize(runner, cwd, join(cwd, 'silence.raw'));
    assert.deepEqual([d.speakers, d.turns.length], [0, 0]);
    const one = await tools.normalizeAudio(runner, cwd, await tools.writeInput(cwd, 'clip.mp4', f.video), 600);
    const single = await diarize(runner, cwd, one.raw);
    assert.equal(single.speakers, 1); assert.equal(single.turns[0]?.confidence, null, 'a single cluster carries no separation score');
  });
  assert.ok(KNOWN.spoken.length > 0);
});
