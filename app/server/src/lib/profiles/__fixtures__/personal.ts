import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance } from '../source-types.js';

/**
 * The `personal` built-in profile. The operating model of one person's working
 * life: you drop in the Slack threads and emails you actually live in, and the
 * things worth keeping fall out into the right places. Five layers:
 *
 *   THINKING     idea                      — what you might do
 *   COMMITMENTS  task · calendar_event     — what you owe, and where you must be
 *   RECORDS      meeting · document        — what happened, and what to refer to
 *   MONEY        expense                   — what you spent
 *   PEOPLE       contact · company         — who and where
 *
 * Unlike `default` (whole_doc, one document → one note), this profile runs the
 * normal `claims` capture mode, because its whole point is FAN-OUT: one Slack
 * thread that confirms a lunch, mentions a receipt, and closes an action item
 * must yield a calendar_event AND an expense AND a task update. Whole-doc mode
 * physically cannot do that — it emits exactly one node per document and skips
 * dedup, which is also the machinery the lifecycle rule below depends on.
 * `default` is deliberately left alone as the no-structure starting point;
 * this is a separate profile users opt into.
 *
 * THE CONFIRMATION RULE — this profile's central discipline, and the reason it
 * is not just a note pile. Only things that are ACTUALLY SETTLED become
 * commitments. "We should grab lunch sometime" is not a calendar_event. "I
 * might expense the conference" is not an expense. "Someone should fix the
 * docs" is not a task. A commitment needs a real anchor — an agreed time, a
 * spent amount, an accepted owner. Everything still-being-weighed is an idea
 * or nothing at all. Without this rule the calendar fills with things that
 * never happened and the graph becomes untrustworthy.
 *
 * THE LIFECYCLE RULE — a to-do list is only useful if it closes. When a source
 * says an action was TAKEN, that is not a new task: it is the existing task
 * reaching its end state.
 *
 * THE RESTATEMENT RULE — how that close actually lands, and the only lever this
 * profile has over it. The supersede is decided by `runDedupJudge`, which runs
 * on a SHARED, profile-neutral prompt (no profile slots — see prompt-render.ts
 * `captureSlots` vs the judge) and only ever sees candidates that the EMBEDDING
 * neighbor lookup surfaced. Capture cannot help it directly: capture has no
 * graph slot, so it never knows a node id and can never set `conflicts_with`
 * to a real target (the promotion at anthropic.ts:2190 has nothing to promote).
 * What the profile CAN control is the candidate's TEXT — so the closing
 * candidate must restate the task in the SAME canonical wording as the open
 * one. High cosine similarity is what puts the open task in the judge's
 * neighbor set at all; a candidate phrased "sent it" shares no embedding
 * neighborhood with "send the Acme deck" and the judge never sees them
 * together.
 *
 * A completion must also stay GREEN, and that is MECHANICAL, not just
 * semantic: `dedupAgainstGraph` partitions with `eligible = green && !superseded`
 * (anthropic.ts:2210) — only green candidates reach the judge at all. Flagging
 * completions red would make them bypass the judge and never supersede
 * anything, quietly doubling every to-do.
 */
