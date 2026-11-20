// Types buildApp() declared inline, hoisted so every area can use them.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { Repo } from '../../db/repo.js';
import { proposeNewFolder } from '../../../lib/anthropic.js';
import type { WikiPage } from '../../db/repo.js';


export interface WikiTreeNode extends WikiPage {
  children: WikiTreeNode[];
}

//
// These are real OAuth connections mediated by Composio: we never see or store a token, only a
// `connected_account_id` reference (user_composio_connections). ONE generic
// `:toolkit` route family backs every Composio connector — adding a new
// toolkit means adding one entry to COMPOSIO_CONNECTORS and a
// `<toolkit>-live.ts` module, not a new set of routes. Gmail used to be the
// one exception here (a real per-user IMAP app-password connector with its
// own literal /me/apps/gmail routes) until it migrated onto this same
// Composio-managed OAuth family (2026-07-29).
export interface ComposioConnectorSpec {
  ensureAuthConfig: (repo: Repo) => Promise<string>;
  startConnect: (
    repo: Repo,
    userId: string,
    callbackUrl?: string,
  ) => Promise<{ connectedAccountId: string; redirectUrl: string | null }>;
  refreshStatus: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnect: (connectedAccountId: string) => Promise<void>;
  /** Picker items for the Add Sources UI (repos for github, channels for slack, ...). */
  listPickerItems: (userId: string, connectedAccountId: string) => Promise<unknown[]>;
}

// Test how a rule applies to a sample document (spec §5.5): dry-run the SAME
// capture the live ingest runs, once WITHOUT the rule and once WITH it, and
// persist nothing. Owner-gated (LLM cost + owner tooling). The response's two
// candidate lists drive the "with rule vs without" diff in the UI.
// The test surface depends on WHAT the rule does (spec §5.5): a source rule shows
// the scrubbed document; a use-phase rule shows the Ask answer with vs without;
// an ingestion rule shows the candidate diff.
export type RuleTestMode = 'source' | 'use' | 'ingestion';



/** One subgraph the ingest fanned into, with its independent capture result. */
export interface RoutedSubgraphResult {
  subgraph_id: string;
  candidates: number;
  /** Router judged the doc relevant for this subgraph but extraction yielded nothing. */
  zero_yield: boolean;
  /** At least one capture chunk timed out against the hosted LLM (see hosted-llm.ts). */
  timed_out: boolean;
}

/** What the ingest router decided about a document. */
export interface IngestRouting {
  /** Folders to capture into. EMPTY = none of the EXISTING folders fit —
   *  `proposeNewFolder` is then always set instead (never a silent drop). */
  targets: string[];
  /** A `#token` chose the targets, not the router. */
  pinned: boolean;
  /** 2-3 sentences describing the document; rides attrs.context on every node. */
  summary: string;
  stakeholders: string[];
  /** The router's one-sentence justification. */
  reason: string;
  /** The router CALL failed; `targets` is a safety net, not a decision. */
  failed: boolean;
  /**
   * Always set when `targets` is empty and the document isn't `pinned` — a
   * proposed name + description for a new folder. Never null in that case:
   * routing never ends in a silent drop, so an empty `targets` always turns
   * into a pending-route asking a human to create this folder (or reject
   * it) — see resolvePendingRoute. Never set when `pinned` (an explicit
   * #token already decided where this goes) or when `targets` is non-empty.
   */
  proposeNewFolder: Awaited<ReturnType<typeof proposeNewFolder>>['propose_new_folder'] | null;
  /**
   * Targets in `targets` whose folder has neither an owner description nor a
   * generated content digest — the router picked them with nothing to go on.
   * Non-empty here means the routing decision must be held for approval
   * (or a corrected folder choice) rather than auto-applied. Deterministic,
   * not model-judged — see spec-pomegranate-light.md "What the router must
   * read". Never set when `pinned`.
   */
  needsApprovalTargets: string[];
}

export type ResolvePendingRouteResult =
  | {
      ok: true;
      action: 'approved' | 'chosen' | 'rejected';
      targets: string[];
      new_subgraph_id?: string;
      candidates?: number;
      routed?: RoutedSubgraphResult[];
    }
  | { ok: false; error: 'not_found' | 'already_resolved' | 'invalid_targets'; status: 400 | 404 | 409 };
