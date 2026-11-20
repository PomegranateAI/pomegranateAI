/**
 * Run capture extraction on one file against a built-in profile and print a
 * structured JSON report, including the routed pipeline's trace (route
 * verdict, per-specialist counts, arbiter drops) when the profile declares
 * extraction_groups. Used for profile-fit observation runs.
 *
 *   npx tsx --env-file=.env scripts/capture-file.ts <file> [profile_id=product]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCapture, type CaptureTraceEvent } from '../src/lib/anthropic.js';
import { getBuiltinProfile } from '../src/lib/profiles/index.js';

const [, , fileArg, profileArg] = process.argv;
if (!fileArg) {
  console.error('usage: npx tsx --env-file=.env scripts/capture-file.ts <file> [profile_id]');
  process.exit(2);
}
const profile = getBuiltinProfile(profileArg ?? 'product');
if (!profile) {
  console.error(`unknown profile: ${profileArg}`);
  process.exit(2);
}

const source = await fs.readFile(fileArg, 'utf8');
const trace: CaptureTraceEvent[] = [];
const t0 = Date.now();
const candidates = await runCapture({
  graph: [],
  sourceKind: 'doc',
  source,
  profile,
  trace,
  sourceRef: fileArg,
});

console.log(
  JSON.stringify(
    {
      file: path.relative(process.cwd(), fileArg),
      profile: profile.id,
      source_chars: source.length,
      ms: Date.now() - t0,
      trace,
      total: candidates.length,
      candidates: candidates.map((c) => {
        const n = c.proposed_node as Record<string, unknown>;
        return {
          flag: c.flag,
          kind: n.type,
          subkind: (n as { subkind?: string }).subkind ?? null,
          category: (n as { category?: string }).category ?? null,
          attrs: n.attrs ?? null,
          title: (n as { title?: string }).title ?? (n as { summary?: string }).summary ?? null,
          body: String(n.body ?? '').slice(0, 220),
          source_quote: c.source_quote.slice(0, 160),
          confidence: c.confidence,
        };
      }),
    },
    null,
    2,
  ),
);
