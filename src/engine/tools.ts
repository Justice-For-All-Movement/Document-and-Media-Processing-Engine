// Local processing tools: bounded subprocess execution and parsers for real tool output.
// Inputs are hostile. Every tool runs with an argument array (never a shell), a private working directory,
// a wall-clock timeout, output caps, optional address-space/file-size limits and a dead proxy so nothing fetches.
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, invariant } from '../contracts.ts';

export type ToolLimits = Readonly<{
  timeoutMs: number; maxStdoutBytes: number; memoryBytes: number; maxFileBytes: number;
  maxInputBytes: number; maxPages: number; maxOcrPages: number; maxMediaSeconds: number; maxSegments: number;
  ocrDpi: number; thumbnailPages: number;
}>;
export const DEFAULT_LIMITS: ToolLimits = {
  timeoutMs: 180_000, maxStdoutBytes: 64 * 1024 * 1024, memoryBytes: 6 * 1024 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxInputBytes: 1024 * 1024 * 1024, maxPages: 2000, maxOcrPages: 300, maxMediaSeconds: 4 * 3600, maxSegments: 400_000,
  ocrDpi: 200, thumbnailPages: 3,
};
export type RunOptions = Readonly<{ cwd: string; timeoutMs?: number; maxStdoutBytes?: number; signal?: AbortSignal; input?: Uint8Array; allowExit?: readonly number[]; noMemoryLimit?: boolean }>;
export type RunResult = Readonly<{ code: number; stdout: Buffer; stderr: string }>;

const BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'];
const resolved = new Map<string, string | null>();
/** Resolves a tool name on a fixed search path (never the caller's PATH or cwd). Absolute paths are checked as given. */
export async function which(name: string): Promise<string | null> {
  if (resolved.has(name)) return resolved.get(name) as string | null;
  const candidates = name.startsWith('/') ? [name] : BIN_DIRS.map((d) => join(d, name));
  let found: string | null = null;
  for (const c of candidates) { try { await access(c, constants.X_OK); found = c; break; } catch { /* next */ } }
  resolved.set(name, found);
  return found;
}
export function unavailable(what: string): DomainError { return new DomainError('unavailable', `Required tool is not installed: ${what}`); }

