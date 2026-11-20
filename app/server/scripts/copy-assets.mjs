// Copy runtime prompt assets (*.md) into dist/ — tsc only emits .js, and the
// engine loads these prompt files at runtime. Cross-platform (the old
// `mkdir -p … && cp …` shell script failed on Windows cmd.exe, breaking the
// standalone build on the Windows CI runner).
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'lib', 'prompts');
const dst = join(root, 'dist', 'lib', 'prompts');

mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (f.endsWith('.md')) {
    copyFileSync(join(src, f), join(dst, f));
    n++;
  }
}
console.log(`[copy-assets] copied ${n} prompt file(s) → dist/lib/prompts`);
