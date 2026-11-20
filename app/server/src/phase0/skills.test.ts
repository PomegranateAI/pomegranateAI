import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.join(__dirname, 'skills');

describe('skill manifests', () => {
  it('pomegranate-ingest has valid frontmatter', async () => {
    const raw = await fs.readFile(path.join(skillsDir, 'pomegranate-ingest/SKILL.md'), 'utf8');
    const m = matter(raw);
    expect(m.data.name).toBe('pomegranate-ingest');
    expect(typeof m.data.description).toBe('string');
    expect(m.data.description.length).toBeGreaterThan(20);
    expect(m.data.description.length).toBeLessThanOrEqual(1024);
    expect(Array.isArray(m.data['allowed-tools'])).toBe(true);
    expect(m.content.length).toBeGreaterThan(100);
  });

  it('pomegranate-review has valid frontmatter', async () => {
    const raw = await fs.readFile(path.join(skillsDir, 'pomegranate-review/SKILL.md'), 'utf8');
    const m = matter(raw);
    expect(m.data.name).toBe('pomegranate-review');
    expect(typeof m.data.description).toBe('string');
    expect(m.data.description.length).toBeGreaterThan(20);
    expect(Array.isArray(m.data['allowed-tools'])).toBe(true);
  });

  it('pomegranate-content-capture has valid frontmatter', async () => {
    const raw = await fs.readFile(
      path.join(skillsDir, 'pomegranate-content-capture/SKILL.md'),
      'utf8',
    );
    const m = matter(raw);
    expect(m.data.name).toBe('pomegranate-content-capture');
    expect(typeof m.data.description).toBe('string');
    expect(m.data.description.length).toBeGreaterThan(20);
    expect(m.data.description.length).toBeLessThanOrEqual(1024);
    expect(Array.isArray(m.data['allowed-tools'])).toBe(true);
    expect(m.content.length).toBeGreaterThan(100);
    // The skill must reference the capture-session CLI, not the review CLI.
    expect(m.content).toContain('capture-session');
  });

  it('Stop hook settings.json example parses as JSON', async () => {
    const raw = await fs.readFile(
      path.join(__dirname, '.claude-settings.example.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.hooks).toBeDefined();
    expect(Array.isArray(parsed.hooks.Stop)).toBe(true);
    expect(parsed.hooks.Stop[0].hooks[0].type).toBe('command');
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('review-hook');
  });
});
