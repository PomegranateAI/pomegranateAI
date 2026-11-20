/**
 * Pure Slack-command parser.
 *
 * Turns a raw `app_mention` message into a structured {@link Command}. Has no
 * Slack dependency — it operates on plain strings — so it can later move to
 * `surfaces/shared` verbatim (DESIGN §11.1).
 */
import { BadCommand, USAGE_HINT } from './errors.js';
import type { Command, Verb } from './types.js';

/** Matches a Slack user mention like `<@U0123>`, capturing the id. */
const USER_MENTION = /<@([^>|\s]+)(?:\|[^>]*)?>/g;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function parseMention(text: string, botUserId?: string): Command {
  let working = text;

  // (a) Strip the bot's own mention and any literal `@pomegranate` /
  //     standalone `pomegranate` word (case-insensitive).
  if (botUserId) {
    const botMention = new RegExp(
      `<@${botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^>]*)?>`,
      'g',
    );
    working = working.replace(botMention, ' ');
  }
  working = working.replace(/@?\bpomegranate\b/gi, ' ');

  // Detect the VERB (case-insensitive). `get context` (two words) is treated
  // as the single `getcontext` verb. The EARLIEST verb keyword in the message
  // wins, so a command like `ingest <pasted text that mentions a review>`
  // dispatches on `ingest`, not on a word inside its payload.
  const VERB_PATTERNS: Array<{ verb: Verb; re: RegExp }> = [
    { verb: 'getcontext', re: /\bget\s+context\b/i },
    { verb: 'getcontext', re: /\bgetcontext\b/i },
    { verb: 'review', re: /\breview\b/i },
    { verb: 'ingest', re: /\bingest\b/i },
    // `pending` / `candidates` both surface the approval queue.
    { verb: 'pending', re: /\b(?:pending|candidates)\b/i },
    // Channel listening. "stop listening" starts at "stop", which sits
    // earlier in the message than "listening" — earliest match wins, so the
    // stop form takes priority over the bare status verb.
    { verb: 'stoplisten', re: /\b(?:stop|quit)\s+listening\b|\bunlisten\b/i },
    { verb: 'listening', re: /\blistening\b/i },
    { verb: 'listen', re: /\blisten\b/i },
  ];
  let verb: Verb | undefined;
  let best: { index: number; re: RegExp } | undefined;
  for (const p of VERB_PATTERNS) {
    const m = p.re.exec(working);
    if (m && (!best || m.index < best.index)) {
      verb = p.verb;
      best = { index: m.index, re: p.re };
    }
  }
  if (!verb || !best) {
    throw new BadCommand(USAGE_HINT, `no verb found in: ${text}`);
  }
  working = working.replace(best.re, ' ');

  // After a `getcontext` verb, drop an optional leading `about` word from the
  // remainder.
  if (verb === 'getcontext') {
    working = working.replace(/^\s*about\b/i, ' ');
  }

  // Only the read verbs (review/getcontext) act on ANOTHER person's workspace,
  // so only they parse — and require — a `from @x` clause. Every other verb is
  // self-only: it writes to / curates the requester's OWN workspace and has no
  // other workspace to target, so a `from` in its message is always PAYLOAD,
  // never routing. Parsing it would misread incidental prose like "we both
  // learn from the calls … @Alice" as a foreign-workspace target and
  // reject a perfectly valid ingest.
  // Ingest only: an optional leading `as <audience>` chooses who can see the
  // content it integrates. Explicit `as …` prefix (not a bare word) so it never
  // swallows the first word of a real document. Stripped from the payload.
  let audience: Command['audience'];
  if (verb === 'ingest') {
    const audRe = /^\s*as\s+(only[-\s]?me|private|my\s+ai|ai\s+agents|team)\b[:,]?\s*/i;
    const am = audRe.exec(working);
    if (am) {
      const kw = am[1]!.toLowerCase().replace(/[-\s]+/g, ' ');
      audience = kw.startsWith('only') ? 'only_me' : kw === 'team' ? 'team' : 'private';
      working = working.slice(am.index + am[0].length);
    }
  }

  const parsesSubject = verb === 'review' || verb === 'getcontext';
  if (!parsesSubject) {
    return { verb, subjectUserId: null, remainder: collapse(working), audience };
  }

  // Find the SUBJECT: the first `<@U…>` mention that appears AFTER `from`.
  const fromMatch = /\bfrom\b/i.exec(working);
  if (!fromMatch) {
    throw new BadCommand(USAGE_HINT, `no \`from\` clause in: ${text}`);
  }

  const afterFrom = working.slice(fromMatch.index + fromMatch[0].length);
  USER_MENTION.lastIndex = 0;
  const subjectMatch = USER_MENTION.exec(afterFrom);
  if (!subjectMatch) {
    throw new BadCommand(
      USAGE_HINT,
      `no user mention after \`from\` in: ${text}`,
    );
  }
  const subjectUserId = subjectMatch[1]!;

  // Build the remainder: remove the entire `from <@subject>` clause, i.e.
  // everything from the `from` keyword through the matched subject mention.
  const fromStart = fromMatch.index;
  const subjectAbsEnd =
    fromMatch.index +
    fromMatch[0].length +
    subjectMatch.index +
    subjectMatch[0].length;
  working = working.slice(0, fromStart) + ' ' + working.slice(subjectAbsEnd);

  const remainder = collapse(working);

  return { verb, subjectUserId, remainder };
}
