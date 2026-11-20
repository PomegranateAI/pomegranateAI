#!/usr/bin/env node
import 'dotenv/config';
import * as path from 'node:path';
import { FileStorage } from '../../lib/storage.js';

async function main() {
  const root = process.env.POMEGRANATE_DATA_DIR ?? '.pomegranate';
  const storage = new FileStorage({ rootDir: path.resolve(root) });
  const graph = await storage.readGraph();
  console.log(`Graph has ${graph.length} active nodes:\n`);
  const byType = new Map<string, typeof graph>();
  for (const n of graph) {
    const arr = byType.get(n.type) ?? [];
    arr.push(n);
    byType.set(n.type, arr);
  }
  for (const [type, nodes] of byType) {
    console.log(`## ${type} (${nodes.length})`);
    for (const n of nodes) {
      const summary =
        n.type === 'goal' ? n.title : n.type === 'decision' ? n.summary : n.body.slice(0, 80);
      console.log(`  - ${n.id}: ${summary}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
