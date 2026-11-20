import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './extract.js';
import { xlsToMarkdown } from './legacy-office.js';
import { DEFAULT_OOXML_LIMITS } from './ooxml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '__fixtures__');
const fixture = (name: string) => fs.readFile(path.join(FIXTURES, name));

describe('legacy Office extraction', () => {
  it('.doc: piece-table text, tables as cells, unicode intact', async () => {
    const r = await extract('memo.doc', await fixture('sample.doc'));
    expect(r.ext).toBe('.doc');
    expect(r.kind).toBe('doc');
    expect(r.text).toContain('Sunsetting the v1 mobile app effective today.');
    expect(r.text).toContain('Unit | Weeks\nTeam | 12w');
    expect(r.text).toContain('café — naïve ✓');
    expect(r.text).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  });

  it('.ppt: slides in order with titles and notes; hidden slide skipped', async () => {
    const r = await extract('deck.ppt', await fixture('sample.ppt'));
    expect(r.ext).toBe('.ppt');
    expect(r.text).toContain('## Slide 1 — Roadmap review Q3');
    expect(r.text).toContain('## Slide 2 — Decision\n\nSunsetting the v1 mobile app');
    expect(r.text).toContain('**Speaker notes:**\nSpeaker note: finance signed off on the app exit.');
    expect(r.text).toContain('## Slide 3 — Road ahead');
    expect(r.text.indexOf('Slide 2')).toBeLessThan(r.text.indexOf('Slide 3'));
    expect(r.text).not.toMatch(/Hidden slide|Cut content|Slide 4/);
    // master-slide boilerplate never leaks in
    expect(r.text).not.toMatch(/Click to edit/i);
  });

  it('.xls: same table output as .xlsx; hidden sheet skipped', async () => {
    const r = await extract('roadmap.xls', await fixture('sample.xls'));
    expect(r.ext).toBe('.xls');
    expect(r.text).toContain('## Sheet: Roadmap');
    expect(r.text).toContain('| Starter | 49 | Killed | 2026-07-01 |');
    // formula: cached result
    expect(r.text).toContain('| Total | 148 |');
    expect(r.text).toContain('migrate all existing \\| legacy accounts');
    expect(r.text).toContain('## Sheet: Owners\n\n| Owner | Area |');
    expect(r.text).not.toMatch(/Scratch|secret hidden sheet/);
  });

  it('.xls: shares the row cap with .xlsx', async () => {
    const md = xlsToMarkdown(await fixture('sample.xls'), { ...DEFAULT_OOXML_LIMITS, xlsxMaxRowsPerSheet: 2 });
    expect(md).toContain('| Starter |');
    expect(md).not.toContain('| Team | 99');
    expect(md).toContain('showing first 2 of 5 rows');
  });

  it('routes mislabelled legacy files by content', async () => {
    // OOXML saved with a legacy extension
    const xlsx = await extract('really-xlsx.xls', await fixture('sample.xlsx'));
    expect(xlsx.ext).toBe('.xls');
    expect(xlsx.text).toContain('| Starter | 49 | Killed | 2026-07-01 |');
    const docx = await extract('really-docx.doc', await fixture('sample.docx'));
    expect(docx.text).toContain('Sunsetting the v1 mobile app');
    // "Save as .xls" HTML export
    const html = await extract('export.xls', Buffer.from('<table><tr><td>Stage</td><td>Date</td></tr></table>'));
    expect(html.text).toContain('Stage');
    // anything else is rejected
    await expect(extract('junk.ppt', Buffer.from('not office'))).rejects.toThrow(/invalid_office_file/);
  });

  it('never crashes or hangs on corrupted input', async () => {
    // Deterministic byte-flip / truncation fuzz over each fixture: every
    // outcome must be a string or one of our typed errors.
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const name of ['sample.doc', 'sample.ppt', 'sample.xls']) {
      const orig = await fixture(name);
      for (let iter = 0; iter < 40; iter++) {
        const buf = Buffer.from(orig);
        if (iter % 4 === 0) {
          const cut = 512 + Math.floor(rand() * (buf.length - 512));
          await check(name, buf.subarray(0, cut));
          continue;
        }
        // Keep the OLE2 header intact so the record parsers get exercised.
        for (let k = 0; k < 64; k++) buf[512 + Math.floor(rand() * (buf.length - 512))] = Math.floor(rand() * 256);
        await check(name, buf);
      }
    }
    async function check(name: string, buf: Buffer) {
      try {
        const r = await extract(name, buf);
        expect(typeof r.text).toBe('string');
      } catch (err) {
        expect((err as Error).message).toMatch(/^(invalid_office_file|encrypted_office_file|unsupported_office_version)/);
      }
    }
  }, 60_000);
});