export class ToolRunner {
  readonly limits: ToolLimits;
  readonly tempRoot: string;
  readonly #versions = new Map<string, Promise<string | null>>();
  constructor(options: { limits?: Partial<ToolLimits>; tempRoot?: string } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.tempRoot = options.tempRoot ?? tmpdir();
  }
  /** Creates a private working directory, runs fn, and always removes the directory. */
  async workdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(this.tempRoot, 'e06-'));
    try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
  }
  async run(tool: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    const binary = await which(tool);
    if (binary === null) throw unavailable(tool);
    invariant(args.every((a) => typeof a === 'string' && !a.includes('\u0000')), 'invalid_input', 'Invalid tool argument');
    const prlimit = await which('prlimit');
    const limited = prlimit !== null;
    const command = limited ? prlimit as string : binary;
    const argv = limited
      ? [...(options.noMemoryLimit === true ? [] : [`--as=${this.limits.memoryBytes}`]), `--fsize=${this.limits.maxFileBytes}`, '--core=0', '--', binary, ...args]
      : [...args];
    const timeoutMs = options.timeoutMs ?? this.limits.timeoutMs;
    const maxStdout = options.maxStdoutBytes ?? this.limits.maxStdoutBytes;
    return new Promise<RunResult>((resolveRun, reject) => {
      if (options.signal?.aborted === true) { reject(new DomainError('process_aborted', 'Processing was cancelled')); return; }
      let failure: DomainError | null = null, settled = false, outBytes = 0, errBytes = 0;
      const out: Buffer[] = [], err: Buffer[] = [];
      const child = spawn(command, argv, {
        cwd: options.cwd, shell: false, detached: true, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: {
          PATH: BIN_DIRS.join(':'), HOME: options.cwd, TMPDIR: options.cwd, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', OMP_THREAD_LIMIT: '2',
          // A dead local proxy: converters that try to dereference remote resources fail fast instead of fetching.
          http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', no_proxy: '',
          MAGICK_TIME_LIMIT: String(Math.ceil(timeoutMs / 1000)), MAGICK_MEMORY_LIMIT: '1GiB', MAGICK_MAP_LIMIT: '2GiB', MAGICK_DISK_LIMIT: '4GiB',
        },
      });
      const kill = (): void => { try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
      const fail = (code: string, message: string): void => { if (failure === null) failure = new DomainError(code, message); kill(); };
      const timer = setTimeout(() => fail('process_timeout', `${tool} exceeded its time limit`), timeoutMs);
      const abort = (): void => fail('process_aborted', 'Processing was cancelled');
      options.signal?.addEventListener('abort', abort, { once: true });
      const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      child.stdout?.on('data', (c: Buffer) => { outBytes += c.length; if (outBytes > maxStdout) fail('process_output_limit', `${tool} produced too much output`); else out.push(c); });
      child.stderr?.on('data', (c: Buffer) => { errBytes += c.length; if (errBytes <= 65536) err.push(c); });
      if (options.input !== undefined && child.stdin !== null) { child.stdin.on('error', () => { /* tool closed stdin early */ }); child.stdin.end(Buffer.from(options.input)); }
      child.on('error', () => { if (settled) return; settled = true; done(); reject(unavailable(tool)); });
      child.on('close', (code) => {
        if (settled) return; settled = true; done(); kill();
        if (failure !== null) { reject(failure); return; }
        const result = { code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') };
        if (result.code !== 0 && !(options.allowExit ?? []).includes(result.code)) {
          // stderr may quote hostile content; keep only a short printable excerpt for operators.
          reject(new DomainError('tool_failed', `${tool} exited with ${result.code}: ${result.stderr.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 300)}`));
        } else resolveRun(result);
      });
    });
  }
  /** Reports a tool's version string, or null when the tool is missing. Cached per runner. */
  version(tool: string): Promise<string | null> {
    let cached = this.#versions.get(tool);
    if (cached === undefined) { cached = this.#probe(tool); this.#versions.set(tool, cached); }
    return cached;
  }
  async #probe(tool: string): Promise<string | null> {
    if (await which(tool) === null) return null;
    const flag: Record<string, string[]> = { pdftotext: ['-v'], pdftoppm: ['-v'], pdfinfo: ['-v'], pdfunite: ['-v'], tesseract: ['--version'], ffmpeg: ['-version'], ffprobe: ['-version'], exiftool: ['-ver'], pandoc: ['--version'], soffice: ['--version'], convert: ['-version'], identify: ['-version'], apertium: ['-V'] };
    try {
      return await this.workdir(async (cwd) => {
        const r = await this.run(tool, flag[tool] ?? ['--version'], { cwd, timeoutMs: 30_000, allowExit: [1, 99], noMemoryLimit: true });
        const text = `${r.stdout.toString('utf8')}\n${r.stderr}`;
        return /(\d+\.\d+(?:\.\d+)*)/.exec(text)?.[1] ?? 'unknown';
      });
    } catch (error) { return error instanceof DomainError && error.code === 'unavailable' ? null : 'unknown'; }
  }
}

// ───────────────────────────── Media type sniffing ─────────────────────────────
export type Family = 'pdf' | 'image' | 'office' | 'text' | 'html' | 'email' | 'media' | 'captions' | 'unknown';
export type Sniffed = Readonly<{ mediaType: string; family: Family; ext: string; reader?: 'pandoc' | 'libreoffice' | 'plain' | 'eml'; pandocFormat?: string; imageCoder?: string }>;
const ascii = (b: Uint8Array, at: number, n: number): string => Buffer.from(b.subarray(at, at + n)).toString('latin1');
/** Decides the media type from content only. Declared types and filenames are claims, not facts. */
export function sniff(bytes: Uint8Array): Sniffed {
  const head = ascii(bytes, 0, 16);
  const has = (needle: string, limit = 8192): boolean => Buffer.from(bytes.subarray(0, limit)).includes(needle);
  if (head.startsWith('%PDF-')) return { mediaType: 'application/pdf', family: 'pdf', ext: 'pdf' };
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return { mediaType: 'image/png', family: 'image', ext: 'png', imageCoder: 'png' };
  if (head.startsWith('\xff\xd8\xff')) return { mediaType: 'image/jpeg', family: 'image', ext: 'jpg', imageCoder: 'jpeg' };
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return { mediaType: 'image/gif', family: 'image', ext: 'gif', imageCoder: 'gif' };
  if (head.startsWith('II*\x00') || head.startsWith('MM\x00*')) return { mediaType: 'image/tiff', family: 'image', ext: 'tif', imageCoder: 'tiff' };
  if (head.startsWith('BM') && bytes.length > 26 && bytes[14] !== undefined && [12, 40, 52, 56, 108, 124].includes(bytes[14])) return { mediaType: 'image/bmp', family: 'image', ext: 'bmp', imageCoder: 'bmp' };
  if (head.startsWith('RIFF')) {
    const kind = ascii(bytes, 8, 4);
    if (kind === 'WEBP') return { mediaType: 'image/webp', family: 'image', ext: 'webp', imageCoder: 'webp' };
    if (kind === 'WAVE') return { mediaType: 'audio/wav', family: 'media', ext: 'wav' };
    if (kind === 'AVI ') return { mediaType: 'video/x-msvideo', family: 'media', ext: 'avi' };
  }
  if (head.startsWith('OggS')) return { mediaType: 'application/ogg', family: 'media', ext: 'ogg' };
  if (head.startsWith('fLaC')) return { mediaType: 'audio/flac', family: 'media', ext: 'flac' };
  if (head.startsWith('ID3') || (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)) return { mediaType: 'audio/mpeg', family: 'media', ext: 'mp3' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand.startsWith('M4A')) return { mediaType: 'audio/mp4', family: 'media', ext: 'm4a' };
    if (brand === 'qt  ') return { mediaType: 'video/quicktime', family: 'media', ext: 'mov' };
    if (['heic', 'heix', 'avif', 'mif1'].includes(brand)) return { mediaType: 'application/octet-stream', family: 'unknown', ext: 'bin' };
    return { mediaType: 'video/mp4', family: 'media', ext: 'mp4' };
  }
  if (head.startsWith('\x1a\x45\xdf\xa3')) return has('webm', 64) ? { mediaType: 'video/webm', family: 'media', ext: 'webm' } : { mediaType: 'video/x-matroska', family: 'media', ext: 'mkv' };
  if (head.startsWith('PK\x03\x04')) {
    const all = Buffer.from(bytes);
    if (all.includes('word/document.xml')) return { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', family: 'office', ext: 'docx', reader: 'pandoc', pandocFormat: 'docx' };
    if (has('mimetypeapplication/vnd.oasis.opendocument.text', 128)) return { mediaType: 'application/vnd.oasis.opendocument.text', family: 'office', ext: 'odt', reader: 'pandoc', pandocFormat: 'odt' };
    if (has('mimetypeapplication/epub+zip', 128)) return { mediaType: 'application/epub+zip', family: 'office', ext: 'epub', reader: 'pandoc', pandocFormat: 'epub' };
    if (all.includes('ppt/presentation.xml')) return { mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', family: 'office', ext: 'pptx', reader: 'libreoffice' };
    if (all.includes('xl/workbook.xml')) return { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', family: 'office', ext: 'xlsx', reader: 'libreoffice' };
    if (has('mimetypeapplication/vnd.oasis.opendocument.spreadsheet', 128)) return { mediaType: 'application/vnd.oasis.opendocument.spreadsheet', family: 'office', ext: 'ods', reader: 'libreoffice' };
    if (has('mimetypeapplication/vnd.oasis.opendocument.presentation', 128)) return { mediaType: 'application/vnd.oasis.opendocument.presentation', family: 'office', ext: 'odp', reader: 'libreoffice' };
    return { mediaType: 'application/zip', family: 'unknown', ext: 'zip' };
  }
  if (head.startsWith('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')) return { mediaType: 'application/x-ole-storage', family: 'office', ext: 'doc', reader: 'libreoffice' };
  if (head.startsWith('{\\rtf')) return { mediaType: 'application/rtf', family: 'office', ext: 'rtf', reader: 'pandoc', pandocFormat: 'rtf' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 65536 - (bytes.length > 65536 ? 4 : 0)))); }
  catch {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 4096))); } catch { return { mediaType: 'application/octet-stream', family: 'unknown', ext: 'bin' }; }
  }
  if (text.includes('\u0000')) return { mediaType: 'application/octet-stream', family: 'unknown', ext: 'bin' };
  const start = text.replace(/^﻿/, '').trimStart().slice(0, 2048).toLowerCase();
  if (start.startsWith('webvtt')) return { mediaType: 'text/vtt', family: 'captions', ext: 'vtt' };
  if (start.startsWith('<!doctype html') || start.startsWith('<html') || /^(<!--[\s\S]*?-->\s*)?<(head|body)\b/.test(start)) return { mediaType: 'text/html', family: 'html', ext: 'html', reader: 'pandoc', pandocFormat: 'html' };
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const headerNames = [...headerBlock.matchAll(/^([A-Za-z][A-Za-z0-9-]*):/gm)].map((m) => (m[1] as string).toLowerCase());
  if (headerNames.length >= 2 && headerNames.includes('from') && ['mime-version', 'message-id', 'received', 'date', 'subject'].some((h) => headerNames.includes(h)) && /^[A-Za-z][A-Za-z0-9-]*:/.test(headerBlock)) return { mediaType: 'message/rfc822', family: 'email', ext: 'eml', reader: 'eml' };
  return { mediaType: 'text/plain', family: 'text', ext: 'txt', reader: 'plain' };
}

