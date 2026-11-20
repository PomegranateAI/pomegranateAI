import type {
  ReviewResult,
  QueryResult,
  Finding,
  Flag,
  FeedbackCategory,
  IngestResult,
  ListCandidatesResult,
  CandidateSummary,
  Reply,
} from './types.js';

const FLAG_EMOJI: Record<Flag, string> = {
  red: ':red_circle:',
  yellow: ':large_yellow_circle:',
  green: ':large_green_circle:',
};

const FLAG_ORDER: Flag[] = ['red', 'yellow', 'green'];

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  decisions: 'Decisions',
  goals_priorities: 'Goals & priorities',
  positioning: 'Positioning',
  brand_voice: 'Brand voice',
  context_recency: 'Vault recency',
};

const MAX_GREEN = 5;

function renderFinding(f: Finding): string {
  const emoji = FLAG_EMOJI[f.flag];
  const label = CATEGORY_LABEL[f.category];
  const citation = f.node_id
    ? ` (source: ${f.node_id})`
    : f.source_link
      ? ` (source: ${f.source_link})`
      : '';
  const head = `${emoji} *${label}* — ${f.summary}${citation}`;
  const quote = `> _"${f.quote_from_deliverable}"_`;
  return `${head}\n${quote}`;
}

export function formatReview(
  result: ReviewResult,
  subjectLabel: string,
): string {
  if (result.findings.length === 0) {
    return `:large_green_circle: Looks aligned — no flags against ${subjectLabel}'s vault.`;
  }

  const byFlag: Record<Flag, Finding[]> = { red: [], yellow: [], green: [] };
  for (const f of result.findings) {
    byFlag[f.flag].push(f);
  }

  const header =
    `*Review against ${subjectLabel}'s vault* — ` +
    `${byFlag.red.length} ${FLAG_EMOJI.red}  ` +
    `${byFlag.yellow.length} ${FLAG_EMOJI.yellow}  ` +
    `${byFlag.green.length} ${FLAG_EMOJI.green}`;

  const blocks: string[] = [header];

  for (const flag of FLAG_ORDER) {
    const findings = byFlag[flag];
    if (findings.length === 0) continue;

    if (flag === 'green' && findings.length > MAX_GREEN) {
      const shown = findings.slice(0, MAX_GREEN);
      for (const f of shown) blocks.push(renderFinding(f));
      const remaining = findings.length - MAX_GREEN;
      blocks.push(`…and ${remaining} more green`);
    } else {
      for (const f of findings) blocks.push(renderFinding(f));
    }
  }

  return blocks.join('\n\n');
}

export function formatGetContext(
  result: QueryResult,
  subjectLabel: string,
): string {
  if (!result.has_answer) {
    return `Nothing in ${subjectLabel}'s vault looks relevant to that.`;
  }
  return `${result.answer}\n\n_Sources: ${result.cited_node_ids.length} node(s) from ${subjectLabel}'s vault._`;
}

// ---------- ingest ----------

const AUDIENCE_PHRASE: Record<'only_me' | 'private' | 'team', string> = {
  only_me: 'only you (hidden from AI agents)',
  private: 'you and your AI agents',
  team: 'your whole team',
};

export function formatIngest(
  result: IngestResult,
  fileName?: string,
  audience?: 'only_me' | 'private' | 'team',
): string {
  const what = fileName ? `*${fileName}*` : 'that';
  // Only 'only_me'/'private' change the default; 'team' is already the default,
  // so we only call it out when the user narrowed the audience.
  const audLine =
    audience && audience !== 'team'
      ? ` Anything added is visible to *${AUDIENCE_PHRASE[audience]}*.`
      : '';
  if (result.candidates === 0) {
    return (
      `Ingested ${what} — no new changes proposed. ` +
      'Everything in it is already covered by your graph.'
    );
  }
  const n = result.candidates;
  return (
    `Ingested ${what} — *${n} proposed change${n === 1 ? '' : 's'}* now pending your approval.` +
    audLine +
    ' Say `pending` here to review them, or open the web app.'
  );
}

// ---------- pending candidates (Block Kit with approve/reject buttons) ----------

const CAND_FLAG_EMOJI: Record<Flag, string> = FLAG_EMOJI;

/** Block ids carry the candidate id so a button click can rewrite its rows. */
export function candidateSectionBlockId(id: string): string {
  return `cand:${id}`;
}
export function candidateActionsBlockId(id: string): string {
  return `act:${id}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function candidateBlocks(c: CandidateSummary): unknown[] {
  const emoji = CAND_FLAG_EMOJI[c.flag] ?? '';
  const conflict = c.conflicts_with ? `\n:warning: conflicts with \`${c.conflicts_with}\`` : '';
  const quote = c.source_quote ? `\n> _"${truncate(c.source_quote, 180)}"_` : '';
  return [
    {
      type: 'section',
      block_id: candidateSectionBlockId(c.id),
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${c.type}* — ${truncate(c.summary || '(no summary)', 280)}${conflict}${quote}`,
      },
    },
    {
      type: 'actions',
      block_id: candidateActionsBlockId(c.id),
      elements: [
        {
          type: 'button',
          action_id: 'cand_approve',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          value: c.id,
        },
        {
          type: 'button',
          action_id: 'cand_reject',
          style: 'danger',
          text: { type: 'plain_text', text: 'Reject' },
          value: c.id,
        },
      ],
    },
  ];
}

export function formatPending(result: ListCandidatesResult): Reply {
  if (result.total === 0) {
    return {
      text: 'Nothing pending — your graph is fully curated. :tada:',
    };
  }
  const shown = result.candidates;
  const headline =
    `*${result.total} proposed change${result.total === 1 ? '' : 's'} pending in your workspace*` +
    (result.total > shown.length ? ` — showing the first ${shown.length}` : '');
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    ...shown.flatMap((c) => candidateBlocks(c)),
  ];
  if (result.total > shown.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `…and ${result.total - shown.length} more — say \`pending\` again after resolving these, or open the web app.`,
        },
      ],
    });
  }
  // `text` is the notification fallback; the blocks carry the buttons.
  return { text: headline, blocks };
}

/**
 * Pure rewrite applied when a candidate's button is clicked: drop its action
 * (button) block and append a resolution line to its section block. Blocks
 * for other candidates are untouched. Unknown shapes pass through verbatim.
 */
export function resolveCandidateInBlocks(
  blocks: unknown[],
  candidateId: string,
  resolutionLine: string,
): unknown[] {
  const actId = candidateActionsBlockId(candidateId);
  const secId = candidateSectionBlockId(candidateId);
  return blocks
    .filter((b) => (b as { block_id?: string }).block_id !== actId)
    .map((b) => {
      const blk = b as { block_id?: string; text?: { type: string; text: string } };
      if (blk.block_id !== secId || !blk.text) return b;
      return {
        ...blk,
        text: { ...blk.text, text: `${blk.text.text}\n${resolutionLine}` },
      };
    });
}
