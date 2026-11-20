/**
 * Shared extraction-guidance builders for profile `source_types`.
 *
 * Every profile declares its own source-type list (PRDs, interviews, weekly
 * reviews, policy docs, …), but the CONVERSATION guidance is structurally the
 * same problem in every domain: chat is exploratory by default, yet teams
 * settle real canon in it — and the default capture gate (which rightly
 * excludes "open questions and options still being weighed") reads settled
 * conversational decisions as still-open brainstorm and drops them. These
 * builders keep that fix in ONE place so the five profiles don't drift; each
 * profile passes its own "capture especially" emphasis line.
 *
 * The guidance is profile-NEUTRAL by construction: it never names a kind key
 * — it tells the extractor how to read conversational register and defers to
 * the profile's own kind taxonomy (already in the prompt) for what to emit.
 */

/**
 * Extraction guidance for team conversations (Slack threads, chat exports,
 * informal back-and-forth between teammates). `emphasis` is a profile-specific
 * sentence: what this profile most wants captured from team chat.
 */
export function conversationGuidance(emphasis: string): string {
  return (
    'This source is a TEAM CONVERSATION — informal, multi-voice, exploratory by ' +
    'default. Most of it is thinking out loud and does not belong in the canon. ' +
    'But teams settle real things in chat, and those settlements ARE canon. Read ' +
    'the conversational register carefully:\n\n' +
    'WHAT COUNTS AS SETTLED IN A CONVERSATION:\n' +
    '- Explicit convergence: "let\'s go with X", "agreed", "ok, doing Y then", a ' +
    'proposal followed by assent from the participant who owns the call.\n' +
    '- Treated-as-fixed: a choice that later messages build on without dissent ' +
    '(they discuss HOW, not WHETHER) — even if no one said "decided".\n' +
    '- Stated facts: a participant reports a concrete fact (a number, a named ' +
    'competitor or external party, a date, an external constraint) — facts do not ' +
    'need convergence, only a clear assertion. Apply the kind taxonomy to decide ' +
    'whether the fact is canon.\n\n' +
    'WHAT STAYS OUT, exactly as the relevance gate says:\n' +
    '- Options still being weighed, including named alternatives that lost or were ' +
    'left hanging ("or we could call it Z…").\n' +
    '- One participant\'s enthusiasm the other did not engage with.\n' +
    '- Philosophical tangents, social filler, logistics.\n\n' +
    'ORIGIN AND CAUTION RULES for everything you extract from a conversation:\n' +
    '- End the candidate body with one sentence naming how it settled and by whom ' +
    '(e.g. "Agreed between Sam and Alice in conversation."). The reader must ' +
    'be able to see at a glance that this came from chat, not a formal document.\n' +
    '- Set confidence ≤ 0.8 for explicit convergence, ≤ 0.6 for treated-as-fixed. ' +
    'Never use the confidence you would give a formal document.\n' +
    '- When the settlement is implicit (treated-as-fixed) rather than explicit, ' +
    'flag the candidate yellow — it matches "hedged / low-conviction" for this ' +
    'workspace: real enough to capture, soft enough to deserve reviewer scrutiny.\n' +
    '- Explicit convergence keeps normal flag semantics (green when consistent, ' +
    'red when it reverses prior canon — chat reversals are still reversals).\n\n' +
    emphasis
  );
}

/**
 * Extraction guidance for interview-style sources (customer, expert, or
 * stakeholder interviews). Short on purpose: the capture prompt already
 * carries the speaker-attribution rules; this just reinforces register.
 */
export function interviewGuidance(emphasis: string): string {
  return (
    'This source is an INTERVIEW — apply the speaker-attribution rules ' +
    'strictly: evidence comes only from the external participant\'s own words; ' +
    'the interviewer\'s framing is hypothesis, not canon. Settledness gates ' +
    'decisions, not evidence — what the interviewee reports is capturable even ' +
    'when nothing is decided. ' +
    emphasis
  );
}