// ───────────────────────────── Shared result shapes ─────────────────────────────
/** t=text, b=[x0,y0,x1,y1] in the page's unit, c=confidence 0..1 or null (unknown), s/e=media milliseconds. */
export type Word = { t: string; b?: [number, number, number, number]; c?: number | null; s?: number; e?: number };
export type SegmentDraft = {
  kind: 'line' | 'paragraph' | 'utterance' | 'cue'; text: string; source: 'text_layer' | 'ocr' | 'conversion' | 'asr' | 'import' | 'translation';
  page?: number; bbox?: [number, number, number, number]; startMs?: number; endMs?: number; anchor?: Record<string, number | string | null>;
  words?: Word[]; confidence?: number | null; speaker?: string | null; sourceSegmentId?: string;
};
export type PageInfo = {
  page: number; width: number; height: number; unit: 'pt' | 'px'; source: 'text_layer' | 'ocr' | 'empty';
  ocr?: { words: number; meanConfidence: number | null; minConfidence: number | null; lowConfidenceWords: number; languages: string[]; dpi: number | null; skewDegrees: number | null; orientationDegrees: number | null; script: string | null; scriptConfidence: number | null };
  warnings: string[];
};
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const unescapeXml = (s: string): string => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : Number(e.slice(1))));

// ───────────────────────────── PDF ─────────────────────────────
export type PdfInfo = { pages: number; encrypted: boolean; javascript: boolean; producer: string | null; creator: string | null; pageSize: string | null; version: string | null };
export async function pdfInfo(runner: ToolRunner, cwd: string, file: string): Promise<PdfInfo> {
  const r = await runner.run('pdfinfo', [file], { cwd, timeoutMs: 60_000, maxStdoutBytes: 1024 * 1024 });
  const text = r.stdout.toString('utf8');
  const field = (name: string): string | null => new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null;
  const pages = Number(field('Pages'));
  invariant(Number.isSafeInteger(pages) && pages >= 0, 'tool_failed', 'pdfinfo did not report a page count');
  return { pages, encrypted: (field('Encrypted') ?? 'no').startsWith('yes'), javascript: field('JavaScript') === 'yes', producer: field('Producer'), creator: field('Creator'), pageSize: field('Page size'), version: field('PDF version') };
}
/** Parses `pdftotext -bbox-layout` XHTML into lines with word boxes (PDF points, origin top-left). */
export function parseBboxLayout(xhtml: string, firstPage: number): { pages: PageInfo[]; segments: SegmentDraft[] } {
  const pages: PageInfo[] = [], segments: SegmentDraft[] = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let number = firstPage - 1;
  for (const pm of xhtml.matchAll(pageRe)) {
    number++;
    const body = pm[3] as string;
    let block = 0, lines = 0;
    for (const bm of body.matchAll(/<block [^>]*>([\s\S]*?)<\/block>/g)) {
      block++;
      for (const lm of (bm[1] as string).matchAll(/<line xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/line>/g)) {
        const words: Word[] = [];
        for (const wm of (lm[5] as string).matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g)) {
          const t = unescapeXml(wm[5] as string);
          if (t.trim() !== '') words.push({ t, b: [round(Number(wm[1])), round(Number(wm[2])), round(Number(wm[3])), round(Number(wm[4]))] });
        }
        if (words.length === 0) continue;
        lines++;
        segments.push({ kind: 'line', source: 'text_layer', page: number, text: words.map((w) => w.t).join(' '), bbox: [round(Number(lm[1])), round(Number(lm[2])), round(Number(lm[3])), round(Number(lm[4]))], anchor: { block, line: lines }, words, confidence: null });
      }
    }
    pages.push({ page: number, width: round(Number(pm[1])), height: round(Number(pm[2])), unit: 'pt', source: lines > 0 ? 'text_layer' : 'empty', warnings: [] });
  }
  return { pages, segments };
}
export async function pdfTextLayout(runner: ToolRunner, cwd: string, file: string, first: number, last: number): Promise<{ pages: PageInfo[]; segments: SegmentDraft[] }> {
  await runner.run('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', '-f', String(first), '-l', String(last), file, 'layout.xhtml'], { cwd });
  const xhtml = await readFile(join(cwd, 'layout.xhtml'), 'utf8');
  await rm(join(cwd, 'layout.xhtml'), { force: true });
  return parseBboxLayout(xhtml, first);
}
export async function pdfRasterize(runner: ToolRunner, cwd: string, file: string, page: number, dpi: number, out: string, colour = false): Promise<string> {
  await runner.run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), ...(colour ? [] : ['-gray']), '-png', '-singlefile', file, out], { cwd });
  return `${out}.png`;
}

