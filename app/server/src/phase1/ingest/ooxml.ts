/**
 * Office Open XML (.pptx / .xlsx) → Markdown, plus the zip guard shared with
 * the .docx path.
 *
 * All three formats are zip archives of XML parts. We read them with jszip +
 * @xmldom/xmldom (both already pulled in by mammoth) rather than a
 * per-format library, so the output keeps the structure the pipeline cares
 * about: slide boundaries, speaker notes, and sheets as tables.
 *
 * Zip-bomb guard: an upload is capped at 25 MB, but XML inflates far past that.
 * `openOoxml` rejects archives whose *declared* sizes are absurd, and every
 * part we inflate goes through a streaming reader with a shared byte budget —
 * declared sizes can lie, the stream can't.
 */
import JSZip from 'jszip';
import { createRequire } from 'node:module';

/**
 * The slice of the xmldom node API used here. xmldom is loaded through
 * require() so its typings stay out of the build: they carry
 * `/// <reference lib="dom" />`, which would pull browser DOM types into the
 * whole server (and break Node's Blob/fetch typings elsewhere).
 */
interface XmlElement {
  nodeType: number;
  localName: string;
  namespaceURI: string | null;
  textContent: string | null;
  firstChild: XmlElement | null;
  nextSibling: XmlElement | null;
  getAttribute(name: string): string | null;
  getAttributeNS(ns: string, name: string): string | null;
}
interface XmlDomParser {
  parseFromString(source: string, mime: string): { documentElement: XmlElement | null };
}
const { DOMParser } = createRequire(import.meta.url)('@xmldom/xmldom') as {
  DOMParser: new (options: {
    errorHandler: { warning(msg: string): void; error(msg: string): void; fatalError(msg: string): void };
  }) => XmlDomParser;
};

export interface OoxmlLimits {
  maxEntries: number;
  /** Sum of declared uncompressed sizes across the whole archive (media included). */
  maxDeclaredBytes: number;
  /** Bytes we will actually inflate across all XML parts read from one archive. */
  maxInflatedXmlBytes: number;
  /** Spreadsheet caps: the ingest pipeline is built for prose, not data dumps. */
  xlsxMaxRowsPerSheet: number;
  xlsxMaxCols: number;
  xlsxMaxChars: number;
}

export const DEFAULT_OOXML_LIMITS: OoxmlLimits = {
  maxEntries: 10_000,
  maxDeclaredBytes: 512 * 1024 * 1024,
  maxInflatedXmlBytes: 100 * 1024 * 1024,
  xlsxMaxRowsPerSheet: 500,
  xlsxMaxCols: 50,
  xlsxMaxChars: 100_000,
};

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export class OoxmlArchive {
  private inflated = 0;
  constructor(
    private readonly zip: JSZip,
    readonly limits: OoxmlLimits,
  ) {}

  has(name: string): boolean {
    return this.zip.file(name) !== null;
  }

  names(): string[] {
    return Object.values(this.zip.files)
      .filter((f) => !f.dir)
      .map((f) => f.name);
  }

  /** Inflate one part as UTF-8, aborting once the archive's budget is spent. */
  async text(name: string): Promise<string | null> {
    const entry = this.zip.file(name);
    if (!entry) return null;
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      // internalStream is public jszip API but missing from its .d.ts.
      const stream = (entry as unknown as {
        internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
      }).internalStream('uint8array');
      let done = false;
      stream
        .on('data', (chunk: Uint8Array) => {
          if (done) return;
          this.inflated += chunk.length;
          if (this.inflated > this.limits.maxInflatedXmlBytes) {
            done = true;
            stream.pause();
            reject(new Error('archive_too_large: decompressed content exceeds limit'));
            return;
          }
          chunks.push(chunk);
        })
        .on('error', (err: Error) => {
          if (!done) {
            done = true;
            reject(err);
          }
        })
        .on('end', () => {
          if (!done) {
            done = true;
            resolve();
          }
        })
        .resume();
    });
    return Buffer.concat(chunks).toString('utf8');
  }

  async xml(name: string): Promise<XmlElement | null> {
    const raw = await this.text(name);
    return raw === null ? null : parseXml(raw);
  }

  /** Relationship id → resolved part path for `part` (via its `_rels/*.rels`). */
  async rels(part: string): Promise<Map<string, { target: string; type: string }>> {
    const dir = part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : '';
    const base = part.slice(dir.length ? dir.length + 1 : 0);
    const root = await this.xml(`${dir ? dir + '/' : ''}_rels/${base}.rels`);
    const out = new Map<string, { target: string; type: string }>();
    if (!root) return out;
    for (const rel of descendants(root, 'Relationship')) {
      if (rel.getAttribute('TargetMode') === 'External') continue;
      out.set(rel.getAttribute('Id') ?? '', {
        target: resolvePart(dir, rel.getAttribute('Target') ?? ''),
        type: rel.getAttribute('Type') ?? '',
      });
    }
    return out;
  }
}

