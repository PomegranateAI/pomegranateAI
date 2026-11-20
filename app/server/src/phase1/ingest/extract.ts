/**
 * Text extraction for ingest sources.
 *
 * Supported formats:
 *   - .txt / .md / .vtt — read as UTF-8, .vtt cleaned of cue timestamps
 *   - .html / .htm — converted to Markdown, stripping scripts/styles/graphics/svg
 *   - .pdf — pdf-parse (text layer only; no OCR fallback)
 *   - .docx — mammoth → HTML → Markdown (keeps headings, lists, tables)
 *   - .pptx — one `## Slide N` section per visible slide, incl. speaker notes
 *   - .xlsx — one Markdown table per visible sheet (row/col/length capped)
 *   - .doc / .ppt / .xls — legacy Office 97–2003 binaries, same output shapes
 *     (see ./legacy-office.ts). A legacy extension on a file that is really
 *     OOXML or HTML (common for "Save as .xls" exports) is routed by content.
 *
 * Office formats are zip archives; see ./ooxml.ts for the zip-bomb guard.
 * Anything else fails fast with `unsupported_extension`. OCR (.png/.jpg) is
 * intentionally out of scope here.
 */
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { assertOoxmlWithinLimits, pptxToMarkdown, xlsxToMarkdown } from './ooxml.js';
import { docToText, pptToMarkdown, xlsToMarkdown } from './legacy-office.js';

export type ExtractKind = 'doc' | 'transcript';

export interface ExtractResult {
  text: string;
  ext: string;
  kind: ExtractKind;
  /** Number of bytes in the original buffer. */
  bytes: number;
}

const TRANSCRIPT_EXTS = new Set(['.vtt']);
const DOC_EXTS = new Set(['.txt', '.md', '.html', '.htm', '.pdf', '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls']);

/** Stored MIME type for an extractable upload (the original is kept as an asset). */
export function mimeForExtension(ext: string): string {
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.doc':
      return 'application/msword';
    case '.ppt':
      return 'application/vnd.ms-powerpoint';
    case '.xls':
      return 'application/vnd.ms-excel';
    default:
      return 'text/plain';
  }
}

/** Every extension extract() reads — the web upload pickers mirror this list. */
export const SUPPORTED_EXTS: readonly string[] = [...DOC_EXTS, ...TRANSCRIPT_EXTS];

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

export function isSupported(filename: string): boolean {
  const ext = extensionOf(filename);
  return TRANSCRIPT_EXTS.has(ext) || DOC_EXTS.has(ext);
}

export function classifyKind(filename: string): ExtractKind {
  return TRANSCRIPT_EXTS.has(extensionOf(filename)) ? 'transcript' : 'doc';
}