// ───────────────────────────── OCR ─────────────────────────────
export type OcrPage = { width: number; height: number; segments: SegmentDraft[]; stats: NonNullable<PageInfo['ocr']> };
/** Parses tesseract TSV into lines with word boxes (pixels) and confidences (0..1). */
export function parseTesseractTsv(tsv: string, lowConfidence: number): { width: number; height: number; lines: { words: Word[]; block: number; par: number; line: number }[]; stats: { words: number; mean: number | null; min: number | null; low: number; skew: number | null } } {
  const rows = tsv.split('\n');
  let width = 0, height = 0;
  const lines = new Map<string, { words: Word[]; block: number; par: number; line: number }>();
  const confs: number[] = [];
  for (const row of rows.slice(1)) {
    const c = row.split('\t');
    if (c.length < 12) continue;
    if (c[0] === '1') { width = Number(c[8]); height = Number(c[9]); continue; }
    const text = c.slice(11).join('\t');
    if (c[0] !== '5' || text.trim() === '') continue;
    const conf = Number(c[10]);
    const left = Number(c[6]), top = Number(c[7]);
    const word: Word = { t: text, b: [left, top, left + Number(c[8]), top + Number(c[9])], c: conf < 0 ? null : round(conf / 100, 4) };
    if (word.c !== null && word.c !== undefined) confs.push(word.c);
    const key = `${c[2]}.${c[3]}.${c[4]}`;
    const entry = lines.get(key) ?? { words: [], block: Number(c[2]), par: Number(c[3]), line: Number(c[4]) };
    entry.words.push(word); lines.set(key, entry);
  }
  // Skew estimate: median baseline slope across lines with enough words (least squares over word bottom centres).
  const slopes: number[] = [];
  for (const l of lines.values()) {
    if (l.words.length < 4) continue;
    const xs = l.words.map((w) => ((w.b as number[])[0] as number + ((w.b as number[])[2] as number)) / 2), ys = l.words.map((w) => (w.b as number[])[3] as number);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (den > 0) slopes.push(xs.reduce((a, x, i) => a + (x - mx) * ((ys[i] as number) - my), 0) / den);
  }
  slopes.sort((a, b) => a - b);
  const skew = slopes.length === 0 ? null : round(Math.atan(slopes[Math.floor(slopes.length / 2)] as number) * 180 / Math.PI, 2);
  return { width, height, lines: [...lines.values()], stats: { words: confs.length, mean: confs.length === 0 ? null : round(confs.reduce((a, b) => a + b, 0) / confs.length, 4), min: confs.length === 0 ? null : Math.min(...confs), low: confs.filter((c) => c < lowConfidence).length, skew } };
}
export async function tesseractLanguages(runner: ToolRunner): Promise<string[]> {
  if (await which('tesseract') === null) return [];
  return runner.workdir(async (cwd) => (await runner.run('tesseract', ['--list-langs'], { cwd, timeoutMs: 30_000 })).stdout.toString('utf8').split('\n').slice(1).map((l) => l.trim()).filter((l) => /^[a-z_A-Z0-9]+$/.test(l)));
}
/** Orientation and script detection. Returns null when the page has too little text for OSD to decide. */
export async function tesseractOsd(runner: ToolRunner, cwd: string, image: string): Promise<{ orientation: number; orientationConfidence: number; script: string; scriptConfidence: number } | null> {
  try {
    const r = await runner.run('tesseract', [image, 'stdout', '--psm', '0', '-l', 'osd'], { cwd, timeoutMs: 120_000 });
    const text = r.stdout.toString('utf8');
    const num = (name: string): number => Number(new RegExp(`${name}:\\s*([\\d.]+)`).exec(text)?.[1] ?? NaN);
    const script = /Script:\s*(\S+)/.exec(text)?.[1];
    if (script === undefined || Number.isNaN(num('Orientation in degrees'))) return null;
    return { orientation: num('Orientation in degrees'), orientationConfidence: num('Orientation confidence'), script, scriptConfidence: num('Script confidence') };
  } catch (error) { if (error instanceof DomainError && error.code === 'tool_failed') return null; throw error; }
}
/** Runs tesseract on one image. `scale` converts pixel boxes into the caller's page unit (e.g. PDF points). */
export async function ocrImage(runner: ToolRunner, cwd: string, image: string, options: { languages: string[]; page: number; scale: number; lowConfidence: number; dpi: number | null; searchablePdf?: string }): Promise<OcrPage> {
  const base = `ocr-${options.page}`;
  await runner.run('tesseract', [image, base, '-l', options.languages.join('+'), '--psm', '3', ...(options.dpi === null ? [] : ['--dpi', String(options.dpi)]), 'tsv', ...(options.searchablePdf === undefined ? [] : ['pdf'])], { cwd, timeoutMs: runner.limits.timeoutMs });
  const parsed = parseTesseractTsv(await readFile(join(cwd, `${base}.tsv`), 'utf8'), options.lowConfidence);
  await rm(join(cwd, `${base}.tsv`), { force: true });
  const k = options.scale;
  const segments: SegmentDraft[] = parsed.lines.map((l) => {
    const words = l.words.map((w) => ({ t: w.t, c: w.c ?? null, b: (w.b as number[]).map((v) => round(v * k)) as [number, number, number, number] }));
    const known = words.filter((w) => w.c !== null).map((w) => w.c as number);
    return {
      kind: 'line' as const, source: 'ocr' as const, page: options.page, text: words.map((w) => w.t).join(' '), words,
      bbox: [Math.min(...words.map((w) => w.b[0])), Math.min(...words.map((w) => w.b[1])), Math.max(...words.map((w) => w.b[2])), Math.max(...words.map((w) => w.b[3]))],
      anchor: { block: l.block, paragraph: l.par, line: l.line }, confidence: known.length === 0 ? null : round(known.reduce((a, b) => a + b, 0) / known.length, 4),
    };
  });
  return { width: parsed.width, height: parsed.height, segments, stats: { words: parsed.stats.words, meanConfidence: parsed.stats.mean, minConfidence: parsed.stats.min, lowConfidenceWords: parsed.stats.low, languages: options.languages, dpi: options.dpi, skewDegrees: parsed.stats.skew, orientationDegrees: null, script: null, scriptConfidence: null } };
}

