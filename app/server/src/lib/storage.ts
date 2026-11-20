import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { Node, Candidate, Review } from './schemas.js';
import type { Node as NodeT } from './schemas.js';

export interface StorageOptions {
  rootDir: string;
}

export class FileStorage {
  readonly rootDir: string;
  readonly graphDir: string;
  readonly backlogPath: string;
  readonly rejectedPath: string;
  readonly sourcesDir: string;
  readonly interactionsDir: string;
  readonly reviewsDir: string;
  readonly skippedLogPath: string;
  readonly indexPath: string;
  readonly statePath: string;
  readonly debugLogPath: string;

  constructor(opts: StorageOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.graphDir = path.join(this.rootDir, 'graph');
    this.backlogPath = path.join(this.rootDir, 'backlog.md');
    this.rejectedPath = path.join(this.rootDir, 'rejected.md');
    this.sourcesDir = path.join(this.rootDir, 'sources');
    this.interactionsDir = path.join(this.rootDir, 'interactions');
    this.reviewsDir = path.join(this.rootDir, 'reviews');
    this.skippedLogPath = path.join(this.reviewsDir, 'skipped.log');
    this.indexPath = path.join(this.reviewsDir, 'index.md');
    this.statePath = path.join(this.rootDir, 'state.json');
    this.debugLogPath = path.join(this.rootDir, 'debug.log');
  }

  async init(): Promise<void> {
    for (const dir of [this.graphDir, this.sourcesDir, this.interactionsDir, this.reviewsDir]) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  // ---------- nodes ----------

  nodeFilename(node: NodeT): string {
    const slug = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.graphDir, `${node.type}-${slug}.md`);
  }

  serializeNode(node: NodeT): string {
    const { ...frontmatter } = node;
    // Move body to markdown body if present
    let body = '';
    if ('body' in frontmatter && typeof (frontmatter as any).body === 'string') {
      body = (frontmatter as any).body;
      delete (frontmatter as any).body;
    }
    return matter.stringify(body, frontmatter);
  }

  parseNode(raw: string): NodeT {
    const parsed = matter(raw);
    const data: Record<string, unknown> = { ...parsed.data };
    if (parsed.content.trim().length > 0 && !('body' in data)) {
      data.body = parsed.content.trim();
    }
    return Node.parse(data);
  }

  async writeNode(node: NodeT): Promise<string> {
    const filename = this.nodeFilename(node);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const content = this.serializeNode(node);
    const tmp = `${filename}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filename);
    return filename;
  }

  async readNode(filename: string): Promise<NodeT> {
    const raw = await fs.readFile(filename, 'utf8');
    return this.parseNode(raw);
  }

  async readGraph(): Promise<NodeT[]> {
    try {
      const entries = await fs.readdir(this.graphDir);
      const mdFiles = entries.filter((e) => e.endsWith('.md'));
      const nodes: NodeT[] = [];
      for (const f of mdFiles) {
        try {
          const n = await this.readNode(path.join(this.graphDir, f));
          if (n.status !== 'archived') nodes.push(n);
        } catch (err) {
          await this.appendDebug(`failed to parse ${f}: ${(err as Error).message}`);
        }
      }
      return nodes;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  // ---------- append-only logs ----------

  async appendBacklog(candidates: Candidate[]): Promise<void> {
    if (candidates.length === 0) return;
    const lines: string[] = [];
    for (const c of candidates) {
      lines.push(formatBacklogEntry(c));
    }
    await this.atomicAppend(this.backlogPath, lines.join('\n\n') + '\n\n---\n\n');
  }

  async appendSkipped(line: string): Promise<void> {
    await this.atomicAppend(this.skippedLogPath, line.trimEnd() + '\n');
  }

  async appendDebug(line: string): Promise<void> {
    try {
      await this.atomicAppend(this.debugLogPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // never throw from debug logging
    }
  }

  async appendIndex(reviewFilename: string, summary: string): Promise<void> {
    const line = `- [${path.basename(reviewFilename)}](${path.basename(reviewFilename)}) — ${summary}\n`;
    await this.atomicAppend(this.indexPath, line);
  }

  // ---------- reviews ----------

  async writeReview(review: Review): Promise<string> {
    await fs.mkdir(this.reviewsDir, { recursive: true });
    const filename = path.join(this.reviewsDir, `${review.id}.md`);
    const tmp = `${filename}.${process.pid}.tmp`;
    const md = renderReviewMd(review);
    await fs.writeFile(tmp, md, 'utf8');
    await fs.rename(tmp, filename);
    return filename;
  }

  async writeInteraction(id: string, payload: unknown): Promise<string> {
    await fs.mkdir(this.interactionsDir, { recursive: true });
    const filename = path.join(this.interactionsDir, `${id}.json`);
    const tmp = `${filename}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, filename);
    return filename;
  }

  // ---------- state ----------

  async readState(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  async writeState(state: Record<string, unknown>): Promise<void> {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.statePath);
  }

  // ---------- internal ----------

  private async atomicAppend(target: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    // O_APPEND on POSIX is atomic for writes < PIPE_BUF; for our tiny logs this is fine.
    // For larger node files we use tmp+rename in writeNode/writeReview.
    await fs.appendFile(target, content, { encoding: 'utf8' });
  }
}

function formatBacklogEntry(c: Candidate): string {
  const node = c.proposed_node;
  const summary =
    node.type === 'goal'
      ? node.title
      : node.type === 'decision'
        ? node.summary
        : node.body.slice(0, 80);
  const conflict = c.conflicts_with ? `  conflicts_with: ${c.conflicts_with}\n` : '';
  return [
    `### <${c.flag}> ${node.type}: ${summary}`,
    '',
    '```yaml',
    `id: ${c.id}`,
    `flag: ${c.flag}`,
    `confidence: ${c.confidence.toFixed(2)}`,
    `source_ref: ${c.source_ref}`,
    conflict,
    '```',
    '',
    '> ' + c.source_quote.replace(/\n/g, '\n> '),
    '',
    c.reason ? `_reason: ${c.reason}_` : '',
    '',
    '**Action:** approve / edit / reject',
  ].join('\n');
}

function renderReviewMd(r: Review): string {
  const lines: string[] = [];
  lines.push(`# Review ${r.id}`);
  lines.push('');
  lines.push(`*${r.created_at}*  triage=${r.triage.relevant ? 'relevant' : 'skip'} (${r.triage.reason})`);
  lines.push('');
  if (r.findings.length === 0) {
    lines.push('_no findings_');
    return lines.join('\n');
  }
  const byCat = new Map<string, typeof r.findings>();
  for (const f of r.findings) {
    const arr = byCat.get(f.category) ?? [];
    arr.push(f);
    byCat.set(f.category, arr);
  }
  const order = ['decisions', 'goals_priorities', 'positioning', 'brand_voice', 'context_recency'];
  for (const cat of order) {
    const items = byCat.get(cat);
    if (!items || items.length === 0) continue;
    lines.push(`## ${cat}`);
    lines.push('');
    items.sort((a, b) => flagOrder(a.flag) - flagOrder(b.flag));
    for (const it of items) {
      lines.push(`- **<${it.flag}>** ${it.summary} ${it.node_id ? `→ \`${it.node_id}\`` : ''}`);
      lines.push(`  > ${it.quote_from_deliverable.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function flagOrder(f: 'red' | 'yellow' | 'green'): number {
  return f === 'red' ? 0 : f === 'yellow' ? 1 : 2;
}