const LEGACY_TO_OOXML: Record<string, string> = { '.doc': '.docx', '.ppt': '.pptx', '.xls': '.xlsx' };
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function extract(filename: string, buffer: Buffer): Promise<ExtractResult> {
  const ext = extensionOf(filename);
  const bytes = buffer.length;
  const legacyAs = LEGACY_TO_OOXML[ext];
  if (legacyAs && !buffer.subarray(0, 8).equals(OLE2_MAGIC)) {
    // Mislabelled legacy files: a zip is really OOXML; markup is an HTML export.
    if (buffer.subarray(0, 2).toString('latin1') === 'PK') {
      return { ...(await extract(`file${legacyAs}`, buffer)), ext };
    }
    if (/^\s*</.test(buffer.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, ''))) {
      return { text: htmlToMarkdown(buffer.toString('utf8')), ext, kind: 'doc', bytes };
    }
    throw new Error(`invalid_office_file: not a ${ext} file`);
  }
  if (ext === '.txt' || ext === '.md') {
    return { text: buffer.toString('utf8'), ext, kind: 'doc', bytes };
  }
  if (ext === '.vtt') {
    return { text: parseVtt(buffer.toString('utf8')), ext, kind: 'transcript', bytes };
  }
  if (ext === '.html' || ext === '.htm') {
    return { text: htmlToMarkdown(buffer.toString('utf8')), ext, kind: 'doc', bytes };
  }
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    // pdf-parse v2 takes a TypedArray; convert the Node Buffer.
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      return { text: result.text, ext, kind: 'doc', bytes };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (ext === '.docx') {
    await assertOoxmlWithinLimits(buffer);
    const result = await mammoth.convertToHtml(
      { buffer },
      // Images are dropped by htmlToMarkdown anyway — don't inline their bytes.
      { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
    );
    return { text: htmlToMarkdown(result.value), ext, kind: 'doc', bytes };
  }
  if (ext === '.pptx') {
    return { text: await pptxToMarkdown(buffer), ext, kind: 'doc', bytes };
  }
  if (ext === '.xlsx') {
    return { text: await xlsxToMarkdown(buffer), ext, kind: 'doc', bytes };
  }
  if (ext === '.doc') return { text: docToText(buffer), ext, kind: 'doc', bytes };
  if (ext === '.ppt') return { text: pptToMarkdown(buffer), ext, kind: 'doc', bytes };
  if (ext === '.xls') return { text: xlsToMarkdown(buffer), ext, kind: 'doc', bytes };
  throw new Error(`unsupported_extension: ${ext || '(none)'}`);
}

/**
 * WebVTT → plain text. Drops the `WEBVTT` header, cue timestamp lines, and
 * empty separators; keeps cue bodies as paragraphs. Speaker tags
 * (`<v Speaker>`) are flattened to `Speaker: text`.
 */
export function parseVtt(input: string): string {
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'WEBVTT') continue;
    if (/^\d{2}:\d{2}/.test(line) && line.includes('-->')) continue;
    if (/^NOTE\b/.test(line)) continue;
    // Cue identifier (numeric or kebab) preceding a timestamp; harmless if a
    // body line happens to be a number — skip only if isolated and short.
    if (/^[A-Za-z0-9_-]+$/.test(line) && line.length < 30 && out.length === 0) continue;
    // Flatten <v Speaker>text</v>
    const flattened = line
      .replace(/<v\s+([^>]+)>/g, '$1: ')
      .replace(/<\/v>/g, '')
      .replace(/<[^>]+>/g, '');
    out.push(flattened);
  }
  return out.join('\n');
}

// Graphic/embed elements carry no ingestible prose — drop them entirely.
// Turndown's built-in `image` rule would otherwise emit `![alt](src)` markdown
// for <img>, so these get a blanking rule (addRule unshifts → it wins over the
// built-in rules). <figure>/<figcaption> are deliberately NOT here: their text
// (captions) is worth keeping.
const GRAPHIC_TAGS = [
  'img', 'svg', 'picture', 'canvas', 'video', 'audio',
  'object', 'embed', 'source', 'iframe', 'map', 'area', 'track',
];
// Non-content elements removed with their subtree (script/style are code; head
// metadata is not prose). Turndown parses via innerHTML, which discards the
// <head> wrapper but keeps <title>/<meta>/<link> as loose elements — so they're
// listed explicitly rather than relying on removing <head>.
const DROP_TAGS = ['head', 'title', 'meta', 'link', 'script', 'style', 'noscript', 'template'];

let _turndown: TurndownService | null = null;
function turndownService(): TurndownService {
  if (_turndown) return _turndown;
  const t = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t.addRule('stripGraphics', { filter: GRAPHIC_TAGS as any, replacement: () => '' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t.remove(DROP_TAGS as any);
  _turndown = t;
  return t;
}

/**
 * HTML → Markdown. Strips scripts, styles, and all graphics (images, svg,
 * media, embeds), keeping only the textual structure (headings, lists, tables,
 * links, emphasis). Runs in Node via Turndown's bundled DOM — no browser.
 */
export function htmlToMarkdown(html: string): string {
  return turndownService()
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
