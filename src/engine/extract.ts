// Structured extraction proposals: deterministic, rule-based candidates found in processed text (dates, money amounts,
// reference numbers, links, simple tables), each tied to an exact span of a stored segment. They are proposals, never
// facts: a person or another engine decides what they mean. E-mail addresses and phone numbers are deliberately not
// extracted (personal data). Pure functions; no I/O.

export type ExtractSegment = Readonly<{ text: string }>;
export type Span = Readonly<{ segment: number; start: number; end: number; quote: string }>;
export type Candidate =
  | Readonly<{ type: 'date'; span: Span; normalized: string | null; readings?: readonly string[]; pattern: string }>
  | Readonly<{ type: 'amount'; span: Span; currency: string; minorUnits: number | null; value: string; pattern: string }>
  | Readonly<{ type: 'reference'; span: Span; value: string; pattern: string }>
  | Readonly<{ type: 'link'; span: Span; value: string; pattern: string }>
  | Readonly<{ type: 'table'; segments: readonly number[]; delimiter: string; rows: readonly (readonly string[])[]; pattern: string }>;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const month = (name: string): number => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().replace('.', '').slice(0, 3))) + 1;
const pad = (n: number): string => String(n).padStart(2, '0');
const validDate = (y: number, m: number, d: number): boolean => {
  if (m < 1 || m > 12 || d < 1 || y < 1000 || y > 2999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const iso = (y: number, m: number, d: number): string | null => (validDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB', '₴': 'UAH', '₦': 'NGN', '₩': 'KRW', '₺': 'TRY', 'R$': 'BRL' };
const CODES = 'USD|EUR|GBP|JPY|CHF|CAD|AUD|INR|BRL|MXN|ZAR|NGN|KES|UAH|RUB|PLN|SEK|NOK|DKK|CZK|HUF|RON|TRY|KRW|CNY|ARS|COP|CLP|PEN';
const ZERO_DECIMALS = new Set(['JPY', 'KRW', 'CLP']);

/** Parses "1,234.56" / "1.234,56" / "1 234,56" / "1234"; returns minor units or null when ambiguous. */
export function parseAmount(raw: string, currency: string): number | null {
  const s = raw.replace(/[\s  ']/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let integer: string, fraction = '';
  if (lastDot === -1 && lastComma === -1) integer = s;
  else {
    const sep = lastDot > lastComma ? '.' : ',';
    const tail = s.slice(Math.max(lastDot, lastComma) + 1);
    const other = sep === '.' ? ',' : '.';
    if (tail.length === 3 && !s.includes(other) && s.split(sep).length > 2) { integer = s.split(sep).join(''); }        // 1.234.567
    else if (tail.length === 3 && !s.includes(other)) return null;                                                      // "1,234" or "1.234": thousands or decimals?
    else { integer = s.slice(0, Math.max(lastDot, lastComma)).split(other).join(''); fraction = tail; }
  }
  if (!/^\d+$/.test(integer) || (fraction !== '' && !/^\d{1,2}$/.test(fraction))) return null;
  const decimals = ZERO_DECIMALS.has(currency) ? 0 : 2;
  if (decimals === 0) return fraction === '' ? Number(integer) : null;
  const minor = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> { re.lastIndex = 0; let m: RegExpExecArray | null; while ((m = re.exec(text)) !== null) { yield m; if (m[0].length === 0) re.lastIndex++; } }

export function extractCandidates(segments: readonly ExtractSegment[], options: { max?: number } = {}): Candidate[] {
  const out: Candidate[] = []; const max = options.max ?? 500;
  const taken = new Map<number, [number, number][]>();
  const overlaps = (seg: number, start: number, end: number): boolean => (taken.get(seg) ?? []).some(([a, b]) => start < b && end > a);
  const take = (seg: number, start: number, end: number): void => { taken.set(seg, [...(taken.get(seg) ?? []), [start, end]]); };
  const span = (segment: number, m: RegExpExecArray, group = 0): Span => {
    const quote = m[group] as string; const start = m.index + (group === 0 ? 0 : (m[0] as string).indexOf(quote));
    return { segment, start, end: start + quote.length, quote };
  };
  segments.forEach((seg, i) => {
    const text = seg.text;
    if (out.length >= max) return;
    // Links first, so their digits are not read as dates or amounts.
    for (const m of matches(/\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g, text)) { const s = span(i, m); take(i, s.start, s.end); out.push({ type: 'link', span: s, value: s.quote, pattern: 'url' }); }
    for (const m of matches(/\b(\d{4})-(\d{2})-(\d{2})\b/g, text)) {
      const s = span(i, m); if (overlaps(i, s.start, s.end)) continue;
      const n = iso(Number(m[1]), Number(m[2]), Number(m[3])); if (n === null) continue;
      take(i, s.start, s.end); out.push({ type: 'date', span: s, normalized: n, pattern: 'iso' });
    }
    for (const m of matches(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?\\s+(\\d{4})\\b`, 'gi'), text)) {
      const s = span(i, m); if (overlaps(i, s.start, s.end)) continue;
      const n = iso(Number(m[3]), month(m[2] as string), Number(m[1])); if (n === null) continue;
      take(i, s.start, s.end); out.push({ type: 'date', span: s, normalized: n, pattern: 'day month year' });
    }
    for (const m of matches(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), text)) {
      const s = span(i, m); if (overlaps(i, s.start, s.end)) continue;
      const n = iso(Number(m[3]), month(m[1] as string), Number(m[2])); if (n === null) continue;
      take(i, s.start, s.end); out.push({ type: 'date', span: s, normalized: n, pattern: 'month day year' });
    }
    for (const m of matches(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g, text)) {
      const s = span(i, m); if (overlaps(i, s.start, s.end)) continue;
      const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
      const dm = iso(y, b, a), md = iso(y, a, b);
      if (dm === null && md === null) continue;
      take(i, s.start, s.end);
      // 03/04/2019 is ambiguous between day-first and month-first: both readings are reported, none chosen.
      if (dm !== null && md !== null && dm !== md) out.push({ type: 'date', span: s, normalized: null, readings: [dm, md], pattern: 'numeric, ambiguous order' });
      else out.push({ type: 'date', span: s, normalized: (dm ?? md) as string, pattern: 'numeric' });
    }
    const amountRe = new RegExp(`(?:(R\\$|[€$£¥₹₽₴₦₩₺])\\s?(\\d[\\d.,\\s\\u00a0']*\\d|\\d)|\\b(${CODES})\\s?(\\d[\\d.,\\s\\u00a0']*\\d|\\d)|(\\d[\\d.,\\s\\u00a0']*\\d|\\d)\\s?(${CODES}|[€£₹₽₴₦₩₺])(?![A-Za-z]))`, 'g');
    for (const m of matches(amountRe, text)) {
      const s = span(i, m); if (overlaps(i, s.start, s.end)) continue;
      const symbol = m[1] ?? m[6] ?? null; const code = m[3] ?? (m[6] !== undefined && /^[A-Z]{3}$/.test(m[6]) ? m[6] : null);
      const currency = code ?? CURRENCY_SYMBOLS[symbol as string] ?? 'unknown';
      const value = (m[2] ?? m[4] ?? m[5] ?? '').trim();
      take(i, s.start, s.end);
      out.push({ type: 'amount', span: { ...s, quote: s.quote.trimEnd(), end: s.start + s.quote.trimEnd().length }, currency, minorUnits: currency === 'unknown' ? null : parseAmount(value, currency), value, pattern: symbol === '$' ? 'dollar sign (currency assumed USD; may be another dollar)' : 'currency and number' });
    }
    for (const m of matches(/\b(?:Ref(?:erence)?\.?|No\.|Nr\.|Case|File|Invoice|Contract|Order|Decision|Resolution)\s*(?:no\.?|number|#)?\s*:?\s*([A-Z0-9][A-Z0-9/._-]{2,40}\d[A-Z0-9/._-]*)/gi, text)) {
      const full = span(i, m, 1);
      const quote = full.quote.replace(/[._/-]+$/, ''); // sentence punctuation is not part of the reference
      const s = { ...full, quote, end: full.start + quote.length };
      if (overlaps(i, s.start, s.end)) continue;
      take(i, s.start, s.end); out.push({ type: 'reference', span: s, value: s.quote, pattern: 'labelled reference' });
    }
  });
  // Tables: runs of at least two consecutive single-line segments split into the same number (≥ 2) of cells by the same delimiter.
  const split = (t: string): { delimiter: string; cells: string[] } | null => {
    if (t.includes('\n')) return null;
    for (const [delimiter, re] of [['|', /\s*\|\s*/], ['tab', /\t+/], [';', /\s*;\s*/], ['spaces', / {2,}/]] as const) {
      const cells = t.trim().replace(/^\|\s*|\s*\|$/g, '').split(re).map((c) => c.trim());
      if (cells.length >= 2 && cells.every((c) => c !== '')) return { delimiter, cells };
    }
    return null;
  };
  for (let i = 0; i < segments.length && out.length < max;) {
    const first = split(segments[i]?.text ?? '');
    if (first === null) { i++; continue; }
    const rows = [first.cells]; const idx = [i];
    let j = i + 1;
    for (; j < segments.length; j++) {
      const next = split(segments[j]?.text ?? '');
      if (next === null || next.delimiter !== first.delimiter || next.cells.length !== first.cells.length) break;
      rows.push(next.cells); idx.push(j);
    }
    if (rows.length >= 2) out.push({ type: 'table', segments: idx, delimiter: first.delimiter, rows, pattern: `${rows.length} rows × ${first.cells.length} columns, delimiter ${first.delimiter}` });
    i = j;
  }
  return out.slice(0, max);
}
