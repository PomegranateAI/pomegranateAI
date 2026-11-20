import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { DEFAULT_OOXML_LIMITS, assertOoxmlWithinLimits, pptxToMarkdown, xlsxToMarkdown } from './ooxml.js';

const WB_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Minimal workbook: one sheet of inline strings, no sharedStrings/styles parts. */
async function workbook(rows: string[][], extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns="${WB_NS}" xmlns:r="${R_NS}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  const body = rows
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r.map((v) => `<c t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`,
    )
    .join('');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${WB_NS}"><sheetData>${body}</sheetData></worksheet>`);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('xlsxToMarkdown caps', () => {
  it('reads inline strings without sharedStrings/styles parts', async () => {
    const md = await xlsxToMarkdown(await workbook([['Owner', 'Area'], ['Sam', 'Growth']]));
    expect(md).toBe('## Sheet: Data\n\n| Owner | Area |\n| --- | --- |\n| Sam | Growth |');
  });

  it('caps rows per sheet and says so', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`r${i}`]);
    const md = await xlsxToMarkdown(await workbook(rows), { ...DEFAULT_OOXML_LIMITS, xlsxMaxRowsPerSheet: 3 });
    expect(md).toContain('| r2 |');
    expect(md).not.toContain('| r3 |');
    expect(md).toContain('showing first 3 of 10 rows');
  });

  it('caps columns and says so', async () => {
    const md = await xlsxToMarkdown(await workbook([['a', 'b', 'c', 'd']]), {
      ...DEFAULT_OOXML_LIMITS,
      xlsxMaxCols: 2,
    });
    expect(md).toContain('| a | b |');
    expect(md).not.toContain('| c');
    expect(md).toContain('showing first 2 of 4 columns');
  });

  it('caps total length and says so', async () => {
    const md = await xlsxToMarkdown(await workbook([['x'.repeat(200)]]), { ...DEFAULT_OOXML_LIMITS, xlsxMaxChars: 50 });
    expect(md).not.toContain('xxx');
    expect(md).toMatch(/Truncated: remaining sheets omitted/);
  });
});

describe('zip-bomb guard', () => {
  it('aborts once inflated XML exceeds the budget', async () => {
    const big = `<w>${'a'.repeat(200_000)}</w>`;
    const buf = await workbook([['x']], { 'xl/bloat.xml': big });
    const tight = { ...DEFAULT_OOXML_LIMITS, maxInflatedXmlBytes: 50_000 };
    await expect(assertOoxmlWithinLimits(buf, tight)).rejects.toThrow(/archive_too_large/);
    // within budget it passes
    await expect(assertOoxmlWithinLimits(buf)).resolves.toBeUndefined();
  });

  it('rejects archives whose declared size is over the limit', async () => {
    const buf = await workbook([['x']], { 'xl/media/blob.bin': 'z'.repeat(10_000) });
    await expect(
      xlsxToMarkdown(buf, { ...DEFAULT_OOXML_LIMITS, maxDeclaredBytes: 5_000 }),
    ).rejects.toThrow(/archive_too_large/);
  });

  it('rejects archives with too many entries', async () => {
    const buf = await workbook([['x']]);
    await expect(pptxToMarkdown(buf, { ...DEFAULT_OOXML_LIMITS, maxEntries: 2 })).rejects.toThrow(/too many entries/);
  });
});
