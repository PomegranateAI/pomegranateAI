// MCP recipe catalog for the "Run this in Claude or ChatGPT" callouts on the
// Collaboration views. Each recipe maps a use case to the Pomegranate MCP tools
// an assistant would call, with a copy-pasteable example prompt. Tool names must
// match the real Pomegranate MCP surface (query_context, get_context,
// review_deliverable, ingest_document, list_recent_changes, list_folders,
// list_team, …).
import type { McpRecipe } from '../components/RunInClaude.js';

export const ASK_RECIPES: McpRecipe[] = [
  {
    title: 'Ask the vault a question',
    detail: 'Get a cited answer drawn only from your team’s vault — or an honest “I don’t know”.',
    tools: ['query_context'],
    prompt: 'In Pomegranate, what did we decide about our roadmap, with citations?',
  },
  {
    title: 'Read your vault before you draft',
    detail: 'Load the relevant vault into the assistant so what it writes is grounded and cited.',
    tools: ['get_context'],
    prompt: 'Read the positioning in our Pomegranate vault, then draft a homepage hero from it.',
  },
];

export const ALIGNMENT_RECIPES: McpRecipe[] = [
  {
    title: 'Check a draft against the vault',
    detail: 'Red/yellow/green findings, each citing the strategy node it supports or conflicts with.',
    tools: ['review_deliverable'],
    prompt: 'Review this draft against our Pomegranate vault and flag anything off-strategy: <paste draft>',
  },
  {
    title: 'Trace a claim to its source',
    detail: 'Ask what a specific statement is grounded in — or whether the vault contradicts it.',
    tools: ['query_context'],
    prompt: 'In Pomegranate, is it accurate to say we target enterprise buyers? Cite the nodes.',
  },
];

export const UPDATES_RECIPES: McpRecipe[] = [
  {
    title: 'Catch up on what changed',
    detail: 'List everything that entered the vault since a date — the on-demand version of a watch.',
    tools: ['list_recent_changes'],
    prompt: 'In Pomegranate, what changed in my directory since last Monday? Summarize with citations.',
  },
  {
    title: 'Digest a topic across directories',
    detail: 'Ask a focused question over your directory and a teammate’s to build your own update.',
    tools: ['list_folders', 'query_context'],
    prompt: 'Using Pomegranate, summarize competitive changes in the Product and Marketing directories.',
  },
  {
    title: 'Correct or extend a note',
    detail: 'Update a node’s content — it supersedes the original instead of overwriting it, so the trail stays readable.',
    tools: ['query_context', 'update_node'],
    prompt: 'In Pomegranate, find the node about our Q3 ship date and update it — it slipped to Q4.',
  },
];

export const DEPENDENCY_RECIPES: McpRecipe[] = [
  {
    title: 'Find who your project touches',
    detail: 'Discover teammates and their directories, then ask each what intersects your project.',
    tools: ['list_team', 'list_folders'],
    prompt: 'In Pomegranate, list my teammates and their directories so I can check project overlap.',
  },
  {
    title: 'Check for cross-project dependencies',
    detail: 'Query a teammate’s directory for work your project depends on or would block.',
    tools: ['query_context'],
    prompt:
      'Using Pomegranate, check the Platform directory: does anything block or depend on my onboarding project? <paste status>',
  },
];

export const STANDARDS_RECIPES: McpRecipe[] = [
  {
    title: 'Check a file against brand & policy',
    detail: 'Review a deck or doc against a collaborator directory’s guidelines, cited to the rule.',
    tools: ['review_deliverable'],
    prompt:
      'Review this deck against the Brand directory’s guidelines in Pomegranate and flag violations: <paste text>',
  },
  {
    title: 'Look up the applicable standard',
    detail: 'Ask what the policy or quality bar actually says before you check against it.',
    tools: ['query_context'],
    prompt: 'In Pomegranate’s Marketing Compliance directory, what are the rules for claims language?',
  },
];

// Setup → Explore team folders. The web page and these tools do the same job:
// find folders across the domain, see what's inside them, and ask for access to
// the ones you can't read yet. Nothing here mints a credential — one connection
// already reaches every folder you're a member of.
export const TEAM_FOLDER_RECIPES: McpRecipe[] = [
  {
    title: 'Explore what your team keeps where',
    detail: 'List teammates, their directories, and each directory’s folders — including ones not shared with you.',
    tools: ['explore_team_folders'],
    prompt: 'In Pomegranate, explore my team’s directories and their folders, and say which ones I can’t read yet.',
  },
  {
    title: 'Ask for access to a directory',
    detail: 'Email a directory’s owner asking to be added. Once they do, your existing connection reaches it.',
    tools: ['explore_team_folders', 'request_folder_access'],
    prompt: 'In Pomegranate, find the Brand directory and request access to it — say I need it for launch copy.',
  },
  {
    title: 'Work in a teammate’s directory',
    detail: 'Any tool takes a directory: name one you’re a member of and the answer comes from there.',
    tools: ['list_folders', 'query_context'],
    prompt: 'In Pomegranate, ask the Platform directory what shipped last month, with citations.',
  },
];
