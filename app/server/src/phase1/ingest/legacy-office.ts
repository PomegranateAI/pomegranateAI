/**
 * Legacy binary Office (.doc / .ppt / .xls, Office 97–2003) → text/Markdown.
 *
 * These are OLE2 Compound File (CFB) containers, not zips. `cfb` reads the
 * container; the record formats inside are parsed here, keeping only what
 * ingest needs — text, slide order + notes, sheet cell values — and matching
 * the .docx/.pptx/.xlsx output shape. Specs: [MS-DOC], [MS-PPT], [MS-XLS].
 *
 * Scope: Word 97+, PowerPoint 97+, Excel 97+ (BIFF8). Excel 5/95 (BIFF5) and
 * password-protected files fail with a clear error. The container is
 * uncompressed and the upload is already size-capped, so there is no
 * zip-bomb analogue; parsing is bounds-checked and any malformed input
 * surfaces as `invalid_office_file`.
 */
import CFB from 'cfb';
import {
  BUILTIN_DATE_FORMATS,
  DEFAULT_OOXML_LIMITS,
  formatNumber,
  isDateFormatCode,
  renderWorkbook,
  serialToDate,
  type SheetRows,
} from './ooxml.js';

class LegacyOfficeError extends Error {}

function invalid(detail: string): never {
  throw new LegacyOfficeError(`invalid_office_file: ${detail}`);
}

/** Run a parser, mapping any stray RangeError etc. from corrupt input to `invalid_office_file`. */
function guarded<T>(kind: string, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof LegacyOfficeError) throw err;
    invalid(`malformed ${kind} file`);
  }
}

function openCfb(buffer: Buffer): CFB.CFB$Container {
  try {
    return CFB.read(buffer, { type: 'buffer' });
  } catch {
    invalid('not a valid legacy Office (OLE2) file');
  }
}

function stream(cfb: CFB.CFB$Container, name: string): Buffer | null {
  const entry = cfb.FileIndex.find((e) => e.type === 2 && e.name === name);
  return entry?.content ? Buffer.from(entry.content as Uint8Array) : null;
}

// ---------- .doc ----------

/**
 * Word 97–2003: main-document text reassembled from the piece table (CLX),
 * with field codes dropped (field results kept) and table cells joined with
 * ` | `. Formatting is not carried over.
 */
export function docToText(buffer: Buffer): string {
  const cfb = openCfb(buffer);
  return guarded('Word', () => {
    const word = stream(cfb, 'WordDocument');
    if (!word) invalid('missing WordDocument stream');
    if (word.readUInt16LE(0) !== 0xa5ec) invalid('not a Word 97+ document');
    const flags = word.readUInt16LE(0x0a);
    if (flags & 0x0100) throw new LegacyOfficeError('encrypted_office_file: password-protected documents are not supported');
    const table = stream(cfb, flags & 0x0200 ? '1Table' : '0Table');
    if (!table) invalid('missing table stream');

    // FIB: fixed base, then variable-length FibRgW / FibRgLw / FibRgFcLcb.
    let off = 32;
    off += 2 + word.readUInt16LE(off) * 2; // csw + fibRgW
    const lwBase = off + 2;
    off = lwBase + word.readUInt16LE(off) * 4; // cslw + fibRgLw
    const ccpText = word.readInt32LE(lwBase + 3 * 4);
    const cbRgFcLcb = word.readUInt16LE(off);
    if (cbRgFcLcb < 34) invalid('FIB too short');
    const fcBase = off + 2;
    const fcClx = word.readUInt32LE(fcBase + 66 * 4);
    const lcbClx = word.readUInt32LE(fcBase + 67 * 4);

    // CLX: skip Prc entries (0x01), then the Pcdt (0x02) holding the PlcPcd.
    let p = fcClx;
    const clxEnd = fcClx + lcbClx;
    while (p < clxEnd && table[p] === 0x01) p += 3 + table.readUInt16LE(p + 1);
    if (table[p] !== 0x02) invalid('missing piece table');
    const lcb = table.readUInt32LE(p + 1);
    const plc = p + 5;
    const pieces = (lcb - 4) / 12;
    if (!Number.isInteger(pieces) || pieces < 1) invalid('bad piece table');

    const cp1252 = new TextDecoder('windows-1252');
    let raw = '';
    let prevCp = 0;
    for (let i = 0; i < pieces; i++) {
      const cpStart = table.readUInt32LE(plc + i * 4);
      if (cpStart >= ccpText) break;
      if (cpStart < prevCp) invalid('piece table out of order');
      const len = Math.min(table.readUInt32LE(plc + (i + 1) * 4), ccpText) - cpStart;
      if (len <= 0) continue;
      prevCp = cpStart + len;
      const fcRaw = table.readUInt32LE(plc + (pieces + 1) * 4 + i * 8 + 2);
      const fc = fcRaw & 0x3fffffff;
      raw +=
        fcRaw & 0x40000000
          ? cp1252.decode(word.subarray(fc / 2, fc / 2 + len))
          : word.toString('utf16le', fc, fc + len * 2);
      // Text can't be longer than the stream holding it; anything else is a
      // crafted piece table pointing many pieces at the same bytes.
      if (raw.length > word.length) invalid('piece table exceeds document size');
    }
    return cleanWordText(raw);
  });
}

