/**
 * HTTP implementation of the outbound PomegranateClient. Talks to the app's MCP
 * HTTP tools (`review_deliverable`, `query_context`). Imports only from
 * [shared] modules so it can later move to `surfaces/shared` verbatim.
 */
import type {
  PomegranateClient,
  CanonHandle,
  RequesterRef,
  ReviewResult,
  QueryResult,
  DeliverableKind,
  IngestResult,
  ListCandidatesResult,
  ResolveOutcome,
} from './types.js';
import { UpstreamError } from './errors.js';

/** Build the question we ask `query_context` to surface the relevant canon. */
export function getContextQuestion(payload: string): string {
  return (
    'Which parts of this vault are relevant to the following material, and what do they say?\n\n' +
    payload
  );
}

const UPSTREAM_USER_MESSAGE =
  'Something went wrong reaching Pomegranate — try again.';

export class HttpPomegranateClient implements PomegranateClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async review(
    canon: CanonHandle,
    req: RequesterRef,
    deliverable: string,
    kind: DeliverableKind = 'other',
  ): Promise<ReviewResult> {
    const body = {
      content: deliverable,
      kind,
      ...(req.pomegranateUserId
        ? { on_behalf_of: req.pomegranateUserId }
        : {}),
    };
    const data = await this.post(
      `${canon.apiBaseUrl}/mcp/tools/review_deliverable`,
      canon.token,
      body,
    );
    return { id: data.id, findings: data.findings } as ReviewResult;
  }

  async getContext(
    canon: CanonHandle,
    req: RequesterRef,
    payload: string,
  ): Promise<QueryResult> {
    const body = {
      question: getContextQuestion(payload),
      scope: 'all',
      ...(req.pomegranateUserId
        ? { on_behalf_of: req.pomegranateUserId }
        : {}),
    };
    const data = await this.post(
      `${canon.apiBaseUrl}/mcp/tools/query_context`,
      canon.token,
      body,
    );
    return {
      answer: data.answer,
      cited_node_ids: data.cited_node_ids,
      has_answer: data.has_answer,
    } as QueryResult;
  }

  async ingest(
    canon: CanonHandle,
    req: RequesterRef,
    source: string,
    opts?: {
      sourceRef?: string;
      sourceKind?: 'doc' | 'slack' | 'transcript' | 'interaction';
      audience?: 'only_me' | 'private' | 'team';
    },
  ): Promise<IngestResult> {
    const body = {
      source,
      source_kind: opts?.sourceKind ?? 'doc',
      ...(opts?.sourceRef ? { source_ref: opts.sourceRef } : {}),
      ...(opts?.audience ? { audience: opts.audience } : {}),
      ...(req.pomegranateUserId
        ? { on_behalf_of: req.pomegranateUserId }
        : {}),
    };
    const data = await this.post(
      `${canon.apiBaseUrl}/mcp/tools/ingest_document`,
      canon.token,
      body,
    );
    return { candidates: data.candidates, document_id: data.document_id } as IngestResult;
  }

  async listCandidates(
    canon: CanonHandle,
    req: RequesterRef,
    opts?: { limit?: number },
  ): Promise<ListCandidatesResult> {
    const body = {
      status: 'pending',
      ...(opts?.limit ? { limit: opts.limit } : {}),
      ...(req.pomegranateUserId
        ? { on_behalf_of: req.pomegranateUserId }
        : {}),
    };
    const data = await this.post(
      `${canon.apiBaseUrl}/mcp/tools/list_candidates`,
      canon.token,
      body,
    );
    return data as ListCandidatesResult;
  }

  async approveCandidate(canon: CanonHandle, id: string): Promise<ResolveOutcome> {
    return this.resolveCandidate(canon, id, 'approve_candidate');
  }

  async rejectCandidate(canon: CanonHandle, id: string): Promise<ResolveOutcome> {
    return this.resolveCandidate(canon, id, 'reject_candidate');
  }

  /**
   * approve/reject share their outcome mapping: 200 → ok, 404 → not_found,
   * 409 → already_resolved (stale buttons / double clicks), anything else →
   * UpstreamError like every other call.
   */
  private async resolveCandidate(
    canon: CanonHandle,
    id: string,
    tool: 'approve_candidate' | 'reject_candidate',
  ): Promise<ResolveOutcome> {
    const url = `${canon.apiBaseUrl}/mcp/tools/${tool}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${canon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id }),
    });
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      return {
        ok: false,
        reason: 'already_resolved',
        status: (data as { status?: string }).status ?? 'resolved',
      };
    }
    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 500);
      } catch {
        // ignore: body may be unreadable
      }
      throw new UpstreamError(
        UPSTREAM_USER_MESSAGE,
        `Pomegranate ${url} returned HTTP ${res.status}: ${snippet}`,
      );
    }
    const data = (await res.json()) as { node_id?: string; summary?: string };
    return { ok: true, node_id: data.node_id, summary: data.summary };
  }

  private async post(
    url: string,
    token: string,
    body: unknown,
  ): Promise<any> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 500);
      } catch {
        // ignore: body may be unreadable
      }
      throw new UpstreamError(
        UPSTREAM_USER_MESSAGE,
        `Pomegranate ${url} returned HTTP ${res.status}: ${snippet}`,
      );
    }
    return res.json();
  }
}