// ───────────────────────────── Images ─────────────────────────────
export async function imageInfo(runner: ToolRunner, cwd: string, coder: string, file: string): Promise<{ width: number; height: number; dpi: number | null }> {
  const r = await runner.run('identify', ['-format', '%w %h %x %y %U\n', `${coder}:${file}[0]`], { cwd, timeoutMs: 60_000, maxStdoutBytes: 65536 });
  const [w, h, x, , unit] = r.stdout.toString('utf8').trim().split(/\s+/);
  let dpi: number | null = Number(x);
  if (!Number.isFinite(dpi) || dpi <= 0 || unit === 'Undefined') dpi = null; else if (unit === 'PixelsPerCentimeter') dpi = dpi * 2.54;
  invariant(Number(w) > 0 && Number(h) > 0, 'tool_failed', 'Image has no dimensions');
  return { width: Number(w), height: Number(h), dpi: dpi === null ? null : Math.round(dpi) };
}
/** Re-encodes any accepted raster into a clean PNG (first frame, orientation applied, metadata stripped). */
export async function imageToPng(runner: ToolRunner, cwd: string, coder: string, file: string, out: string, maxSide?: number): Promise<void> {
  await runner.run('convert', [`${coder}:${file}[0]`, '-auto-orient', ...(maxSide === undefined ? [] : ['-thumbnail', `${maxSide}x${maxSide}>`]), '-strip', `png:${out}`], { cwd });
}