function cleanWordText(raw: string): string {
  // Fields: \x13 code \x14 result \x15 (nestable) — keep only the result.
  let out = '';
  const inCode: boolean[] = [];
  for (const ch of raw) {
    if (ch === '\x13') inCode.push(true);
    else if (ch === '\x14') {
      if (inCode.length) inCode[inCode.length - 1] = false;
    }
    else if (ch === '\x15') inCode.pop();
    else if (!inCode.includes(true)) out += ch;
  }
  return out
    .replace(/\x07\x07/g, '\n') // cell mark + row-end mark
    .replace(/\x07/g, ' | ') // cell mark
    .replace(/[\r\x0b\x0c\x0e]/g, '\n') // paragraph, line, page, column breaks
    .replace(/\x1e/g, '-') // non-breaking hyphen
    .replace(/[\x00-\x08\x0f-\x1f]/g, '') // optional hyphen, object anchors, footnote refs
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- .ppt ----------

interface Rec {
  type: number;
  instance: number;
  ver: number;
  body: number;
  end: number;
}

const RT = {
  document: 0x03e8,
  slide: 0x03ee,
  slideAtom: 0x03ef,
  notes: 0x03f0,
  slidePersistAtom: 0x03f3,
  mainMaster: 0x03f8,
  slideShowSlideInfoAtom: 0x03f9,
  outlineTextRefAtom: 0x0f9e,
  textHeaderAtom: 0x0f9f,
  textCharsAtom: 0x0fa0,
  textBytesAtom: 0x0fa8,
  slideListWithText: 0x0ff0,
  userEditAtom: 0x0ff5,
  persistDirectoryAtom: 0x1772,
} as const;

/** TextHeaderAtom textType values. */
const TEXT_TITLE = new Set([0, 6]);
const TEXT_NOTES = 2;
const MAX_DEPTH = 64;

function recAt(buf: Buffer, off: number): Rec | null {
  if (off < 0 || off + 8 > buf.length) return null;
  const verInstance = buf.readUInt16LE(off);
  const len = buf.readUInt32LE(off + 4);
  return {
    ver: verInstance & 0xf,
    instance: verInstance >> 4,
    type: buf.readUInt16LE(off + 2),
    body: off + 8,
    end: Math.min(buf.length, off + 8 + len),
  };
}

function children(buf: Buffer, rec: Rec): Rec[] {
  const out: Rec[] = [];
  if (rec.ver !== 0xf) return out;
  for (let off = rec.body; off + 8 <= rec.end; ) {
    const child = recAt(buf, off)!;
    out.push(child);
    off = child.body + buf.readUInt32LE(off + 4);
  }
  return out;
}

interface PptText {
  type: number;
  text: string;
}

function atomText(buf: Buffer, rec: Rec): string {
  return rec.type === RT.textCharsAtom
    ? buf.toString('utf16le', rec.body, rec.end)
    : buf.toString('latin1', rec.body, rec.end);
}

/** Text atoms under `rec` in document order; OutlineTextRefAtoms resolve into `outline`. */
function collectTexts(buf: Buffer, rec: Rec, outline: PptText[], used: Set<number>): PptText[] {
  const out: PptText[] = [];
  let type = 4; // "other" until a TextHeaderAtom says otherwise
  const walk = (r: Rec, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const c of children(buf, r)) {
      if (c.type === RT.textHeaderAtom) type = buf.readUInt32LE(c.body);
      else if (c.type === RT.textCharsAtom || c.type === RT.textBytesAtom) out.push({ type, text: atomText(buf, c) });
      else if (c.type === RT.outlineTextRefAtom) {
        const idx = buf.readInt32LE(c.body);
        const ref = outline[idx];
        if (ref && !used.has(idx)) {
          out.push(ref);
          used.add(idx);
        }
      } else if (c.ver === 0xf) walk(c, depth + 1);
    }
  };
  walk(rec, 0);
  return out;
}