export const personalProfile: ContextProfile = {
  id: 'personal',
  shape: 'items',
  name: 'Personal',
  routing_hint:
    'One person\'s working life: to-dos and action items, confirmed calendar events and meetings, ' +
    'meeting notes, expenses and receipts, the people and companies they deal with, ideas they have ' +
    'not acted on yet, and reference documents. Route here for the operational substance of someone\'s ' +
    'day — what they owe, where they must be, what they spent, who they know. NOT for team-level canon: ' +
    'positioning, product decisions, and brand rules belong to their own folders even when they surface ' +
    'in the same thread.',
  description:
    'One person\'s working life, kept in order: the things they owe (to-dos and action items), the ' +
    'commitments they have made in time (confirmed meetings and events), the records of what happened ' +
    '(meeting notes and reference documents), the money they spent (expenses and receipts), the people ' +
    'and companies they deal with, and the ideas they have had but not acted on. The sources are the ' +
    'places they actually work: Slack threads, email, meeting transcripts, receipts, and notes to ' +
    'self.\n\n' +
    'THE CLOSURE RULE — READ THIS BEFORE THE CONFIRMATION RULE, because it OVERRIDES it. When a ' +
    'line reports that something HAPPENED — "sent it", "submitted the expense report", "1:1 ' +
    'scheduled", "dentist done", "got reimbursed", "cancelled Thursday" — it is a CLOSURE of the ' +
    'item it names, and closures are ALWAYS extractable. A closure NEVER needs a date, an owner, ' +
    'or an amount, because those live on the item being closed, not on the news that it closed. ' +
    'Test for a closure FIRST, before any other rule: if the line reports something done, emit the ' +
    'item in its canonical form with its new status and STOP — do not then ask whether it has an ' +
    'agreed time or a spent amount, and do not discard it for lacking them. "1 to 1 with team ' +
    'scheduled" is the to-do "schedule 1:1s with team" now done; it is NOT a calendar_event ' +
    'missing a time, and it must never be dropped for missing one.\n\n' +
    'THE CONFIRMATION RULE — only what is ACTUALLY SETTLED becomes a NEW commitment. This governs ' +
    'CREATION ONLY: it decides whether something not yet in the folder gets in. It has NO say over ' +
    'closures (see THE CLOSURE RULE — a closure has already passed this test, back when the item ' +
    'was created). It is violated by being helpful:\n' +
    '- A calendar_event needs an AGREED time. "Tuesday at 3 works for me — booked" is an event. ' +
    '"We should grab lunch sometime", "does next week work?", and "I\'ll find a slot" are NOT — a ' +
    'proposal awaiting an answer is not a commitment, no matter how likely it looks.\n' +
    '- An expense needs a SPENT amount. "$340 for the flights, booked" is an expense. "flights will ' +
    'run about $340" and "I might expense the conference" are NOT.\n' +
    '- A task needs an ACCEPTED owner. "I\'ll send the deck by Friday" is a task. "someone should ' +
    'update the docs" and "we could redo the onboarding" are NOT — an unowned intention is an idea.\n' +
    'When something is proposed but unsettled, capture it as an `idea` or capture nothing. NEVER ' +
    'promote a proposal into a commitment to be helpful: a calendar full of meetings that never ' +
    'happened is worse than an empty one.\n\n' +
    'A FEW WORDS IS A COMPLETE DOCUMENT. Sources in this folder are usually TINY — "sent the ' +
    'invoice", "call mum", "£12 coffee with Dana", "moved Thursday to 4pm". A three-word source is ' +
    'the NORMAL case here, not a fragment, not noise, and never "too thin to extract". Judge such a ' +
    'source RELEVANT and extract from it: shortness carries no information about importance. Do not ' +
    'wait for context that is not coming, and do not invent any — a source that says only "sent the ' +
    'invoice" yields exactly one task, done, and nothing else.\n\n' +
    'THE LIFECYCLE RULE — when a source says an action was TAKEN ("sent it", "paid the invoice", ' +
    '"that\'s done", "cancelled the meeting"), that is NOT a new item. It is an existing item ' +
    'reaching a new state. Emit the item with its new status (done / cancelled / reimbursed). A ' +
    'completion is the expected end of a healthy task — flag it GREEN, not red; only a REVERSAL ' +
    '(a confirmed event cancelled, a settled decision undone) is red.\n\n' +
    'ALWAYS SET THE STATUS ATTR on task, calendar_event and expense — on creation as much as on ' +
    'closing ("open", "confirmed", "logged"). A node stored with no status has no state to change, ' +
    'so it can never be closed by a later update: it just sits in the list forever. This is the ' +
    'cheapest thing to get wrong and the most expensive to notice.\n\n' +
    'THE RESTATEMENT RULE — this is HOW a completion finds the task it closes, and getting it wrong ' +
    'silently doubles the to-do list. Write the closing item in the SAME CANONICAL WORDING the open ' +
    'item would have, then state the completion. The title must be the TASK, not the news: for ' +
    '"just sent that Acme deck over", the title is "send the Acme deck" (the task, verbatim as it ' +
    'would have been written) with status done and a body reading "Sent. <what the source said>." — ' +
    'NEVER title it "sent the Acme deck" or "Acme deck update". The system matches the closing item ' +
    'to the open one by the SIMILARITY OF THEIR TEXT and by nothing else: it has no memory of which ' +
    'task you meant. Same words → the open task is found and closed. Different words → a second, ' +
    'near-duplicate task appears and the list quietly rots. When you cannot tell what the original ' +
    'task was called, restate it in the plainest imperative the source supports.\n\n' +
    'SCOPING — set the `company` attr (the company SHORT NAME, lowercase) on anything tied to one ' +
    'company; set `contact` (the person\'s name as the source writes it) on anything tied to one ' +
    'person. Write both as lowercase space-separated words exactly as the source names them — never ' +
    'hyphenate or invent punctuation — and set ONLY the attrs each kind declares.\n\n' +
    'NOT THIS DOMAIN: team-level canon. Positioning, product decisions, brand rules, roadmaps, and ' +
    'strategy belong to their own folders even when they come up in the same thread. This folder is ' +
    'about what ONE PERSON owes, attends, spends, and knows — not what the team has decided.\n\n' +
    'KIND DECISION TREE — test in this order, first match wins:\n' +
    '0. IS IT A CLOSURE? Does the line report that something already HAPPENED, was done, ' +
    'submitted, scheduled, paid, reimbursed, moved, or cancelled? → emit the item it closes, in ' +
    'the canonical wording of the ORIGINAL item, with its new status. Pick the kind from what the ' +
    'ORIGINAL item is, not from how the news is phrased: "expense report submitted" closes the ' +
    'to-do "submit expense report" → task (an expense report is a form you file — the EXPENSE is ' +
    'the money, the FILING is a task); "dentist done" closes the to-do "dentist appointment" → ' +
    'task; "got reimbursed for the flights" closes the expense → expense. Skip every test below ' +
    'once this matches, and NEVER discard a closure for missing a date, owner, or amount.\n' +
    '1. Money that was actually spent or is owed, with an amount → expense\n' +
    '2. A commitment in TIME with an agreed date — a booked meeting, a deadline, travel → calendar_event\n' +
    '3. An action someone accepted responsibility for, or reported doing → task\n' +
    '4. A person — their role, contact details, or who they are → contact\n' +
    '5. A company or organization and our relationship to it → company\n' +
    '6. The record of a meeting that happened — what was said and decided → meeting\n' +
    '7. A suggestion, possibility, or want that nobody has committed to → idea\n' +
    '8. A document or note worth keeping for reference, not better captured above → document\n\n' +
    'DO NOT EXTRACT (not canon, even in relevant sources): proposals, suggestions, and possibilities ' +
    'presented as commitments (THE CONFIRMATION RULE — they are ideas or nothing); pleasantries, ' +
    'greetings, and social filler; the mechanics of scheduling itself ("does 3 work?", "sending an ' +
    'invite now") as distinct from the settled result; speculative amounts and estimates; team-level ' +
    'strategy, positioning, or product decisions; anything about a person that is gossip, evaluative, ' +
    'or sensitive rather than a working fact (role, contact details, company).',
  kinds: [
    {
      key: 'task',
      label: 'To-do',
      label_plural: 'To-do list',
      color: 2,
      consequence: 'medium',
      description:
        'An action someone accepted responsibility for. Title: imperative verb + object in ≤10 words ' +
        '("send the Acme deck"). A task needs an ACCEPTED OWNER (THE CONFIRMATION RULE): "I\'ll do X" ' +
        'and "can you do X?" / "yes" are tasks; "someone should do X" is an idea, not a task.\n\n' +
        'THE LIFECYCLE + RESTATEMENT RULES apply here above all — this kind is where they earn their ' +
        'keep. When a source reports an action was DONE, do not emit a second task: emit the SAME ' +
        'task with status done, TITLED AS THE TASK in the canonical imperative ("send the Acme ' +
        'deck"), never as the news ("sent the Acme deck", "Acme deck done"). The closing item is ' +
        'matched to the open one by TEXT SIMILARITY alone — same words closes it, different words ' +
        'silently creates a near-duplicate and the list rots. Put the completion in the BODY ' +
        '("Sent 2026-07-15."), never in the title. A completion is GREEN, not red. Only cancelling a ' +
        'task someone was relying on is a reversal.\n\n' +
        'A few words is enough: "sent the invoice" is a complete, extractable source — one task, ' +
        'done. Never skip a short update for lacking context.\n\n' +
        'NOT a task: a booked meeting (→ calendar_event); an unowned want (→ idea); the record of the ' +
        'meeting the task came out of (→ meeting).\n\n' +
        'task.subkind — choose ONE: action_item, follow_up, reminder.',
      subkinds: [
        { key: 'action_item', label: 'Action item', description: 'A concrete thing to do that someone owns.' },
        { key: 'follow_up', label: 'Follow-up', description: 'Chasing someone or something after a prior interaction.' },
        { key: 'reminder', label: 'Reminder', description: 'A time-anchored nudge with no deliverable.' },
      ],
      attrs: [
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['open', 'done', 'cancelled'],
          required: true,
          description:
            'Set on EVERY task — default to "open" when the source does not say, because a task with no status ' +
            'cannot be closed later (no state to change) and lands in no Graph bucket. done closes it (green — the ' +
            'expected end). cancelled is a reversal (red).',
        },
        { key: 'due', label: 'Due', type: 'date', description: 'The agreed date, when stated. Never invent one.' },
        { key: 'owner', label: 'Owner', type: 'string', description: 'Who accepted it, as the source names them. Required — an unowned task is an idea.' },
        { key: 'company', label: 'Company', type: 'string', description: 'The company it is for, lowercase short name; omit when personal or internal.' },
        { key: 'contact', label: 'Contact', type: 'string', description: 'The person it concerns, when named.' },
      ],
      buckets: [
        { key: 'open', label: 'Open', match: 'status' },
        { key: 'done', label: 'Done', match: 'status' },
        { key: 'cancelled', label: 'Cancelled', match: 'status' },
      ],
    },
    {
      key: 'calendar_event',
      label: 'Calendar event',
      label_plural: 'Calendar',
      color: 4,
      consequence: 'medium',
      description:
        'A commitment in TIME with an agreed date: a booked meeting, a deadline, travel, an ' +
        'appointment. Title: what it is in ≤8 words ("lunch with Dana, Acme"). Body: what was agreed, ' +
        'as stated.\n\n' +
        'THE CONFIRMATION RULE is binding here FOR NEW EVENTS and this is where it is most often ' +
        'broken. A NEW calendar_event requires an AGREED TIME that both sides landed on: "Tuesday ' +
        '3pm works — booked", "confirmed for the 14th". A proposal is NOT an event: "does Tuesday ' +
        'work?", "we should meet sometime", "I\'ll send an invite" — none of those are events, ' +
        'however likely they look. When the time is proposed but unanswered, emit NOTHING (or an ' +
        'idea if it is a standing want). A calendar the person cannot trust is worse than no ' +
        'calendar.\n\n' +
        'THE CLOSURE RULE OVERRIDES ALL OF THAT for an event that already exists: "moved Thursday ' +
        'to 4pm", "cancelled the Tuesday sync" close or update the recorded event and are ALWAYS ' +
        'extractable — the agreed time is already on the node being updated, so never re-demand ' +
        'it and never discard the update for lacking it.\n\n' +
        'NOT a calendar_event: the notes FROM a meeting that already happened (→ meeting); an action ' +
        'with a due date but no appointment (→ task, with its due attr). Cancelling a confirmed ' +
        'event is a reversal: set status cancelled and flag red.\n\n' +
        'calendar_event.subkind — choose ONE: meeting, deadline, travel, appointment.',
      subkinds: [
        { key: 'meeting', label: 'Meeting', description: 'A booked meeting with other people.' },
        { key: 'deadline', label: 'Deadline', description: 'A date something is due by, agreed with someone.' },
        { key: 'travel', label: 'Travel', description: 'Booked travel: flights, trains, stays.' },
        { key: 'appointment', label: 'Appointment', description: 'A personal booked slot.' },
      ],
      attrs: [
        { key: 'starts', label: 'Starts', type: 'date', description: 'The agreed start. Required — an event without one is a proposal, not an event.' },
        { key: 'ends', label: 'Ends', type: 'date', description: 'When stated.' },
        { key: 'location', label: 'Location', type: 'string', description: 'Where, when stated (including a video link).' },
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['confirmed', 'cancelled'],
          required: true,
          description:
            'Set on EVERY event — default to "confirmed" when the source does not say, since only confirmed things ' +
            'are events at all. cancelled is a reversal (red).',
        },
        { key: 'company', label: 'Company', type: 'string', description: 'The company it is with, lowercase short name; omit when personal.' },
        { key: 'contact', label: 'Contact', type: 'string', description: 'Who it is with, when named.' },
      ],
      buckets: [
        { key: 'confirmed', label: 'Confirmed', match: 'status' },
        { key: 'cancelled', label: 'Cancelled', match: 'status' },
      ],
    },
    {
      key: 'expense',
      label: 'Expense',
      label_plural: 'Expenses',
      color: 5,
      consequence: 'medium',
      description:
        'Money actually spent or owed, WITH an amount. Title: what it was for in ≤8 words ("flights ' +
        'to Lisbon offsite"). Body: what was bought and why, as stated.\n\n' +
        'THE CONFIRMATION RULE (NEW expenses only): a new expense needs a SPENT amount. "$340 for ' +
        'the flights, booked" is an expense; "flights will run about $340" and "I might expense the ' +
        'conference" are estimates and intentions — not expenses. Carry the amount VERBATIM ' +
        'including its currency symbol exactly as the source writes it ("$340", "€1,200") — never ' +
        'convert, never round, never infer a currency the source did not state. A NEW expense with ' +
        'no amount in the source is not capturable: emit nothing rather than an amount-less ' +
        'expense.\n\n' +
        'THE CLOSURE RULE OVERRIDES THE AMOUNT GATE for an expense that already exists. "Got ' +
        'reimbursed for the flights" and "submitted it" are the SAME expense reaching a new status ' +
        '— restate it in its original wording, set the new status, and emit it. NEVER require an ' +
        'amount to close an expense: nobody restates the amount when they report a reimbursement, ' +
        'so demanding one would make the logged → submitted → reimbursed lifecycle impossible to ' +
        'ever record. The amount is already on the node being closed.\n\n' +
        'NOT an expense: a budget or a plan to spend (→ idea, or nothing); a vendor as an entity ' +
        '(→ company).\n\n' +
        'expense.category — choose ONE: software, travel, meals, hardware, services, other.',
      categories: [
        { key: 'software', label: 'Software', description: 'Subscriptions, licences, SaaS.' },
        { key: 'travel', label: 'Travel', description: 'Flights, trains, hotels, transport.' },
        { key: 'meals', label: 'Meals', description: 'Food and drink, incl. client meals.' },
        { key: 'hardware', label: 'Hardware', description: 'Devices and physical equipment.' },
        { key: 'services', label: 'Services', description: 'Contractors, agencies, professional services.' },
        { key: 'other', label: 'Other', description: 'Anything the other categories do not cover.' },
      ],
      attrs: [
        { key: 'amount', label: 'Amount', type: 'string', description: 'Verbatim with its currency symbol as the source writes it ("$340", "€1,200"). Required — never convert or round.' },
        { key: 'spent_on', label: 'Spent on', type: 'date', description: 'When it was spent, when stated.' },
        { key: 'company', label: 'Company', type: 'string', description: 'The vendor or counterparty, lowercase short name.' },
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['logged', 'submitted', 'reimbursed'],
          required: true,
          description:
            'Set on EVERY expense — default to "logged" when the source does not say. submitted and reimbursed are ' +
            'lifecycle steps (green), not reversals.',
        },
      ],
      buckets: [
        { key: 'software', label: 'Software', match: 'category' },
        { key: 'travel', label: 'Travel', match: 'category' },
        { key: 'meals', label: 'Meals', match: 'category' },
        { key: 'hardware', label: 'Hardware', match: 'category' },
        { key: 'services', label: 'Services', match: 'category' },
        { key: 'other', label: 'Other', match: 'category' },
      ],
    },
    {
      key: 'meeting',
      label: 'Meeting note',
      label_plural: 'Meeting notes',
      color: 3,
      consequence: 'low',
      description:
        'The record of a meeting that ALREADY HAPPENED: who was there, what was discussed, what was ' +
        'settled. Title: who and about what in ≤10 words ("Acme QBR — renewal timing"). Body: what ' +
        'was actually said and decided, as stated — not a summary of the transcript\'s vibe.\n\n' +
        'ONE node per meeting: the meeting is the record, and the things that came OUT of it are ' +
        'separate nodes. A meeting that produced three action items yields ONE meeting node and THREE ' +
        'task nodes — never one node containing the list.\n\n' +
        'NOT a meeting: a booked future meeting (→ calendar_event — a meeting note is retrospective, ' +
        'an event is prospective); an action item from it (→ task); a person who attended ' +
        '(→ contact).\n\n' +
        'meeting.subkind — choose ONE: external, internal, one_on_one.',
      subkinds: [
        { key: 'external', label: 'External', description: 'With people outside the company: clients, vendors, partners.' },
        { key: 'internal', label: 'Internal', description: 'With colleagues.' },
        { key: 'one_on_one', label: 'One-on-one', description: 'A recurring or ad-hoc 1:1.' },
      ],
      attrs: [
        { key: 'met_on', label: 'Met on', type: 'date', description: 'When it happened, when stated.' },
        { key: 'company', label: 'Company', type: 'string', description: 'The company it was with, lowercase short name; omit when internal.' },
        { key: 'contact', label: 'Contact', type: 'string', description: 'Who was there, when named.' },
      ],
      buckets: [
        { key: 'external', label: 'External', match: 'subkind' },
        { key: 'internal', label: 'Internal', match: 'subkind' },
        { key: 'one_on_one', label: '1:1', match: 'subkind' },
      ],
    },
    {
      key: 'contact',
      label: 'Contact',
      label_plural: 'Contacts',
      color: 6,
      consequence: 'low',
      description:
        'A person and the WORKING facts about them: their role, where they work, how to reach them. ' +
        'Title: their name. ONE node per person — a person mentioned in ten threads is still one ' +
        'contact; add to the existing node rather than emitting a second.\n\n' +
        'CAPTURE ONLY WORKING FACTS: name, role, company, email, phone, handle. NEVER capture ' +
        'evaluative, personal, or sensitive observations about a person — how they performed, what ' +
        'someone thinks of them, their health, their plans to leave. Those are not working facts and ' +
        'they do not belong in a graph that answers questions out loud. When a source mixes both, take ' +
        'the working facts and leave the rest.\n\n' +
        'NOT a contact: the company they work at (→ company, with a works_at edge); a meeting they ' +
        'attended (→ meeting).\n\n' +
        'contact.subkind — choose ONE: colleague, client, vendor, prospect, other.',
      subkinds: [
        { key: 'colleague', label: 'Colleague', description: 'Someone at the same company.' },
        { key: 'client', label: 'Client', description: 'Someone at a customer.' },
        { key: 'vendor', label: 'Vendor', description: 'Someone at a supplier.' },
        { key: 'prospect', label: 'Prospect', description: 'Someone at a potential customer.' },
        { key: 'other', label: 'Other', description: 'Anyone the other subkinds do not cover.' },
      ],
      attrs: [
        { key: 'email', label: 'Email', type: 'string', description: 'When stated in the source. Never guess from a name.' },
        { key: 'phone', label: 'Phone', type: 'string', description: 'When stated.' },
        { key: 'role', label: 'Role', type: 'string', description: 'Their job title or function, as stated.' },
        { key: 'company', label: 'Company', type: 'string', description: 'Where they work, lowercase short name.' },
        { key: 'handle', label: 'Handle', type: 'string', description: 'Slack handle or similar, when stated.' },
      ],
      buckets: [
        { key: 'colleague', label: 'Colleagues', match: 'subkind' },
        { key: 'client', label: 'Clients', match: 'subkind' },
        { key: 'vendor', label: 'Vendors', match: 'subkind' },
        { key: 'prospect', label: 'Prospects', match: 'subkind' },
        { key: 'other', label: 'Other', match: 'subkind' },
      ],
    },
    {
      key: 'company',
      label: 'Company',
      label_plural: 'Companies',
      color: 3,
      consequence: 'low',
      description:
        'An organization and OUR RELATIONSHIP to it: who they are, what we buy from or sell to them, ' +
        'where things stand. Title: the company name. ONE node per company — never comma-join ' +
        'organizations.\n\n' +
        'Set the relationship attr: it is the reason the company is in the graph at all. A company ' +
        'with no stated relationship to us is usually a passing mention, not a node — when a thread ' +
        'merely name-drops an organization, emit nothing.\n\n' +
        'NOT a company: a person who works there (→ contact, with a works_at edge); an expense paid ' +
        'to them (→ expense, with its company attr).\n\n' +
        'company.subkind — choose ONE: customer, vendor, partner, prospect, other.',
      subkinds: [
        { key: 'customer', label: 'Customer', description: 'They pay us.' },
        { key: 'vendor', label: 'Vendor', description: 'We pay them.' },
        { key: 'partner', label: 'Partner', description: 'We work together without a purchase.' },
        { key: 'prospect', label: 'Prospect', description: 'They might pay us.' },
        { key: 'other', label: 'Other', description: 'Anything the other subkinds do not cover.' },
      ],
      attrs: [
        { key: 'company', label: 'Company', type: 'string', description: 'The company\'s own short name, lowercase. Required — scoped nodes reference it by this name.' },
        { key: 'domain', label: 'Domain', type: 'string', description: 'Their website or email domain, when stated.' },
      ],
      buckets: [
        { key: 'customer', label: 'Customers', match: 'subkind' },
        { key: 'vendor', label: 'Vendors', match: 'subkind' },
        { key: 'partner', label: 'Partners', match: 'subkind' },
        { key: 'prospect', label: 'Prospects', match: 'subkind' },
        { key: 'other', label: 'Other', match: 'subkind' },
      ],
    },
    {
      key: 'idea',
      label: 'Idea',
      label_plural: 'Ideas',
      color: 1,
      consequence: 'low',
      description:
        'Something worth doing that NOBODY HAS COMMITTED TO. This is where THE CONFIRMATION RULE ' +
        'sends everything that is not settled: the unowned want, the floated meeting, the maybe-spend, ' +
        'the "we should really…". Title: the idea in ≤10 words.\n\n' +
        'The idea kind is what makes the confirmation rule safe to enforce — a proposal is not lost, ' +
        'it is filed as what it actually is. When an idea is later ACCEPTED by someone, that is a task ' +
        '(or an event, or an expense); the idea does not need retracting.\n\n' +
        'NOT an idea: an accepted action (→ task); a booked event (→ calendar_event); a team-level ' +
        'product or strategy proposal (→ not this folder at all).\n\n' +
        'idea.subkind — choose ONE: suggestion, want, question.',
      subkinds: [
        { key: 'suggestion', label: 'Suggestion', description: 'Something someone proposed doing.' },
        { key: 'want', label: 'Want', description: 'A standing wish with no owner or date.' },
        { key: 'question', label: 'Question', description: 'Something open that needs answering before anything can be decided.' },
      ],
      attrs: [
        { key: 'company', label: 'Company', type: 'string', description: 'The company it concerns, lowercase short name; omit when general.' },
        { key: 'contact', label: 'Contact', type: 'string', description: 'The person it concerns, when named.' },
      ],
      buckets: [
        { key: 'suggestion', label: 'Suggestions', match: 'subkind' },
        { key: 'want', label: 'Wants', match: 'subkind' },
        { key: 'question', label: 'Open questions', match: 'subkind' },
      ],
    },
    {
      key: 'document',
      label: 'Document',
      label_plural: 'Documents',
      color: 1,
      consequence: 'low',
      description:
        'A document or note worth keeping for reference, when nothing more specific fits. This is the ' +
        'CATCH-ALL of this profile: material that is genuinely useful to have but is not a to-do, an ' +
        'event, an expense, a meeting record, a person, a company, or an idea. Title: what it is in ' +
        '≤10 words. Body: the content, or the passage that matters, as written.\n\n' +
        'Set url when the source points at a real artifact (a Drive link, a shared doc, an attachment) ' +
        '— a document node that references a file without linking it is hard to act on later.\n\n' +
        'NOT a document: anything a more specific kind covers (test the decision tree first — the ' +
        'catch-all is last for a reason); a passing link with no stated reason to keep it.\n\n' +
        'document.subkind — choose ONE: reference, note, file.',
      subkinds: [
        { key: 'reference', label: 'Reference', description: 'Material to refer back to: a policy, a spec, a guide.' },
        { key: 'note', label: 'Note', description: 'A note to self worth keeping.' },
        { key: 'file', label: 'File', description: 'A real artifact, linked by url.' },
      ],
      attrs: [
        { key: 'url', label: 'Link', type: 'string', description: 'Link to the artifact, when the source provides one.' },
        { key: 'company', label: 'Company', type: 'string', description: 'The company it concerns, lowercase short name; omit when general.' },
      ],
      buckets: [
        { key: 'reference', label: 'Reference', match: 'subkind' },
        { key: 'note', label: 'Notes', match: 'subkind' },
        { key: 'file', label: 'Files', match: 'subkind' },
      ],
    },
  ],
  feedback_dimensions: [
    {
      key: 'commitment_accuracy',
      label: 'Commitment accuracy',
      description: 'does not promise, restate, or contradict a commitment inconsistently with the recorded to-do list and calendar',
    },
    {
      key: 'schedule_fit',
      label: 'Schedule fit',
      description: 'does not propose a time that clashes with a recorded calendar event, or a date already past',
    },
    {
      key: 'fact_accuracy',
      label: 'Fact accuracy',
      description: 'names, roles, companies, links, and amounts match what is recorded — no invented or misremembered details',
    },
    {
      key: 'money_accuracy',
      label: 'Money accuracy',
      description: 'amounts, currencies, and expense status match the recorded expenses exactly, with no rounding or conversion',
    },
    {
      key: 'context_recency',
      label: 'Context recency',
      description: 'reflects recent meetings, completed or cancelled items, and changed plans the work should account for',
    },
  ],
  review_kinds: ['email', 'message', 'agenda', 'meeting_summary', 'plan', 'expense_report', 'other'],
  query_scopes: [
    { key: 'todos', label: 'To-do list', kind_keys: ['task'] },
    { key: 'calendar', label: 'Calendar', kind_keys: ['calendar_event'] },
    { key: 'commitments', label: 'Everything I owe', kind_keys: ['task', 'calendar_event'] },
    { key: 'meetings', label: 'Meeting notes', kind_keys: ['meeting'] },
    { key: 'money', label: 'Expenses', kind_keys: ['expense'] },
    { key: 'people', label: 'People & companies', kind_keys: ['contact', 'company'] },
    { key: 'ideas', label: 'Ideas', kind_keys: ['idea'] },
    { key: 'documents', label: 'Documents', kind_keys: ['document'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  extraction_groups: [
    {
      key: 'commitments',
      label: 'To-dos & calendar',
      kind_keys: ['task', 'calendar_event'],
      description:
        'Actions someone accepted responsibility for, actions reported as done, and commitments in time with an agreed ' +
        'date — booked meetings, deadlines, travel. Only settled things; proposals are not commitments.',
    },
    {
      key: 'money',
      label: 'Expenses',
      kind_keys: ['expense'],
      description: 'Money actually spent or owed, with an amount: receipts, invoices, bookings, subscriptions, and reimbursement status.',
    },
    {
      key: 'records',
      label: 'Meetings & documents',
      kind_keys: ['meeting', 'document'],
      description: 'Records of meetings that already happened — who, what was said, what was settled — and reference material worth keeping.',
    },
    {
      key: 'people',
      label: 'People & companies',
      kind_keys: ['contact', 'company'],
      description: 'Working facts about people (role, company, contact details) and companies (who they are, our relationship to them).',
    },
    {
      key: 'ideas',
      label: 'Ideas',
      kind_keys: ['idea'],
      description: 'Suggestions, wants, and open questions nobody has committed to — everything the confirmation rule keeps out of the commitments.',
    },
  ],
  flag_semantics: {
    red:
      'reverses something recorded — cancels a confirmed calendar event or a task someone was relying on, contradicts a ' +
      'recorded fact about a person or company, or changes a recorded amount. NOTE a task reaching done, or an expense ' +
      'reaching submitted/reimbursed, is NOT a reversal — that is the expected lifecycle and it is green',
    yellow:
      'proposed rather than settled, or incomplete — a time floated but not agreed, an expense with no amount or date, a ' +
      'task with no clear owner, an action inferred rather than stated, a person or company mentioned without a stated ' +
      'relationship',
    green:
      'clearly stated and settled: an agreed time, an accepted owner, a spent amount, a stated working fact — including a ' +
      'task reported done or an expense reported reimbursed',
  },
  edge_kinds: [
    {
      key: 'works_at',
      label: 'Works at',
      description:
        'Points FROM a contact TO the company they work at — the backbone relation of this profile, and what makes "who ' +
        'do I know at X?" answerable. Only when the source states where they work; never inferred from an email domain ' +
        'the source did not give, and never from two names appearing in the same thread. (Deterministic guard: the ' +
        'contact must carry a company attr matching the company node.)',
      src_kinds: ['contact'],
      dst_kinds: ['company'],
      directed: true,
      scope_attr: 'company',
    },
    {
      key: 'with',
      label: 'With',
      description:
        'Points FROM a meeting or calendar event TO a person who was (or will be) there — answers "what did I discuss ' +
        'with Dana?". Only for people the source explicitly names as attending; never everyone mentioned in passing ' +
        'during the meeting.',
      src_kinds: ['meeting', 'calendar_event'],
      dst_kinds: ['contact'],
      directed: true,
    },
    {
      key: 'from',
      label: 'Came out of',
      description:
        'Points FROM a task or idea TO the meeting it came out of — answers "what did I commit to in that meeting?". ' +
        'Only when the task genuinely originated in that meeting, never because they share a topic or a date.',
      src_kinds: ['task', 'idea'],
      dst_kinds: ['meeting'],
      directed: true,
    },
    {
      key: 'paid_to',
      label: 'Paid to',
      description:
        'Points FROM an expense TO the company it was paid to — answers "how much have we spent with X?". Only when the ' +
        'expense names that vendor. (Deterministic guard: the expense must carry a company attr matching the company ' +
        'node.)',
      src_kinds: ['expense'],
      dst_kinds: ['company'],
      directed: true,
      scope_attr: 'company',
    },
  ],
  source_types: [
    {
      key: 'todo_update',
      label: 'Quick update',
      description:
        'A few words the person typed to update one thing: an action they just took ("sent the invoice"), a new action ' +
        'to remember ("call mum"), a small spend ("£12 coffee"), or a time that moved ("Thursday now 4pm"). Usually ' +
        'under a dozen words and about ONE item.',
      extraction_guidance:
        'This is the highest-frequency source in the folder and the shortest. A few words IS the whole document — ' +
        'relevant, complete, and extractable. Do not wait for context, do not ask what it refers to, do not invent ' +
        'surrounding detail, and never return empty because it is short.\n\n' +
        'ONE update is ONE item. Do not fan a quick update into several nodes.\n\n' +
        'Read it against THE LIFECYCLE + RESTATEMENT RULES first, because most quick updates are CLOSES rather than ' +
        'creations. Past tense usually closes something: "sent the invoice" is the task "send the invoice" with status ' +
        'done — TITLE IT AS THE TASK ("send the invoice") so it matches the open one by text similarity, and put the ' +
        'completion in the body. Imperative or future usually creates: "call mum" is a new open task owned by the ' +
        'author (their own note satisfies the owner test). Flag closes GREEN.\n\n' +
        'The confirmation rule still holds even here: "£12 coffee" is a spent amount and an expense; "Thursday now ' +
        '4pm" moves a confirmed event; but "should call the dentist" is still an unowned want unless the author wrote ' +
        'it as their own to-do.',
      group_floor: ['commitments'],
      // Automatic ingest: a quick update the person typed themselves is as
      // trusted as a source gets — there is no author to doubt and nothing to
      // review. commit_unit lets the triage decision table return commit_doc
      // (triage-policy.ts:288) so it integrates on ingest instead of queuing.
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['task', 'calendar_event', 'expense', 'idea'],
      triage_guidance:
        'A quick update is the person talking to their own folder — legitimate by construction, and never stale (it ' +
        'describes a thing that just happened). Shortness is NOT a legitimacy signal here: a three-word update is the ' +
        'expected shape of this type, not a degraded document. Ask nothing; commit it.',
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between colleagues.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from personal chat, and note that THE CONFIRMATION RULE and the conversational settledness ' +
          'test are the SAME test here: a time both sides land on is a calendar event, a time one side floats is not; an ' +
          'action someone accepts ("on it", "will do") is a task, an action nobody claims is an idea; an amount someone ' +
          'reports having spent is an expense, an amount someone estimates is not. Also capture: reports that an action ' +
          'is DONE ("sent it", "paid that") — per THE LIFECYCLE RULE these close the existing task rather than opening a ' +
          'new one, so set conflicts_with to the open task and flag green, not red. And capture working facts about ' +
          'people that surface in passing (role, company, handle) — but never evaluative or personal observations about ' +
          'them.',
      ),
      source_kinds: ['slack'],
      group_floor: ['commitments', 'ideas'],
      // Automatic ingest (see todo_update). This DEPARTS from the spec's
      // general rule that records of discussion are never commit units: in a
      // personal folder the cost of a wrong item is one bad to-do the person
      // deletes, not a corrupted team canon — and a folder that makes you
      // curate your own chat is a folder you stop feeding. authority_kinds
      // still carves out anything a thread cannot speak for.
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['task', 'calendar_event', 'expense', 'idea', 'contact', 'company', 'meeting'],
    },
    {
      key: 'email_thread',
      label: 'Email thread',
      description: 'An email or email chain — with colleagues, clients, vendors, or services.',
      extraction_guidance:
        'Email is where commitments get made and confirmed, so apply THE CONFIRMATION RULE at the thread level, not the ' +
        'message level: read the WHOLE chain before emitting. A time proposed in message 1 and accepted in message 4 is ' +
        'a calendar_event; a time proposed and never answered is not, no matter how definite message 1 sounded. The LAST ' +
        'word in the chain wins.\n\n' +
        'Capture especially: confirmations ("that works, booked"), acceptances ("I\'ll have it Friday"), receipts and ' +
        'order confirmations (→ expense, amount verbatim), and the working facts in signatures (role, company, phone) — ' +
        'signatures are a reliable contact source. Automated marketing email is not canon: a promotional blast yields ' +
        'nothing, an order confirmation yields an expense.',
      group_floor: ['commitments', 'money'],
      // Automatic ingest (see todo_update).
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['task', 'calendar_event', 'expense', 'contact', 'company', 'idea'],
      triage_guidance:
        'A thread is a record of an exchange and its early messages are routinely superseded by its later ones — but ' +
        'that is an EXTRACTION problem (read the whole chain, the last word wins), not a reason to make the person ' +
        'curate their own mail. Legitimacy is the only real question: a genuine thread commits.',
    },
    {
      key: 'meeting_transcript',
      label: 'Meeting transcript',
      description: 'A recording transcript or live notes from a meeting that already happened.',
      extraction_guidance:
        'Emit the meeting node FIRST (who, what was discussed, what was settled), then the things that came OUT of it as ' +
        'SEPARATE nodes: one task per action item someone accepted, one calendar_event per follow-up actually booked, ' +
        'one contact per person whose working facts were stated. A meeting that produced three action items is ONE ' +
        'meeting node and THREE tasks — never one node containing a list.\n\n' +
        'Transcripts are full of thinking out loud. THE CONFIRMATION RULE separates it: "we should do X" discussed and ' +
        'left is an idea; "I\'ll do X by Friday" accepted is a task. Attribute owners correctly — the person who ' +
        'ACCEPTED the action owns it, not the person who asked for it.',
      source_kinds: ['transcript'],
      group_floor: ['records', 'commitments'],
      // Automatic ingest (see todo_update).
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['meeting', 'task', 'idea', 'calendar_event', 'contact', 'company'],
      triage_guidance:
        'A transcript records what was SAID, which is not the same as what is true — people misremember and overstate in ' +
        'meetings. It is authoritative for the meeting record and the commitments made in it, and for nothing else; ' +
        'authority_kinds carves out the rest. A real transcript commits without review.',
    },
    {
      key: 'receipt_or_invoice',
      label: 'Receipt / invoice',
      description: 'A receipt, invoice, order confirmation, or statement — proof that money was actually spent.',
      extraction_guidance:
        'This is the cleanest expense source: the amount is stated and the spend is real. Carry the amount VERBATIM with ' +
        'its currency symbol exactly as printed — never convert, never round, never normalize. Set spent_on from the ' +
        'document date and company from the vendor. Pick the category from what was actually bought, not from the ' +
        'vendor\'s name.\n\n' +
        'ONE expense per line item that matters, not one per receipt — a hotel folio with a room charge and a dinner ' +
        'charge is two expenses if the source itemizes them. Do NOT extract the vendor\'s marketing copy, terms, or ' +
        'boilerplate.',
      group_floor: ['money'],
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['expense', 'company'],
      triage_guidance:
        'A receipt is a record of a real transaction — it is never "out of date" and it is authoritative for the expense ' +
        'it documents. Suspicious when it is a quote, an estimate, or a pro-forma rather than proof of payment: those ' +
        'are not expenses at all.',
    },
    {
      key: 'personal_note',
      label: 'Note to self',
      description: 'A note the person wrote for themselves: a brain dump, a running list, a captured thought.',
      extraction_guidance:
        'A note to self is the one source where the author owns everything in it: an action they wrote down IS accepted ' +
        '(they are the owner), so "call the accountant" in a personal list is a task, not an idea — THE CONFIRMATION ' +
        'RULE\'s owner test is satisfied by authorship. Set owner to the author.\n\n' +
        'Fan running lists into ONE node per item — a note with eight bullets is eight nodes, never one. Times and ' +
        'amounts still need the confirmation rule: "dentist Tuesday 3pm" is an event; "should book the dentist" is a ' +
        'task with no date.',
      source_kinds: ['interaction'],
      group_floor: ['commitments', 'ideas'],
      // Automatic ingest (see todo_update): the person's own note about their
      // own work — there is no author to doubt.
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['task', 'idea', 'calendar_event', 'document', 'expense'],
      triage_guidance:
        'A note to self is legitimate by construction and never stale — it records what the author thought at the time. ' +
        'Ask nothing; commit it.',
    },
    {
      key: 'reference_document',
      label: 'Reference document',
      description: 'A policy, guide, spec, contract, or other material kept to refer back to.',
      extraction_guidance:
        'Keep the document as a document node — do not shred reference material into claims. The exception is a ' +
        'commitment it contains: a contract with a renewal date yields a calendar_event, an invoice schedule yields ' +
        'expenses. Set url when the source links the artifact. Take the passage that matters rather than the whole file ' +
        'when the document is long.',
      group_floor: ['records'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['document', 'company', 'calendar_event', 'expense'],
      triage_guidance:
        'Reference material goes stale silently — anchor currency on version markers, dates, and whether a newer document ' +
        'in the graph supersedes it. Authoritative for its own content, not for anything it mentions in passing.',
    },
  ],
  seed_questions: [
    'What is on my to-do list right now?',
    'What did I commit to in my last meeting, and to whom?',
    'What is on my calendar this week?',
    'How much did I spend on software last month?',
    'Which expenses have I not submitted yet?',
    'Who do I know at this company, and what is their role?',
    'What ideas have I had that I never acted on?',
    'What did we actually settle in the meeting about this?',
    'What is overdue?',
  ],
};