// ───────────────────────────── Office, HTML, text, mail ─────────────────────────────
export function paragraphsOf(text: string, source: SegmentDraft['source'] = 'conversion'): SegmentDraft[] {
  const out: SegmentDraft[] = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  let index = 0;
  for (const m of text.replace(/\r\n?/g, '\n').matchAll(re)) {
    const body = m[0].trim();
    if (body === '') continue;
    index++;
    out.push({ kind: 'paragraph', source, text: body, anchor: { paragraph: index, charStart: m.index as number, charEnd: (m.index as number) + m[0].length }, confidence: null });
  }
  return out;
}
/** pandoc in sandbox mode: readers cannot touch the filesystem or network beyond the given input. */
export async function pandocToText(runner: ToolRunner, cwd: string, file: string, format: string): Promise<string> {
  const r = await runner.run('pandoc', ['--sandbox', '-f', format, '-t', 'plain', '--wrap=none', file], { cwd, noMemoryLimit: true });
  return r.stdout.toString('utf8');
}
/** LibreOffice headless conversion to PDF with a throwaway profile; links are not followed (dead proxy, no macros in headless convert). */
export async function officeToPdf(runner: ToolRunner, cwd: string, file: string): Promise<string> {
  await runner.run('soffice', [`-env:UserInstallation=file://${cwd}/lo-profile`, '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--convert-to', 'pdf', '--outdir', join(cwd, 'lo-out'), file], { cwd, noMemoryLimit: true });
  const produced = (await readdir(join(cwd, 'lo-out')).catch(() => [])).find((n) => n.endsWith('.pdf'));
  if (produced === undefined) throw new DomainError('tool_failed', 'soffice produced no PDF');
  return join(cwd, 'lo-out', produced);
}
function decodeTransfer(body: string, encoding: string, charset: string): string {
  let bytes: Buffer;
  if (encoding === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (encoding === 'quoted-printable') bytes = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  else bytes = Buffer.from(body, 'latin1');
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, data: string) => decodeTransfer(enc.toLowerCase() === 'b' ? data : data.replace(/_/g, ' '), enc.toLowerCase() === 'b' ? 'base64' : 'quoted-printable', cs));
}
/** Minimal RFC 822/MIME reader: headers plus the first text/plain part (or text/html part, returned separately). Attachments are ignored. */
export function parseEml(bytes: Uint8Array): { headers: Record<string, string>; text: string | null; html: string | null } {
  const raw = Buffer.from(bytes).toString('latin1');
  const part = (chunk: string, depth: number): { text: string | null; html: string | null; headers: Record<string, string> } => {
    const split = /\r?\n\r?\n/.exec(chunk);
    const headText = split === null ? chunk : chunk.slice(0, split.index), body = split === null ? '' : chunk.slice(split.index + split[0].length);
    const headers: Record<string, string> = {};
    for (const m of headText.replace(/\r?\n[ \t]+/g, ' ').matchAll(/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/gm)) headers[(m[1] as string).toLowerCase()] ??= decodeWords((m[2] as string).trim());
    const type = (headers['content-type'] ?? 'text/plain').toLowerCase();
    const charset = /charset="?([^";\s]+)"?/i.exec(headers['content-type'] ?? '')?.[1] ?? 'utf-8';
    const encoding = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase().trim();
    const boundary = /boundary="?([^";]+)"?/i.exec(headers['content-type'] ?? '')?.[1];
    if (type.startsWith('multipart/') && boundary !== undefined && depth < 6) {
      let text: string | null = null, html: string | null = null;
      for (const piece of body.split(`--${boundary}`).slice(1)) {
        if (piece.startsWith('--')) break;
        const inner = part(piece.replace(/^\r?\n/, ''), depth + 1);
        text ??= inner.text; html ??= inner.html;
      }
      return { headers, text, html };
    }
    if (/content-disposition:\s*attachment/i.test(headText)) return { headers, text: null, html: null };
    if (type.startsWith('text/html')) return { headers, text: null, html: decodeTransfer(body, encoding, charset) };
    if (type.startsWith('text/')) return { headers, text: decodeTransfer(body, encoding, charset), html: null };
    return { headers, text: null, html: null };
  };
  return part(raw, 0);
}