function lines(texts: PptText[]): string[] {
  return texts
    .flatMap((t) => t.text.split('\r'))
    .map((l) => l.replace(/[\x0b\s]+/g, ' ').trim())
    .filter(Boolean);
}

interface SlideEntry {
  persistId: number;
  slideId: number;
  texts: PptText[];
}

function slideList(buf: Buffer, docRec: Rec, instance: number): SlideEntry[] {
  const list = children(buf, docRec).find((c) => c.type === RT.slideListWithText && c.instance === instance);
  if (!list) return [];
  const out: SlideEntry[] = [];
  let type = 4;
  for (const c of children(buf, list)) {
    if (c.type === RT.slidePersistAtom) {
      out.push({ persistId: buf.readUInt32LE(c.body), slideId: buf.readUInt32LE(c.body + 12), texts: [] });
    } else if (c.type === RT.textHeaderAtom) {
      type = buf.readUInt32LE(c.body);
    } else if ((c.type === RT.textCharsAtom || c.type === RT.textBytesAtom) && out.length) {
      out[out.length - 1]!.texts.push({ type, text: atomText(buf, c) });
    }
  }
  return out;
}

/**
 * PowerPoint 97–2003: `## Slide N — Title` sections in presentation order
 * (via the persist directory of the latest edit), with speaker notes; hidden
 * slides skipped. Falls back to a flat scan of all non-master text when the
 * persist chain can't be followed.
 */
