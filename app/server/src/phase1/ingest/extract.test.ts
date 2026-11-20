import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, parseVtt, isSupported, classifyKind, extensionOf, htmlToMarkdown } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '__fixtures__');

describe('extract()', () => {
  it('.txt: returns the buffer as UTF-8', async () => {
    const r = await extract('memo.txt', Buffer.from('Killing the v1 mobile app.'));
    expect(r.text).toBe('Killing the v1 mobile app.');
    expect(r.kind).toBe('doc');
    expect(r.ext).toBe('.txt');
  });

  it('.md: same path as .txt', async () => {
    const r = await extract('notes.md', Buffer.from('# Decisions\n- killed v1'));
    expect(r.text).toContain('killed v1');
    expect(r.kind).toBe('doc');
  });

  it('.vtt: strips headers + timestamps and flattens speaker tags', async () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
<v Speaker 1>We are killing the v1 mobile app.</v>

00:00:05.500 --> 00:00:09.000
<v Speaker 2>Effective when?</v>
`;
    const r = await extract('meeting.vtt', Buffer.from(vtt));
    expect(r.kind).toBe('transcript');
    expect(r.text).not.toMatch(/WEBVTT/);
    expect(r.text).not.toMatch(/-->/);
    expect(r.text).toContain('Speaker 1: We are killing the v1 mobile app.');
    expect(r.text).toContain('Speaker 2: Effective when?');
  });

  it('.pdf: extracts the embedded text layer', async () => {
    const buf = await fs.readFile(path.join(FIXTURES, 'sample.pdf'));
    const r = await extract('decision-memo.pdf', buf);
    expect(r.kind).toBe('doc');
    expect(r.ext).toBe('.pdf');
    expect(r.text).toMatch(/v1 mobile app/);
    expect(r.text.toLowerCase()).toMatch(/sunsetting/);
  });

  it('.docx: extracts text via mammoth as Markdown', async () => {
    const buf = await fs.readFile(path.join(FIXTURES, 'sample.docx'));
    const r = await extract('strategy.docx', buf);
    expect(r.kind).toBe('doc');
    expect(r.ext).toBe('.docx');
    expect(r.text).toContain('Sunsetting the v1 mobile app');
    expect(r.text).toContain('strategy decision memo');
  });

  it('.pptx: one section per visible slide, with tables and speaker notes', async () => {
    const buf = await fs.readFile(path.join(FIXTURES, 'sample.pptx'));
    const r = await extract('roadmap-review.pptx', buf);
    expect(r.kind).toBe('doc');
    expect(r.ext).toBe('.pptx');
    expect(r.text).toContain('## Slide 1 — Roadmap review Q3');
    expect(r.text).toContain('## Slide 2 — Decision');
    expect(r.text).toContain('Sunsetting the v1 mobile app');
    expect(r.text).toContain('**Speaker notes:**\nSpeaker note: finance signed off on the app exit.');
    // slide table → markdown table, pipes escaped
    expect(r.text).toContain('| Unit | Weeks |');
    expect(r.text).toContain('| Enterprise | Staged \\| phased |');
    // slides stay in deck order
    expect(r.text.indexOf('Slide 1')).toBeLessThan(r.text.indexOf('Slide 2'));
    expect(r.text.indexOf('Slide 2')).toBeLessThan(r.text.indexOf('Slide 3'));
    // hidden slide (show="0") is skipped
    expect(r.text).not.toMatch(/Hidden slide|Cut content|Slide 4/);
  });

  it('.xlsx: one markdown table per visible sheet', async () => {
    const buf = await fs.readFile(path.join(FIXTURES, 'sample.xlsx'));
    const r = await extract('roadmap.xlsx', buf);
    expect(r.kind).toBe('doc');
    expect(r.ext).toBe('.xlsx');
    expect(r.text).toContain('## Sheet: Roadmap');
    expect(r.text).toContain('| Unit | Weeks | Status | Effective |');
    // numbers, shared strings, and date-formatted serials
    expect(r.text).toContain('| Starter | 49 | Killed | 2026-07-01 |');
    // a formula with no cached value surfaces as the formula
    expect(r.text).toContain('| Total | =B2+B3 |');
    expect(r.text).toContain('migrate all existing \\| legacy accounts');
    // sparse sheet: leading empty rows/cols trimmed
    expect(r.text).toContain('## Sheet: Owners\n\n| Owner | Area |\n| --- | --- |\n| Josephine | Roadmap |');
    // hidden sheet skipped
    expect(r.text).not.toMatch(/Scratch|secret hidden sheet/);
  });

  it('office files that are not zips fail with invalid_office_file', async () => {
    for (const name of ['a.docx', 'b.pptx', 'c.xlsx']) {
      await expect(extract(name, Buffer.from('not a zip'))).rejects.toThrow(/invalid_office_file/);
    }
  });

  it('.html: converts to markdown and strips scripts/styles/graphics/svg', async () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Roadmap memo</title>
    <style>body { color: red }</style>
    <link rel="stylesheet" href="x.css">
  </head>
  <body>
    <h1>Roadmap decision</h1>
    <script>trackPageview();</script>
    <p>We are <strong>killing the v1 mobile app</strong>.</p>
    <img src="chart.png" alt="revenue chart">
    <svg viewBox="0 0 10 10"><path d="M0 0"/></svg>
    <ul><li>effective Q3</li><li>migrate all existing</li></ul>
    <a href="https://example.com/memo">full memo</a>
  </body>
</html>`;
    const r = await extract('memo.html', Buffer.from(html));
    expect(r.kind).toBe('doc');
    expect(r.ext).toBe('.html');
    // structure preserved
    expect(r.text).toContain('# Roadmap decision');
    expect(r.text).toContain('**killing the v1 mobile app**');
    expect(r.text).toMatch(/^-\s+effective Q3$/m);
    expect(r.text).toContain('[full memo](https://example.com/memo)');
    // <title> metadata must not leak into the body prose
    expect(r.text).not.toMatch(/Roadmap memo/);
    // scripts / styles / graphics / svg stripped
    expect(r.text).not.toMatch(/trackPageview/);
    expect(r.text).not.toMatch(/color: red/);
    expect(r.text).not.toMatch(/chart\.png/);
    expect(r.text).not.toMatch(/revenue chart/);
    expect(r.text).not.toMatch(/<svg|<path|viewBox/);
    expect(r.text).not.toMatch(/x\.css/);
  });

  it('.htm: same path as .html', async () => {
    const r = await extract('note.htm', Buffer.from('<p>Hello <b>world</b></p>'));
    expect(r.ext).toBe('.htm');
    expect(r.text).toContain('Hello **world**');
  });

  it('unsupported extension throws', async () => {
    await expect(extract('image.png', Buffer.from('garbage'))).rejects.toThrow(
      /unsupported_extension/,
    );
  });
});

describe('helpers', () => {
  it('extensionOf', () => {
    expect(extensionOf('foo.PDF')).toBe('.pdf');
    expect(extensionOf('no-ext')).toBe('');
  });
  it('isSupported', () => {
    for (const ext of ['.txt', '.md', '.html', '.htm', '.pdf', '.docx', '.pptx', '.xlsx', '.vtt']) {
      expect(isSupported(`file${ext}`)).toBe(true);
    }
    expect(isSupported('file.png')).toBe(false);
    for (const ext of ['.doc', '.ppt', '.xls']) expect(isSupported(`file${ext}`)).toBe(true);
  });
  it('classifyKind', () => {
    expect(classifyKind('a.vtt')).toBe('transcript');
    expect(classifyKind('b.pdf')).toBe('doc');
  });
});

describe('parseVtt direct', () => {
  it('drops NOTE blocks', () => {
    const v = `WEBVTT
NOTE this is a comment

00:00:01.000 --> 00:00:02.000
keep this line`;
    const out = parseVtt(v);
    expect(out).not.toMatch(/this is a comment/);
    expect(out).toContain('keep this line');
  });
});
