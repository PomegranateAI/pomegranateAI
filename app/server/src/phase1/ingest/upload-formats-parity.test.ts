import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_EXTS } from './extract.js';
import { MEDIA_EXTS } from '../data-agents/media-types.js';

// The web upload pickers keep their own copy of these lists (the SPA can't
// import server code). Fail here if either side gains a format the other lacks,
// so the UI never blocks a file the server can read — or offers one it can't.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_FORMATS = path.resolve(__dirname, '../../../../web/src/lib/upload-formats.ts');

function webList(source: string, name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!m) throw new Error(`${name} not found in ${WEB_FORMATS}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

describe('web upload formats match what the server can read', () => {
  const source = readFileSync(WEB_FORMATS, 'utf8');

  it('documents', () => {
    expect(webList(source, 'DOCUMENT_EXTS')).toEqual([...SUPPORTED_EXTS].sort());
  });

  it('audio + images', () => {
    expect([...webList(source, 'AUDIO_EXTS'), ...webList(source, 'IMAGE_EXTS')].sort()).toEqual(
      [...MEDIA_EXTS].sort(),
    );
  });
});