export function pptToMarkdown(buffer: Buffer): string {
  const cfb = openCfb(buffer);
  return guarded('PowerPoint', () => {
    const doc = stream(cfb, 'PowerPoint Document');
    if (!doc) invalid('missing PowerPoint Document stream');
    const user = stream(cfb, 'Current User');
    if (user && user.length >= 20 && user.readUInt32LE(12) === 0xf3d1c4df) {
      throw new LegacyOfficeError('encrypted_office_file: password-protected presentations are not supported');
    }

    // Persist directory: newest edit first, so newer entries win.
    const persist = new Map<number, number>();
    let docPersistId: number | null = null;
    const seen = new Set<number>();
    let editOff = user && user.length >= 20 ? user.readUInt32LE(16) : -1;
    while (editOff >= 0 && !seen.has(editOff)) {
      seen.add(editOff);
      const edit = recAt(doc, editOff);
      if (!edit || edit.type !== RT.userEditAtom) break;
      docPersistId ??= doc.readUInt32LE(edit.body + 16);
      const dir = recAt(doc, doc.readUInt32LE(edit.body + 12));
      if (dir?.type === RT.persistDirectoryAtom) {
        for (let p = dir.body; p + 4 <= dir.end; ) {
          const head = doc.readUInt32LE(p);
          const first = head & 0xfffff;
          const count = head >>> 20;
          p += 4;
          for (let k = 0; k < count && p + 4 <= dir.end; k++, p += 4) {
            if (!persist.has(first + k)) persist.set(first + k, doc.readUInt32LE(p));
          }
        }
      }
      const last = doc.readUInt32LE(edit.body + 8);
      editOff = last === 0 ? -1 : last;
    }

    const docRec = docPersistId !== null ? recAt(doc, persist.get(docPersistId) ?? -1) : null;
    if (docRec?.type !== RT.document) return flatPptText(doc);

    const slides = slideList(doc, docRec, 0);
    const notesById = new Map(slideList(doc, docRec, 2).map((n) => [n.slideId, n]));
    const sections: string[] = [];
    const visited = new Set<number>(); // a crafted list can point every slide at one container
    for (const [i, entry] of slides.entries()) {
      const offset = persist.get(entry.persistId) ?? -1;
      if (visited.has(offset)) continue;
      visited.add(offset);
      const slide = recAt(doc, offset);
      if (slide?.type !== RT.slide) continue;
      const kids = children(doc, slide);
      const showInfo = kids.find((c) => c.type === RT.slideShowSlideInfoAtom);
      if (showInfo && doc[showInfo.body + 10]! & 0x04) continue; // fHidden

      const used = new Set<number>();
      const texts = collectTexts(doc, slide, entry.texts, used);
      entry.texts.forEach((t, idx) => used.has(idx) || texts.push(t));
      const title = lines(texts.filter((t) => TEXT_TITLE.has(t.type))).join(' ');
      const body = lines(texts.filter((t) => !TEXT_TITLE.has(t.type)));

      let notes: string[] = [];
      const slideAtom = kids.find((c) => c.type === RT.slideAtom);
      const notesEntry = slideAtom ? notesById.get(doc.readUInt32LE(slideAtom.body + 16)) : undefined;
      const notesOffset = notesEntry ? (persist.get(notesEntry.persistId) ?? -1) : -1;
      const notesRec = notesOffset >= 0 && !visited.has(notesOffset) ? recAt(doc, notesOffset) : null;
      if (notesEntry && notesRec?.type === RT.notes) {
        visited.add(notesOffset);
        const nUsed = new Set<number>();
        const nTexts = collectTexts(doc, notesRec, notesEntry.texts, nUsed);
        notesEntry.texts.forEach((t, idx) => nUsed.has(idx) || nTexts.push(t));
        notes = lines(nTexts.filter((t) => t.type === TEXT_NOTES));
      }

      if (!title && !body.length && !notes.length) continue;
      const parts = [`## Slide ${i + 1}${title ? ` — ${title}` : ''}`];
      if (body.length) parts.push(body.join('\n'));
      if (notes.length) parts.push(`**Speaker notes:**\n${notes.join('\n')}`);
      sections.push(parts.join('\n\n'));
    }
    return sections.length ? sections.join('\n\n') : flatPptText(doc);
  });
}

/** Last resort: every text atom outside master slides, in stream order. */
function flatPptText(doc: Buffer): string {
  const texts: PptText[] = [];
  const walk = (recs: Rec[], depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const r of recs) {
      if (r.type === RT.mainMaster) continue;
      if (r.type === RT.textCharsAtom || r.type === RT.textBytesAtom) texts.push({ type: 4, text: atomText(doc, r) });
      else if (r.ver === 0xf) walk(children(doc, r), depth + 1);
    }
  };
  const top: Rec[] = [];
  for (let off = 0; off + 8 <= doc.length; ) {
    const r = recAt(doc, off)!;
    top.push(r);
    off = r.body + doc.readUInt32LE(off + 4);
  }
  walk(top, 0);
  return lines(texts).join('\n');
}

// ---------- .xls ----------

const XL = {
  formula: 0x0006,
  eof: 0x000a,
  dateMode: 0x0022,
  filePass: 0x002f,
  continue: 0x003c,
  boundSheet: 0x0085,
  mulRk: 0x00bd,
  xf: 0x00e0,
  sst: 0x00fc,
  labelSst: 0x00fd,
  number: 0x0203,
  label: 0x0204,
  boolErr: 0x0205,
  string: 0x0207,
  rk: 0x027e,
  format: 0x041e,
  bof: 0x0809,
} as const;

const XL_ERRORS: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
};

interface XlRecord {
  type: number;
  data: Buffer;
}