export async function openOoxml(buffer: Buffer, limits = DEFAULT_OOXML_LIMITS): Promise<OoxmlArchive> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('invalid_office_file: not a valid Office (zip) archive');
  }
  const entries = Object.values(zip.files);
  if (entries.length > limits.maxEntries) throw new Error('archive_too_large: too many entries');
  let declared = 0;
  for (const e of entries) {
    // `_data.uncompressedSize` is jszip-internal but stable; the streaming
    // budget in text() is the real guard.
    declared += (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  if (declared > limits.maxDeclaredBytes) throw new Error('archive_too_large: decompressed content exceeds limit');
  return new OoxmlArchive(zip, limits);
}

/**
 * Pre-flight for mammoth (.docx), which unzips on its own with no size
 * limit: inflate every XML part through the budgeted reader first so a zip
 * bomb fails here instead of inside mammoth. Media parts are skipped — the
 * docx converter never reads image bytes.
 */
export async function assertOoxmlWithinLimits(buffer: Buffer, limits = DEFAULT_OOXML_LIMITS): Promise<void> {
  const archive = await openOoxml(buffer, limits);
  for (const name of archive.names()) {
    if (/\.(xml|rels)$/i.test(name)) await archive.text(name);
  }
}

// ---------- .pptx ----------

const SKIP_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

/**
 * One `## Slide N — Title` section per visible slide, in presentation order,
 * with body text, tables as Markdown tables, and speaker notes. Hidden slides
 * are skipped (they're usually cut content); numbering still matches
 * PowerPoint's so "slide 7" means the same thing to the reader.
 */
export async function pptxToMarkdown(buffer: Buffer, limits = DEFAULT_OOXML_LIMITS): Promise<string> {
  const archive = await openOoxml(buffer, limits);
  const slides = await slideOrder(archive);
  const sections: string[] = [];
  for (const [i, part] of slides.entries()) {
    const root = await archive.xml(part);
    if (!root) continue;
    if (root.getAttribute('show') === '0') continue;
    const { title, blocks } = slideContent(root);
    const notes = await slideNotes(archive, part);
    const body = [...blocks];
    if (notes) body.push(`**Speaker notes:**\n${notes}`);
    if (!title && body.length === 0) continue;
    sections.push([`## Slide ${i + 1}${title ? ` — ${title}` : ''}`, ...body].join('\n\n'));
  }
  return sections.join('\n\n');
}

async function slideOrder(archive: OoxmlArchive): Promise<string[]> {
  const pres = await archive.xml('ppt/presentation.xml');
  if (pres) {
    const rels = await archive.rels('ppt/presentation.xml');
    const ordered = descendants(pres, 'sldId')
      .map((el) => rels.get(el.getAttributeNS(REL_NS, 'id') ?? '')?.target)
      .filter((p): p is string => !!p && archive.has(p));
    if (ordered.length) return ordered;
  }
  // No usable presentation.xml: fall back to slideN numbering.
  return archive
    .names()
    .map((n) => ({ n, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => x.n);
}

function slideContent(root: XmlElement): { title: string; blocks: string[] } {
  let title = '';
  const blocks: string[] = [];
  const walk = (el: XmlElement) => {
    for (const child of elementChildren(el)) {
      if (child.localName === 'sp') {
        const ph = placeholderType(child);
        if (ph && SKIP_PLACEHOLDERS.has(ph)) continue;
        const paras = paragraphs(child);
        if (!paras.length) continue;
        if (ph && TITLE_PLACEHOLDERS.has(ph) && !title) title = paras.join(' ');
        else blocks.push(paras.join('\n'));
      } else if (child.localName === 'tbl') {
        const rows = descendants(child, 'tr').map((tr) =>
          elementChildren(tr)
            .filter((tc) => tc.localName === 'tc')
            .map((tc) => paragraphs(tc).join(' ')),
        );
        const table = markdownTable(rows);
        if (table) blocks.push(table);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return { title, blocks };
}

async function slideNotes(archive: OoxmlArchive, slidePart: string): Promise<string> {
  const rels = await archive.rels(slidePart);
  const notesPart = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
  if (!notesPart) return '';
  const root = await archive.xml(notesPart);
  if (!root) return '';
  return descendants(root, 'sp')
    .filter((sp) => placeholderType(sp) === 'body')
    .flatMap((sp) => paragraphs(sp))
    .join('\n');
}

function placeholderType(sp: XmlElement): string | null {
  const ph = descendants(sp, 'ph')[0];
  if (!ph) return null;
  // A <p:ph> with no type is the body placeholder (ECMA-376 default).
  return ph.getAttribute('type') || 'body';
}

/** Non-empty DrawingML paragraphs (`a:p`) under `el`, runs concatenated. */
function paragraphs(el: XmlElement): string[] {
  const out: string[] = [];
  for (const p of descendants(el, 'p')) {
    if (p.namespaceURI !== 'http://schemas.openxmlformats.org/drawingml/2006/main') continue;
    let text = '';
    const visit = (n: XmlElement) => {
      for (const c of elementChildren(n)) {
        if (c.localName === 't') text += c.textContent ?? '';
        else if (c.localName === 'br') text += ' ';
        else visit(c);
      }
    };
    visit(p);
    text = text.replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

// ---------- .xlsx ----------

// Built-in number formats that render as dates/times (ECMA-376 §18.8.30).
export const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/**
 * One `## Sheet: Name` section per visible worksheet, rendered as a Markdown
 * table (first non-empty row as the header). Cells use their cached values;
 * a formula with no cached value is shown as `=FORMULA`. Rows, columns, and
 * total length are capped and truncation is stated inline so the reader
 * knows the table is partial.
 */
export async function xlsxToMarkdown(buffer: Buffer, limits = DEFAULT_OOXML_LIMITS): Promise<string> {
  const archive = await openOoxml(buffer, limits);
  const workbook = await archive.xml('xl/workbook.xml');
  if (!workbook) throw new Error('invalid_office_file: missing xl/workbook.xml');
  const rels = await archive.rels('xl/workbook.xml');
  const shared = await sharedStrings(archive);
  const dateStyles = await dateStyleIndexes(archive);
  const date1904 = descendants(workbook, 'workbookPr')[0]?.getAttribute('date1904');
  const epoch = date1904 === '1' || date1904 === 'true' ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);

  const sheets: SheetRows[] = [];
  for (const [i, sheet] of descendants(workbook, 'sheet').entries()) {
    const state = sheet.getAttribute('state');
    if (state === 'hidden' || state === 'veryHidden') continue;
    const part = rels.get(sheet.getAttributeNS(REL_NS, 'id') ?? '')?.target;
    if (!part || !part.includes('/worksheets/')) continue; // chartsheets, dialog sheets
    const root = await archive.xml(part);
    if (!root) continue;
    sheets.push({
      name: sheet.getAttribute('name') ?? `Sheet ${i + 1}`,
      rows: sheetRows(root, shared, dateStyles, epoch),
    });
  }
  return renderWorkbook(sheets, limits);
}

/** A worksheet's non-empty rows in order; each maps column index → cell text. */
export interface SheetRows {
  name: string;
  rows: Map<number, string>[];
}

/**
 * Shared by .xlsx and legacy .xls: one `## Sheet: Name` Markdown table per
 * non-empty sheet, with the row/column/length caps stated inline.
 */
export function renderWorkbook(sheets: SheetRows[], limits: OoxmlLimits): string {
  const sections: string[] = [];
  let length = 0;
  for (const sheet of sheets) {
    const section = renderSheet(sheet, limits);
    if (!section) continue;
    if (length + section.length > limits.xlsxMaxChars) {
      sections.push(
        `_[Truncated: remaining sheets omitted — workbook exceeds ${limits.xlsxMaxChars.toLocaleString('en-US')} characters.]_`,
      );
      break;
    }
    sections.push(section);
    length += section.length;
  }
  return sections.join('\n\n');
}

async function sharedStrings(archive: OoxmlArchive): Promise<string[]> {
  const root = await archive.xml('xl/sharedStrings.xml');
  if (!root) return [];
  return elementChildren(root)
    .filter((si) => si.localName === 'si')
    .map(richText);
}

/** Text of an `si` / `is` element, excluding phonetic (`rPh`) runs. */
function richText(el: XmlElement): string {
  let text = '';
  const visit = (n: XmlElement) => {
    for (const c of elementChildren(n)) {
      if (c.localName === 'rPh') continue;
      if (c.localName === 't') text += c.textContent ?? '';
      else visit(c);
    }
  };
  visit(el);
  return text;
}

async function dateStyleIndexes(archive: OoxmlArchive): Promise<Set<number>> {
  const out = new Set<number>();
  const root = await archive.xml('xl/styles.xml');
  if (!root) return out;
  const custom = new Map<number, string>();
  for (const fmt of descendants(root, 'numFmt')) {
    custom.set(Number(fmt.getAttribute('numFmtId')), fmt.getAttribute('formatCode') ?? '');
  }
  const cellXfs = descendants(root, 'cellXfs')[0];
  if (!cellXfs) return out;
  elementChildren(cellXfs)
    .filter((xf) => xf.localName === 'xf')
    .forEach((xf, idx) => {
      const id = Number(xf.getAttribute('numFmtId') ?? 0);
      const code = custom.get(id);
      if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) out.add(idx);
    });
  return out;
}

export function isDateFormatCode(code: string): boolean {
  // Drop quoted literals, escaped chars, and [colour]/[locale] blocks
  // (but keep elapsed-time blocks like [h]) before looking for date tokens.
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
  return /[dmyhs]/i.test(stripped);
}

function sheetRows(root: XmlElement, shared: string[], dateStyles: Set<number>, epoch: number): Map<number, string>[] {
  const rows: Map<number, string>[] = [];
  const sheetData = descendants(root, 'sheetData')[0];
  if (!sheetData) return rows;
  for (const row of elementChildren(sheetData)) {
    if (row.localName !== 'row') continue;
    const cells = new Map<number, string>();
    let pos = 0;
    for (const c of elementChildren(row)) {
      if (c.localName !== 'c') continue;
      const ref = c.getAttribute('r');
      const col = ref ? columnIndex(ref) : pos;
      pos = col + 1;
      const value = cellValue(c, shared, dateStyles, epoch).trim();
      if (value) cells.set(col, value);
    }
    if (cells.size) rows.push(cells);
  }
  return rows;
}

function renderSheet({ name, rows: all }: SheetRows, limits: OoxmlLimits): string {
  const rows = all.filter((r) => r.size).slice(0, limits.xlsxMaxRowsPerSheet);
  if (!rows.length) return '';
  const totalRows = all.filter((r) => r.size).length;
  let minCol = Infinity;
  let maxCol = -1;
  for (const cells of rows) {
    for (const col of cells.keys()) {
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
    }
  }
  const lastCol = Math.min(maxCol, minCol + limits.xlsxMaxCols - 1);
  const grid = rows.map((cells) => {
    const out: string[] = [];
    for (let col = minCol; col <= lastCol; col++) out.push(cells.get(col) ?? '');
    return out;
  });
  const notes: string[] = [];
  if (totalRows > rows.length) notes.push(`showing first ${rows.length} of ${totalRows} rows`);
  if (maxCol > lastCol) notes.push(`showing first ${limits.xlsxMaxCols} of ${maxCol - minCol + 1} columns`);
  const parts = [`## Sheet: ${name}`, markdownTable(grid)];
  if (notes.length) parts.push(`_[Truncated: ${notes.join('; ')}.]_`);
  return parts.join('\n\n');
}

function cellValue(c: XmlElement, shared: string[], dateStyles: Set<number>, epoch: number): string {
  const type = c.getAttribute('t') ?? 'n';
  const child = (n: string) => elementChildren(c).find((e) => e.localName === n);
  const v = child('v')?.textContent ?? null;
  if (type === 'inlineStr') {
    const is = child('is');
    return is ? richText(is) : '';
  }
  if (v === null || v === '') {
    const f = child('f')?.textContent;
    return f ? `=${f}` : '';
  }
  switch (type) {
    case 's':
      return shared[Number(v)] ?? '';
    case 'b':
      return v === '1' ? 'TRUE' : 'FALSE';
    case 'str':
    case 'e':
      return v;
    default: {
      const n = Number(v);
      if (!Number.isFinite(n)) return v;
      const style = Number(c.getAttribute('s') ?? 0);
      if (dateStyles.has(style)) return serialToDate(n, epoch);
      return formatNumber(n);
    }
  }
}

/** Strip binary float noise (0.1+0.2 → 0.3) without rounding real precision. */
export function formatNumber(n: number): string {
  return String(Number(n.toPrecision(15)));
}

/** Spreadsheet date serial → ISO date / date-time / time. */
export function serialToDate(serial: number, epoch: number): string {
  const ms = Math.round(serial * 86_400_000);
  const iso = new Date(epoch + ms).toISOString();
  const day = Math.floor(serial);
  const hasTime = Math.abs(serial - day) > 1e-9;
  if (day === 0 && hasTime) return iso.slice(11, 16);
  return hasTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** "BC12" → 54 (zero-based column index). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- shared helpers ----------

export function markdownTable(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!width) return '';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`;
  const [header, ...body] = rows;
  return [line(header ?? []), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
}

function parseXml(raw: string): XmlElement {
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => {},
      fatalError: (msg: string) => {
        throw new Error(`invalid_office_file: ${msg}`);
      },
    },
  }).parseFromString(raw, 'text/xml');
  const root = doc.documentElement;
  if (!root) throw new Error('invalid_office_file: empty XML part');
  return root;
}

function elementChildren(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}

function descendants(el: XmlElement, localName: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (n: XmlElement) => {
    for (const c of elementChildren(n)) {
      if (c.localName === localName) out.push(c);
      visit(c);
    }
  };
  visit(el);
  return out;
}

/** Resolve a relationship Target against the source part's directory. */
function resolvePart(dir: string, target: string): string {
  const segments = target.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  return segments.join('/');
}