// ───────────────────────────── Audio / video ─────────────────────────────
export type MediaProbe = { durationMs: number | null; format: string | null; hasAudio: boolean; hasVideo: boolean; streams: { index: number; type: string; codec: string | null; sampleRate: number | null; channels: number | null; width: number | null; height: number | null; frameRate: string | null; timeBase: string | null; startTimeMs: number | null; language: string | null }[]; tags: Record<string, string> };
const FF_SAFE = ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe'];
export async function ffprobe(runner: ToolRunner, cwd: string, file: string): Promise<MediaProbe> {
  const r = await runner.run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_format', '-show_streams', file], { cwd, timeoutMs: 120_000, maxStdoutBytes: 4 * 1024 * 1024 });
  const doc = JSON.parse(r.stdout.toString('utf8')) as { format?: { duration?: string; format_name?: string; tags?: Record<string, string> }; streams?: Record<string, unknown>[] };
  const streams = (doc.streams ?? []).map((s) => ({
    index: Number(s.index), type: String(s.codec_type ?? 'unknown'), codec: typeof s.codec_name === 'string' ? s.codec_name : null,
    sampleRate: s.sample_rate === undefined ? null : Number(s.sample_rate), channels: typeof s.channels === 'number' ? s.channels : null,
    width: typeof s.width === 'number' ? s.width : null, height: typeof s.height === 'number' ? s.height : null,
    frameRate: typeof s.avg_frame_rate === 'string' && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : null, timeBase: typeof s.time_base === 'string' ? s.time_base : null,
    startTimeMs: s.start_time === undefined || Number.isNaN(Number(s.start_time)) ? null : Math.round(Number(s.start_time) * 1000),
    language: typeof (s.tags as Record<string, unknown> | undefined)?.language === 'string' ? String((s.tags as Record<string, string>).language) : null,
  }));
  const duration = Number(doc.format?.duration);
  // Attached cover art is a "video" stream with a single picture; only count real moving pictures.
  const hasVideo = (doc.streams ?? []).some((s) => s.codec_type === 'video' && (s.disposition as Record<string, number> | undefined)?.attached_pic !== 1);
  return { durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null, format: doc.format?.format_name ?? null, hasAudio: streams.some((s) => s.type === 'audio'), hasVideo, streams, tags: Object.fromEntries(Object.entries(doc.format?.tags ?? {}).slice(0, 50).map(([k, v]) => [k.slice(0, 80), String(v).slice(0, 500)])) };
}
/** Extracts and normalises the first audio stream to 16 kHz mono signed 16-bit PCM (raw) and WAV. */
export async function normalizeAudio(runner: ToolRunner, cwd: string, file: string, maxSeconds: number): Promise<{ raw: string; wav: string; durationMs: number }> {
  const raw = join(cwd, 'audio-16k.raw'), wav = join(cwd, 'audio-16k.wav');
  await runner.run('ffmpeg', [...FF_SAFE, '-v', 'error', '-y', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-t', String(maxSeconds), '-f', 's16le', raw], { cwd, noMemoryLimit: true });
  await runner.run('ffmpeg', [...FF_SAFE, '-v', 'error', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', raw, '-c:a', 'pcm_s16le', wav], { cwd, noMemoryLimit: true });
  return { raw, wav, durationMs: Math.round((await stat(raw)).size / 32) };
}
export async function videoFrame(runner: ToolRunner, cwd: string, file: string, atMs: number, out: string): Promise<void> {
  await runner.run('ffmpeg', [...FF_SAFE, '-v', 'error', '-y', '-ss', (atMs / 1000).toFixed(3), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=480:-2', '-f', 'image2', '-c:v', 'png', out], { cwd, noMemoryLimit: true });
}
export async function waveformImage(runner: ToolRunner, cwd: string, file: string, out: string): Promise<void> {
  await runner.run('ffmpeg', [...FF_SAFE, '-v', 'error', '-y', '-i', file, '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=800x200:colors=0x336699[v]', '-map', '[v]', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', out], { cwd, noMemoryLimit: true });
}

// ───────────────────────────── Embedded metadata ─────────────────────────────
const EXIF_DROP = /^(SourceFile|ExifTool:|System:|File:(FileName|Directory|FilePermissions|FileModifyDate|FileAccessDate|FileInodeChangeDate))/;
/** exiftool tags as observations. Embedded metadata is authored by whoever made the file and is trivially forged. */
export async function exifMetadata(runner: ToolRunner, cwd: string, file: string): Promise<Record<string, string | number | boolean>> {
  const r = await runner.run('exiftool', ['-json', '-G1', '-n', '-fast', '-charset', 'UTF8', '-api', 'LargeFileSupport=1', '--', file], { cwd, timeoutMs: 120_000, maxStdoutBytes: 8 * 1024 * 1024, allowExit: [1] });
  let doc: Record<string, unknown>;
  try { doc = (JSON.parse(r.stdout.toString('utf8')) as Record<string, unknown>[])[0] ?? {}; } catch { throw new DomainError('tool_failed', 'exiftool returned unreadable output'); }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (EXIF_DROP.test(k) || Object.keys(out).length >= 300) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 120)] = v;
    else if (typeof v === 'string') out[k.slice(0, 120)] = v.length > 1000 ? `${v.slice(0, 1000)}…` : v;
    else if (v !== null && v !== undefined) out[k.slice(0, 120)] = JSON.stringify(v).slice(0, 1000);
  }
  return out;
}
export async function writeInput(cwd: string, name: string, bytes: Uint8Array): Promise<string> {
  const path = join(cwd, name);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return path;
}

// ───────────────────────────── Language identification ─────────────────────────────
export type LanguageProfile = Readonly<{ script: string; iso1?: string; stopwords: readonly string[] }>;
export type LanguageGuess = { language: string | null; confidence: number; method: 'stopword-profile'; script: string | null; tokens: number; scores: Record<string, number> };
export function scriptOf(text: string): string | null {
  const counts: Record<string, number> = {};
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    const s = c >= 0x41 && c <= 0x24f ? (/\p{L}/u.test(ch) ? 'Latin' : null) : c >= 0x400 && c <= 0x52f ? 'Cyrillic' : c >= 0x370 && c <= 0x3ff ? 'Greek' : c >= 0x600 && c <= 0x6ff ? 'Arabic' : c >= 0x590 && c <= 0x5ff ? 'Hebrew' : c >= 0x900 && c <= 0x97f ? 'Devanagari' : c >= 0x4e00 && c <= 0x9fff ? 'Han' : null;
    if (s !== null) counts[s] = (counts[s] ?? 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best === undefined ? null : best[0];
}
/**
 * Function-word profile matching restricted to configured languages. This is a coarse identifier: it reports a
 * confidence derived from the margin between the best and second-best profile and the amount of text, and returns
 * null rather than a guess when the evidence is thin.
 */
export function detectLanguage(text: string, profiles: Readonly<Record<string, LanguageProfile>>): LanguageGuess {
  const tokens = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const script = scriptOf(text);
  const scores: Record<string, number> = {};
  for (const [code, p] of Object.entries(profiles)) {
    if (script !== null && p.script !== script) continue;
    const set = new Set(p.stopwords);
    scores[code] = tokens.length === 0 ? 0 : round(tokens.filter((t) => set.has(t)).length / tokens.length, 4);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = ranked[0], second = ranked[1];
  if (best === undefined || best[1] < 0.05 || tokens.length < 4) return { language: null, confidence: 0, method: 'stopword-profile', script, tokens: tokens.length, scores };
  const margin = (best[1] - (second?.[1] ?? 0)) / best[1];
  const confidence = round(Math.max(0, Math.min(0.99, margin * Math.min(1, tokens.length / 25) * Math.min(1, best[1] / 0.15))), 3);
  return { language: confidence >= 0.2 ? best[0] : null, confidence, method: 'stopword-profile', script, tokens: tokens.length, scores };
}
export const BUILTIN_PROFILES: Readonly<Record<string, LanguageProfile>> = {
  eng: { script: 'Latin', iso1: 'en', stopwords: ['the', 'and', 'of', 'to', 'in', 'is', 'was', 'for', 'that', 'on', 'with', 'as', 'it', 'at', 'by', 'this', 'be', 'are', 'from', 'or', 'an', 'not', 'were', 'we', 'have', 'has', 'which', 'their', 'but', 'they', 'a', 'before', 'more'] },
  spa: { script: 'Latin', iso1: 'es', stopwords: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'del', 'se', 'las', 'por', 'un', 'para', 'con', 'no', 'una', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'fue', 'este', 'ha', 'sí', 'porque', 'esta', 'entre', 'es'] },
  fra: { script: 'Latin', iso1: 'fr', stopwords: ['le', 'la', 'les', 'de', 'des', 'du', 'et', 'en', 'un', 'une', 'est', 'que', 'qui', 'dans', 'pour', 'pas', 'sur', 'au', 'avec', 'ce', 'il', 'elle', 'sont', 'par', 'ne', 'se', 'plus', 'nous', 'vous', 'mais', 'été', 'cette'] },
  deu: { script: 'Latin', iso1: 'de', stopwords: ['der', 'die', 'das', 'und', 'in', 'den', 'von', 'zu', 'mit', 'sich', 'des', 'auf', 'für', 'ist', 'im', 'dem', 'nicht', 'ein', 'eine', 'als', 'auch', 'es', 'an', 'werden', 'aus', 'er', 'hat', 'dass', 'sie', 'nach', 'wird', 'bei'] },
  por: { script: 'Latin', iso1: 'pt', stopwords: ['o', 'a', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'é', 'com', 'não', 'uma', 'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'mas', 'foi', 'ao', 'ele', 'das', 'tem', 'à', 'seu', 'sua'] },
  ukr: { script: 'Cyrillic', iso1: 'uk', stopwords: ['і', 'в', 'не', 'на', 'що', 'з', 'до', 'та', 'це', 'як', 'у', 'за', 'й', 'від', 'але', 'про', 'для', 'є', 'його', 'або', 'ми', 'ви', 'вони', 'він', 'вона', 'їх', 'був', 'була', 'ще', 'вже', 'при', 'так'] },
  rus: { script: 'Cyrillic', iso1: 'ru', stopwords: ['и', 'в', 'не', 'на', 'что', 'с', 'по', 'это', 'как', 'к', 'но', 'он', 'из', 'у', 'за', 'от', 'для', 'же', 'все', 'был', 'она', 'они', 'мы', 'вы', 'или', 'его', 'так', 'было', 'ещё', 'уже', 'при', 'то'] },
  bul: { script: 'Cyrillic', iso1: 'bg', stopwords: ['и', 'на', 'в', 'за', 'се', 'от', 'да', 'с', 'е', 'не', 'че', 'по', 'са', 'като', 'към', 'това', 'но', 'при', 'или', 'той', 'беше', 'бяха', 'със', 'още', 'до', 'го', 'ще', 'си', 'те', 'има'] },
};