/** One substream: from its BOF to the matching EOF (embedded chart substreams nest). */
function xlRecords(buf: Buffer, start: number): XlRecord[] {
  const out: XlRecord[] = [];
  let depth = 0;
  for (let p = start; p + 4 <= buf.length; ) {
    const type = buf.readUInt16LE(p);
    const len = buf.readUInt16LE(p + 2);
    out.push({ type, data: buf.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
    if (type === XL.bof) depth++;
    else if (type === XL.eof && --depth <= 0) break;
  }
  return out;
}

/**
 * Reads XLUnicodeStrings that may be split across CONTINUE records. When a
 * string's characters cross a record boundary, the next record starts with
 * a fresh fHighByte flag byte ([MS-XLS] 2.5.294).
 */
class ContinuedReader {
  private ci = 0;
  private pos = 0;
  constructor(private readonly chunks: Buffer[]) {}

  private chunk(): Buffer | undefined {
    while (this.ci < this.chunks.length && this.pos >= this.chunks[this.ci]!.length) {
      this.ci++;
      this.pos = 0;
    }
    return this.chunks[this.ci];
  }

  done(): boolean {
    return this.chunk() === undefined;
  }

  u8(): number {
    const c = this.chunk();
    if (!c) invalid('truncated string table');
    return c[this.pos++]!;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(n: number): void {
    while (n > 0) {
      const c = this.chunk();
      if (!c) return;
      const take = Math.min(n, c.length - this.pos);
      this.pos += take;
      n -= take;
    }
  }

  chars(cch: number, highByte: boolean): string {
    let out = '';
    let high = highByte;
    let remaining = cch;
    while (remaining > 0) {
      let c = this.chunks[this.ci];
      if (!c) break;
      if (this.pos >= c.length) {
        this.ci++;
        c = this.chunks[this.ci];
        if (!c) break;
        high = (c[0]! & 1) === 1;
        this.pos = 1;
      }
      const avail = high ? Math.floor((c.length - this.pos) / 2) : c.length - this.pos;
      const take = Math.min(avail, remaining);
      out += c.toString(high ? 'utf16le' : 'latin1', this.pos, this.pos + take * (high ? 2 : 1));
      this.pos += take * (high ? 2 : 1);
      remaining -= take;
      if (take === 0 && avail === 0 && this.pos < c.length) break; // dangling odd byte
    }
    return out;
  }

  /** XLUnicodeRichExtendedString (SST entry / STRING record body). */
  richString(): string {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const text = this.chars(cch, (flags & 1) === 1);
    this.skip(runs * 4 + ext);
    return text;
  }
}

/** XLUnicodeString inside a single record: cch (2), flags (1), chars. */
function xlString(data: Buffer, off: number, cchBytes: 1 | 2): string {
  const cch = cchBytes === 1 ? data[off]! : data.readUInt16LE(off);
  const flags = data[off + cchBytes]!;
  const start = off + cchBytes + 1;
  return flags & 1
    ? data.toString('utf16le', start, start + cch * 2)
    : data.toString('latin1', start, start + cch);
}

function decodeRk(rk: number): number {
  let v: number;
  if (rk & 0x02) {
    v = rk >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & ~0x03) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

/** Records that follow `i` as CONTINUE, as chunks after `first`. */
function withContinues(records: XlRecord[], i: number, first: Buffer): Buffer[] {
  const chunks = [first];
  for (let j = i + 1; records[j]?.type === XL.continue; j++) chunks.push(records[j]!.data);
  return chunks;
}

/**
 * Excel 97–2003 (BIFF8): same output as .xlsx — one Markdown table per
 * visible worksheet, cached formula results, ISO dates, shared caps.
 */
export function xlsToMarkdown(buffer: Buffer, limits = DEFAULT_OOXML_LIMITS): string {
  const cfb = openCfb(buffer);
  return guarded('Excel', () => {
    const wb = stream(cfb, 'Workbook');
    if (!wb) {
      if (stream(cfb, 'Book')) {
        throw new LegacyOfficeError(
          'unsupported_office_version: Excel 5.0/95 workbooks are not supported — re-save as .xlsx',
        );
      }
      invalid('missing Workbook stream');
    }
    const globals = xlRecords(wb, 0);
    const bof = globals[0];
    if (bof?.type !== XL.bof || bof.data.readUInt16LE(0) !== 0x0600) {
      throw new LegacyOfficeError('unsupported_office_version: only Excel 97+ (BIFF8) workbooks are supported');
    }

    let epoch = Date.UTC(1899, 11, 30);
    const formats = new Map<number, string>();
    const xfFormat: number[] = [];
    const sheets: { name: string; pos: number }[] = [];
    const sheetPositions = new Set<number>();
    let shared: string[] = [];
    for (const [i, rec] of globals.entries()) {
      const d = rec.data;
      switch (rec.type) {
        case XL.filePass:
          throw new LegacyOfficeError('encrypted_office_file: password-protected workbooks are not supported');
        case XL.dateMode:
          if (d.readUInt16LE(0) === 1) epoch = Date.UTC(1904, 0, 1);
          break;
        case XL.format:
          formats.set(d.readUInt16LE(0), xlString(d, 2, 2));
          break;
        case XL.xf:
          xfFormat.push(d.readUInt16LE(2));
          break;
        case XL.boundSheet:
          // Visible (hsState 0) worksheets (dt 0) only; each substream once.
          if ((d[4]! & 0x03) === 0 && d[5] === 0 && !sheetPositions.has(d.readUInt32LE(0))) {
            sheetPositions.add(d.readUInt32LE(0));
            sheets.push({ name: xlString(d, 6, 1), pos: d.readUInt32LE(0) });
          }
          break;
        case XL.sst: {
          const reader = new ContinuedReader(withContinues(globals, i, d.subarray(8)));
          const unique = d.readUInt32LE(4);
          shared = [];
          for (let k = 0; k < unique && !reader.done(); k++) shared.push(reader.richString());
          break;
        }
      }
    }

    const isDate = (ixfe: number) => {
      const fmt = xfFormat[ixfe];
      if (fmt === undefined) return false;
      const code = formats.get(fmt);
      return code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(fmt);
    };
    const num = (n: number, ixfe: number) => (isDate(ixfe) ? serialToDate(n, epoch) : formatNumber(n));

    const out: SheetRows[] = sheets.map(({ name, pos }) => {
      const rows = new Map<number, Map<number, string>>();
      const set = (rw: number, col: number, value: string) => {
        const v = value.trim();
        if (!v) return;
        let row = rows.get(rw);
        if (!row) rows.set(rw, (row = new Map()));
        row.set(col, v);
      };
      const records = xlRecords(wb, pos);
      for (const [i, rec] of records.entries()) {
        const d = rec.data;
        if (d.length < 6) continue;
        const rw = d.readUInt16LE(0);
        const col = d.readUInt16LE(2);
        const ixfe = d.readUInt16LE(4);
        switch (rec.type) {
          case XL.labelSst:
            set(rw, col, shared[d.readUInt32LE(6)] ?? '');
            break;
          case XL.label:
            set(rw, col, xlString(d, 6, 2));
            break;
          case XL.number:
            set(rw, col, num(d.readDoubleLE(6), ixfe));
            break;
          case XL.rk:
            set(rw, col, num(decodeRk(d.readInt32LE(6)), ixfe));
            break;
          case XL.mulRk:
            for (let k = 0, p = 4; p + 6 <= d.length - 2; k++, p += 6) {
              set(rw, col + k, num(decodeRk(d.readInt32LE(p + 2)), d.readUInt16LE(p)));
            }
            break;
          case XL.boolErr:
            set(rw, col, d[7] ? (XL_ERRORS[d[6]!] ?? '#ERR') : d[6] ? 'TRUE' : 'FALSE');
            break;
          case XL.formula: {
            if (d.readUInt16LE(12) !== 0xffff) {
              set(rw, col, num(d.readDoubleLE(6), ixfe));
              break;
            }
            const kind = d[6];
            if (kind === 1) set(rw, col, d[8] ? 'TRUE' : 'FALSE');
            else if (kind === 2) set(rw, col, XL_ERRORS[d[8]!] ?? '#ERR');
            else if (kind === 0) {
              // The string result is in a STRING record right after the
              // FORMULA (possibly behind a SHRFMLA/ARRAY/TABLE record).
              const j = [i + 1, i + 2].find((k) => records[k]?.type === XL.string);
              if (j !== undefined) set(rw, col, new ContinuedReader(withContinues(records, j, records[j]!.data)).richString());
            }
            break;
          }
        }
      }
      return {
        name,
        rows: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells),
      };
    });
    return renderWorkbook(out, limits);
  });
}
