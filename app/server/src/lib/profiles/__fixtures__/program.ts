import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance, interviewGuidance } from '../source-types.js';

/**
 * The `program` built-in profile. A complete operating model for a program
 * manager running ONE program composed of MANY projects. Four layers:
 *
 *   STRUCTURE   project (definition | objective | plan) · stakeholder
 *   DIRECTION   goal · metric              — program-wide or project-scoped
 *   EXECUTION   milestone · workstream · risk
 *   JUDGMENT    decision · commitment · constraint · scope_boundary · principle
 *
 * Scoping rule: nodes carry a `project` attr when project-specific and omit
 * it when program-wide. Execution kinds (milestone, workstream) usually
 * belong to a project; program-level milestones omit the attr.
 *
 * Adaptability: the program's shape is data, not schema. A startup program
 * (sales, marketing, discovery, product projects), a product-development
 * program (one project per product), an integrations program, or a
 * marketing-initiatives program all fit — the `project.type` attr carries the
 * flavor and everything else is uniform.
 */
export const programProfile: ContextProfile = {
  id: 'program',
  shape: 'items',
  name: 'Program',
  routing_hint:
    'Execution across projects/workstreams: what was planned vs what has been delivered, ' +
    'milestones and their status, the risk/issue/dependency register, cadence and ' +
    'stakeholders, and program-level decisions. SHARED ZONE — delivery and execution status ' +
    'is shared with product: route here ALONGSIDE product whenever a document tracks ' +
    'plan-vs-actual, progress, or what has shipped (a plan or status/progress doc belongs ' +
    'here even when it is also about the product).',
  description:
    'A program manager running one program composed of multiple projects. The context ' +
    'is the program: each component project (its definition, objective, plan, stage, ' +
    'health), the stakeholders and the cadence they expect, the direction (goals and ' +
    'metrics — program-wide or per project), the execution state (milestones and their ' +
    'status, workstreams and their health, the risk/issue/dependency register), and the ' +
    'judgment layer (decisions, commitments, constraints, scope boundaries, operating ' +
    'principles). The work product is weekly program reviews, status reports, exec ' +
    'updates, steering decks, project plans, and charters.\n\n' +
    'The program can be of ANY type: a startup operating program (sales, marketing, ' +
    'discovery, and product projects side by side), a product-development program (one ' +
    'project per product), an integrations program (one project per integration), a ' +
    'marketing-initiatives program, and so on. The project.type attr carries the flavor; ' +
    'the structure is the same for all of them.\n\n' +
    'SCOPING — the workspace is ONE program with MULTIPLE projects. Set the `project` ' +
    "attr on every node that is specific to one project — ALWAYS the project's short " +
    'name, lowercase, hyphenated, used identically on every node (e.g. ' +
    '"salesforce-integration", never "Salesforce" on one node and "sf-integration" on ' +
    'another); omit it only when the claim is genuinely program-wide. The PROGRAM itself is ' +
    'described by program-wide nodes: its goals, principles, scope boundaries, and ' +
    'program-level milestones. When one source discusses several projects — a weekly ' +
    'program review almost always does — extract per-project nodes separately.\n\n' +
    'WEEKLY PROGRAM REVIEWS ARE A FIRST-CLASS SOURCE: a review yields status updates ' +
    '(project health, milestone status, workstream health, risk states), new risks and ' +
    'dependencies, decisions made in the room, and commitments given. Status CHANGES are ' +
    'canon updates to existing nodes — a reversal (on_track → at_risk/blocked, a ' +
    'milestone date slip, a closed risk reopening) flags red.\n\n' +
    'KIND DECISION TREE — test in this order, first match wins:\n' +
    '1. Defines a component project: what it is, its objective, or its plan → project\n' +
    '2. A named person/group with a role in the program (sponsor, decision-maker, contributor, external party) → stakeholder\n' +
    '3. A measured quantity with a definition or values → metric\n' +
    '4. A target or OKR being chased → goal\n' +
    '5. A dated deliverable, phase gate, launch, or go-live → milestone\n' +
    '6. An ongoing named component of a project (or the program) with an owner and health → workstream\n' +
    '7. A tracked risk, issue, or cross-project/external dependency — anything with an owner, a severity, or a status on the register → risk\n' +
    '8. A promise to a named party with a date or condition → commitment\n' +
    "9. An imposed, immovable \"can't\" from outside the program — budget caps, resourcing limits, legal, technical limits, a hard external date — with NO owner working it → constraint\n" +
    '10. A chosen "won\'t" — explicitly out of scope for a project or the program → scope_boundary\n' +
    '11. A dated one-off choice → decision\n' +
    '12. A durable rule of how the program runs (cadence, escalation, quality bar) or a canonical definition → principle\n\n' +
    'DO NOT EXTRACT (not canon, even in relevant documents): meeting logistics and ' +
    'attendance; ticket-level task minutiae below the milestone/workstream grain; open ' +
    'options still being weighed in discussion (a risk being TRACKED is canon — an idea ' +
    'being floated is not); personal performance commentary about individuals; numbers ' +
    'inside a UI mockup, screenshot, or demo dataset.',
  kinds: [
    {
      key: 'project',
      label: 'Project',
      label_plural: 'Projects',
      color: 1,
      consequence: 'medium',
      description:
        'A facet of one component project of the program. One node per facet. Title: ' +
        'project name + facet (e.g. "Salesforce integration — objective").\n\n' +
        'NOT a project node: a dated deliverable inside it (→ milestone); an ongoing ' +
        'component inside it (→ workstream); a target for it (→ goal); who runs it ' +
        '(→ stakeholder, and set the owner attr here).\n\n' +
        'project.subkind — choose ONE:\n' +
        '- definition: what the project is, what it delivers, and why it is in the program.\n' +
        '- objective: what success looks like — the acceptance bar or outcome it must reach.\n' +
        '- plan: the approach, phasing, and key dates.\n' +
        '- status: a reported health/stage update — the current state and what changed. Reviews yield ONE status node per project covered; never put a health update on plan.\n\n' +
        'Set the type attr to the project flavor (sales, marketing, discovery, product, ' +
        'integration, ops, …) as stated. Stage and health changes are reversals: flag red.',
      subkinds: [
        { key: 'definition', label: 'Definition', description: 'What the project is, what it delivers, why it is in the program.' },
        { key: 'objective', label: 'Objective', description: 'What success looks like — the bar or outcome it must reach.' },
        { key: 'plan', label: 'Plan', description: 'Approach, phasing, and key dates.' },
        { key: 'status', label: 'Status', description: 'A reported health/stage update: current state and what changed.' },
      ],
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'The project short name — lowercase, hyphenated, identical on every node. Required.' },
        { key: 'type', label: 'Type', type: 'string', description: 'The project flavor: sales, marketing, discovery, product, integration, ops, …' },
        { key: 'owner', label: 'Owner', type: 'string', description: 'Who runs the project day to day.' },
        { key: 'stage', label: 'Stage', type: 'enum', values: ['proposed', 'active', 'on_hold', 'done', 'cancelled'] },
        { key: 'health', label: 'Health', type: 'enum', values: ['on_track', 'at_risk', 'blocked'], description: 'Current health, as of the latest review.' },
      ],
      buckets: [
        { key: 'active', label: 'Active', match: 'stage' },
        { key: 'proposed', label: 'Proposed', match: 'stage' },
        { key: 'on_hold', label: 'On hold', match: 'stage' },
        { key: 'done', label: 'Done', match: 'stage' },
      ],
    },
    {
      key: 'stakeholder',
      label: 'Stakeholder',
      label_plural: 'Stakeholders',
      color: 6,
      consequence: 'low',
      description:
        'A named person or group with a durable role in the program: who they are, what ' +
        'they care about, and the cadence/forum they expect to be engaged in. Title: name ' +
        '+ role (e.g. "Dana — exec sponsor").\n\n' +
        'NOT a stakeholder: a one-off meeting attendee; a promise made to them ' +
        '(→ commitment, with to_whom set); personal performance commentary.\n\n' +
        'stakeholder.subkind — choose ONE:\n' +
        '- sponsor: accountable executive; owns the why and the budget.\n' +
        '- decision_maker: approves scope, schedule, or spend.\n' +
        '- contributor: a lead delivering part of the program.\n' +
        '- external: a customer, partner, or vendor contact the program answers to.',
      subkinds: [
        { key: 'sponsor', label: 'Sponsor', description: 'Accountable executive — owns the why and the budget.' },
        { key: 'decision_maker', label: 'Decision maker', description: 'Approves scope, schedule, or spend.' },
        { key: 'contributor', label: 'Contributor', description: 'A lead delivering part of the program.' },
        { key: 'external', label: 'External', description: 'Customer, partner, or vendor contact.' },
      ],
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'Omit when the stakeholder spans the program.' },
        { key: 'role', label: 'Role', type: 'string', description: 'Their title or function.' },
        { key: 'cadence', label: 'Cadence', type: 'string', description: 'How and how often they expect updates (e.g. "weekly steering", "monthly email").' },
      ],
    },
    {
      key: 'goal',
      label: 'Goal',
      label_plural: 'Goals',
      color: 2,
      consequence: 'high',
      anchor: { match: 'subkind', values: ['north_star'] },
      description:
        'A target, OKR, north star, or priority being chased — program-wide or for one ' +
        'project. Title (≤10 words): noun phrase including the number and target if ' +
        'present (e.g. "All 5 integrations live by Q3").\n\n' +
        'NOT a goal: the metric itself and its definition (→ metric); a dated deliverable ' +
        'on the way there (→ milestone); a date or outcome promised/reconfirmed TO a named ' +
        'party such as the steering committee or a customer (→ commitment — the named ' +
        'counterparty wins).\n\n' +
        'goal.subkind — choose ONE: north_star, priority, supporting.',
      subkinds: [
        { key: 'north_star', label: 'North star', description: 'THE defining target of the program.' },
        { key: 'priority', label: 'Priority', description: 'A first-order target.' },
        { key: 'supporting', label: 'Supporting', description: 'A secondary target.' },
      ],
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'Omit when program-wide.' },
        { key: 'period', label: 'Period', type: 'string', description: 'e.g. "Q3 2026".' },
        { key: 'metric', label: 'Metric', type: 'string', description: 'The metric this goal moves, when named.' },
      ],
      buckets: [
        { key: 'north_star', label: 'North star', match: 'subkind' },
        { key: 'priority', label: 'Priority', match: 'subkind' },
        { key: 'supporting', label: 'Supporting', match: 'subkind' },
      ],
    },
    {
      key: 'metric',
      label: 'Metric',
      label_plural: 'Metrics',
      color: 3,
      consequence: 'medium',
      description:
        'A measured quantity with a canonical definition and, when stated, current and ' +
        'target values: "pipeline coverage = open pipeline / quarterly target, currently ' +
        '2.1x". Title: the metric name. Body: the DEFINITION first, then values.\n\n' +
        'NOT a metric: a period-bound target without a measurement definition (→ goal, ' +
        'referencing the metric by name); a milestone\'s done/not-done state (→ milestone).\n\n' +
        'metric.subkind — choose ONE: north_star, input, guardrail, health.',
      subkinds: [
        { key: 'north_star', label: 'North star', description: 'The defining program metric.' },
        { key: 'input', label: 'Input', description: 'A driver metric upstream of the north star.' },
        { key: 'guardrail', label: 'Guardrail', description: 'A must-not-degrade metric (e.g. budget burn).' },
        { key: 'health', label: 'Health', description: 'Operational/quality health metric.' },
      ],
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'Omit when program-wide.' },
        { key: 'current', label: 'Current', type: 'string' },
        { key: 'target', label: 'Target', type: 'string' },
      ],
    },
    {
      key: 'milestone',
      label: 'Milestone',
      label_plural: 'Milestones',
      color: 4,
      consequence: 'medium',
      description:
        'A dated deliverable, phase gate, launch, or go-live — for one project or the ' +
        'program. The program timeline IS this kind bucketed by status. Title: the ' +
        'deliverable in ≤8 words (e.g. "Salesforce integration GA").\n\n' +
        'NOT a milestone: an ongoing component with no end date (→ workstream); the ' +
        'target it serves (→ goal); a promise of the date to a named party ' +
        '(→ commitment — extract BOTH when a milestone date was promised externally).\n\n' +
        'Set the project attr unless program-level. A due-date change or a status ' +
        'reversal (on_track → at_risk, done → reopened) flags red.',
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'Omit only for program-level milestones.' },
        { key: 'workstream', label: 'Workstream', type: 'string', description: 'The workstream delivering it, when stated.' },
        { key: 'due', label: 'Due', type: 'date' },
        { key: 'owner', label: 'Owner', type: 'string' },
        { key: 'status', label: 'Status', type: 'enum', values: ['planned', 'on_track', 'at_risk', 'done', 'missed'] },
      ],
      buckets: [
        { key: 'on_track', label: 'On track', match: 'status' },
        { key: 'at_risk', label: 'At risk', match: 'status' },
        { key: 'planned', label: 'Planned', match: 'status' },
        { key: 'done', label: 'Done', match: 'status' },
      ],
    },
    {
      key: 'workstream',
      label: 'Workstream',
      label_plural: 'Workstreams',
      color: 4,
      consequence: 'medium',
      description:
        "An ongoing named component of a project (or the program) with an owner and a " +
        'health: the grain at which weekly progress is reported below the project level ' +
        '(e.g. "data migration", "enablement", "vendor onboarding"). Title: the ' +
        'workstream name.\n\n' +
        'NOT a workstream: a dated deliverable (→ milestone); ticket-level tasks below ' +
        'this grain (not canon).\n\n' +
        'Set the project attr unless it spans the program. Health changes are reversals: ' +
        'flag red.',
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'Omit when the workstream spans the program.' },
        { key: 'owner', label: 'Owner', type: 'string' },
        { key: 'health', label: 'Health', type: 'enum', values: ['on_track', 'at_risk', 'blocked'] },
      ],
      buckets: [
        { key: 'on_track', label: 'On track', match: 'health' },
        { key: 'at_risk', label: 'At risk', match: 'health' },
        { key: 'blocked', label: 'Blocked', match: 'health' },
      ],
    },
    {
      key: 'risk',
      label: 'Risk',
      label_plural: 'Risks & dependencies',
      color: 5,
      consequence: 'medium',
      description:
        'A TRACKED risk, issue, or dependency on the program register — with its ' +
        'severity, status, owner, and mitigation when stated. In a program the risk ' +
        'register IS canon: extract what the program is formally tracking. An idea ' +
        'floated in discussion and not adopted onto the register is NOT canon. Title: ' +
        'the risk in ≤10 words.\n\n' +
        'NOT a risk: an imposed hard limit (→ constraint); a chosen not-doing ' +
        '(→ scope_boundary).\n\n' +
        'risk.subkind — choose ONE:\n' +
        '- risk: something that MAY happen and would hurt the program.\n' +
        '- issue: something that HAS happened and is being worked.\n' +
        '- dependency: project A needs something from project B or an external party by ' +
        'a date — the cross-project coupling that can slip the program. Set depends_on. ' +
        'PRECONDITION GATES are dependencies too: "X is required before Y can happen" ' +
        '("DPA signed before production data", "their sign-off before each stage ' +
        'promotion") — one dependency node per gate, even when buried in a legal or ' +
        'process section. Set depends_on to the blocking item.\n\n' +
        'risk/dependency vs constraint: a coupling or threat that is TRACKED — it has an ' +
        'owner, a severity, a status, or a mitigation — is a risk. An immovable limit ' +
        'imposed from outside that nobody is "working" (a regulatory date, a budget cap) ' +
        'is a constraint.\n\n' +
        'Status changes (open → realized, closed → reopened) are reversals: flag red.',
      subkinds: [
        { key: 'risk', label: 'Risk', description: 'May happen, would hurt the program.' },
        { key: 'issue', label: 'Issue', description: 'Has happened, being worked.' },
        { key: 'dependency', label: 'Dependency', description: 'A needs B (another project or external party) by a date.' },
      ],
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'The project at risk; omit when program-wide.' },
        { key: 'severity', label: 'Severity', type: 'enum', values: ['low', 'medium', 'high', 'critical'] },
        { key: 'status', label: 'Status', type: 'enum', values: ['open', 'mitigating', 'closed', 'realized'] },
        { key: 'owner', label: 'Owner', type: 'string', description: 'Who owns the mitigation.' },
        { key: 'mitigation', label: 'Mitigation', type: 'string', description: 'The agreed mitigation, when stated.' },
        { key: 'depends_on', label: 'Depends on', type: 'string', description: 'For dependencies: the project or external party depended on.' },
      ],
      buckets: [
        { key: 'open', label: 'Open', match: 'status' },
        { key: 'mitigating', label: 'Mitigating', match: 'status' },
        { key: 'closed', label: 'Closed', match: 'status' },
      ],
    },
    {
      key: 'decision',
      label: 'Decision',
      label_plural: 'Decisions',
      color: 5,
      consequence: 'high',
      description:
        'A dated one-off program or project choice that is not better captured by a more ' +
        'specific kind (see the decision tree — milestones, scope boundaries, ' +
        'commitments, and principles are NOT wrapped in decisions). Title (≤12 words): ' +
        'imperative verb + object + key constraint.\n\n' +
        'decision.category — choose ONE: scope, prioritization, resourcing, schedule, ' +
        'budget, process, escalation, sunset.\n' +
        'Fill `impacts` with the names of projects/milestones/goals/commitments the ' +
        'source says this decision affects.',
      categories: [
        { key: 'scope', label: 'Scope' },
        { key: 'prioritization', label: 'Prioritization' },
        { key: 'resourcing', label: 'Resourcing' },
        { key: 'schedule', label: 'Schedule' },
        { key: 'budget', label: 'Budget' },
        { key: 'process', label: 'Process' },
        { key: 'escalation', label: 'Escalation' },
        { key: 'sunset', label: 'Sunset' },
      ],
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'Omit when program-wide.' },
        { key: 'decided_on', label: 'Decided on', type: 'date' },
        { key: 'decided_by', label: 'Decided by', type: 'string' },
        { key: 'impacts', label: 'Impacts', type: 'string', description: 'Names of projects/milestones/goals/commitments this decision affects, when stated.' },
      ],
    },
    {
      key: 'commitment',
      label: 'Commitment',
      label_plural: 'Commitments',
      color: 6,
      consequence: 'high',
      description:
        'A promise made to a named party with a date or condition: a customer, partner, ' +
        'the steering committee, leadership, or the board. Title: what was promised to ' +
        'whom in ≤10 words.\n\n' +
        'NOT a commitment: an internal plan with no named counterparty (→ milestone or ' +
        'goal); a restriction imposed ON us (→ constraint).\n\n' +
        '"Promised/told/agreed with someone" wins over decision — extract here.',
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'Omit when program-wide.' },
        { key: 'to_whom', label: 'To whom', type: 'string', description: 'The counterparty. Required when stated.' },
        { key: 'due', label: 'Due', type: 'date', description: 'The promised date, when stated.' },
      ],
    },
    {
      key: 'constraint',
      label: 'Constraint',
      label_plural: 'Constraints',
      color: 3,
      consequence: 'medium',
      description:
        'An imposed "can\'t" — a limit from external reality, not a choice: budget, ' +
        'resourcing, technical, legal/compliance, or timeline. Title: the limit in ' +
        '≤10 words.\n\n' +
        'NOT a constraint: a coupling or threat being TRACKED with an owner, severity, ' +
        'status, or mitigation (→ risk — the register owns it); a chosen "won\'t" ' +
        '(→ scope_boundary); "deferred to later" / "stays out of phase 1" ' +
        '(→ scope_boundary — a chosen sequencing boundary).\n\n' +
        'constraint.subkind — choose ONE: budget, resourcing, technical, legal_compliance, timeline.',
      subkinds: [
        { key: 'budget', label: 'Budget' },
        { key: 'resourcing', label: 'Resourcing' },
        { key: 'technical', label: 'Technical' },
        { key: 'legal_compliance', label: 'Legal / compliance' },
        { key: 'timeline', label: 'Timeline', description: 'A hard external date that binds us.' },
      ],
      attrs: [{ key: 'project', label: 'Project', type: 'string', description: 'Omit when program-wide.' }],
    },
    {
      key: 'scope_boundary',
      label: 'Scope boundary',
      label_plural: 'Scope boundaries',
      color: 2,
      consequence: 'medium',
      description:
        'An explicit chosen not-doing for a project or the program: "We are NOT doing ' +
        'X." State the boundary plainly. Title: "Not doing: <X>". Fan EACH bullet of a ' +
        '"Non-goals" / "Out of scope" list into its own node. "Deferred to phase 2" / ' +
        '"stays out for now" is a chosen sequencing boundary — it belongs here, NOT in ' +
        'constraint.\n\n' +
        'NOT a scope boundary: an imposed limit (→ constraint); a project being ' +
        'cancelled after starting (→ project with stage cancelled, red flag).',
      attrs: [{ key: 'project', label: 'Project', type: 'string', description: 'Omit when program-wide.' }],
    },
    {
      key: 'principle',
      label: 'Principle',
      label_plural: 'Principles',
      color: 1,
      consequence: 'medium',
      description:
        'A durable rule of how the program runs, or a canonical definition. Timeless ' +
        'guidance, not a dated choice. Title (≤10 words): the rule as an imperative or ' +
        'definition (e.g. "Two consecutive red weeks escalate to sponsor"). Cadence and ' +
        'ritual changes settled informally ("risk review moves to Tuesdays") ARE ' +
        'operating rules — extract them; the new rule supersedes the old slot.\n\n' +
        'principle.subkind — choose ONE:\n' +
        '- operating_rule: cadence, rituals, and reporting rules ("status due Thursday EOD", "reviews are written, not slides").\n' +
        '- escalation_rule: when and to whom things escalate ("two consecutive red weeks → sponsor").\n' +
        '- quality_bar: a bar deliverables must clear.\n' +
        '- definition: a canonical term or status definition ("at_risk means >1 week slip projected").\n\n' +
        'Fan numbered/bulleted rule lists into one node per item.',
      subkinds: [
        { key: 'operating_rule', label: 'Operating rule' },
        { key: 'escalation_rule', label: 'Escalation rule' },
        { key: 'quality_bar', label: 'Quality bar' },
        { key: 'definition', label: 'Definition' },
      ],
      attrs: [{ key: 'project', label: 'Project', type: 'string', description: 'Omit when program-wide (most principles are).' }],
    },
  ],
  feedback_dimensions: [
    { key: 'decisions', label: 'Decisions', description: 'alignment with what has been decided, including each decision’s stated impacts' },
    { key: 'goals_priorities', label: 'Goals & priorities', description: 'does this lead with / serve the current program and project direction' },
    {
      key: 'delivery_truth',
      label: 'Delivery truth',
      description: 'claims about progress match the record: project stage and health, milestone status and dates, workstream health',
    },
    {
      key: 'risk_awareness',
      label: 'Risk awareness',
      description: 'does not omit or contradict open risks, issues, or dependencies relevant to the claims being made',
    },
    { key: 'commitments', label: 'Commitments', description: 'does not promise anything not committed, and does not contradict committed dates or terms' },
    {
      key: 'stakeholder_fit',
      label: 'Stakeholder fit',
      description: 'addressed to the right stakeholders at the agreed cadence, and names the correct owners and decision-makers',
    },
    { key: 'scope_and_constraints', label: 'Scope & constraints', description: 'respects explicit scope boundaries and imposed constraints' },
    { key: 'context_recency', label: 'Context recency', description: 'recent decisions, status changes, or risk updates the work should reflect' },
  ],
  review_kinds: [
    'program_review',
    'status_report',
    'exec_update',
    'steering_deck',
    'project_plan',
    'program_charter',
    'roadmap_update',
    'stakeholder_comm',
    'risk_register',
    'kickoff_doc',
    'other',
  ],
  query_scopes: [
    { key: 'projects', label: 'Projects', kind_keys: ['project'] },
    { key: 'stakeholders', label: 'Stakeholders', kind_keys: ['stakeholder'] },
    { key: 'direction', label: 'Goals & metrics', kind_keys: ['goal', 'metric'] },
    { key: 'progress', label: 'Milestones & workstreams', kind_keys: ['milestone', 'workstream'] },
    { key: 'risks', label: 'Risks & dependencies', kind_keys: ['risk'] },
    { key: 'decisions', label: 'Decisions', kind_keys: ['decision'] },
    { key: 'commitments', label: 'Commitments', kind_keys: ['commitment'] },
    { key: 'guardrails', label: 'Scope, constraints & principles', kind_keys: ['constraint', 'scope_boundary', 'principle'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  extraction_groups: [
    {
      key: 'structure',
      label: 'Projects & stakeholders',
      kind_keys: ['project', 'stakeholder'],
      description:
        'Project definitions, objectives, plans, and STATUS — any document reporting per-project health or stage (every weekly review does) is structure ' +
        'content: route this group. Also named stakeholders with their roles and cadence.',
    },
    {
      key: 'direction',
      label: 'Goals & metrics',
      kind_keys: ['goal', 'metric'],
      description:
        'Targets, OKRs, north stars, and metric definitions with current/target values — program-wide or per project. A measured value reported ' +
        'against a target ANYWHERE in a document (including one line inside a weekly review) is direction content: route this group.',
    },
    {
      key: 'execution',
      label: 'Progress & risks',
      kind_keys: ['milestone', 'workstream', 'risk'],
      description:
        'Milestones with dates and status, workstream health, and the tracked risk/issue/dependency register. Weekly program ' +
        'reviews land here: extract status CHANGES per project and per item — reversals and date slips flag red.',
    },
    {
      key: 'judgment',
      label: 'Decisions & guardrails',
      kind_keys: ['decision', 'commitment', 'constraint', 'scope_boundary', 'principle'],
      description:
        'Dated choices, promises to named parties, imposed constraints, explicit not-doings, and durable operating rules.',
    },
  ],
  flag_semantics: {
    red: 'contradicts or changes a prior decision, commitment, scope boundary, or constraint — or reverses recorded state: project health or stage, milestone status or due date, workstream health, risk status',
    yellow: 'hedged or low-conviction, missing an owner or date where one is expected, or conflicts with the recorded plan without an explicit change',
    green: 'consistent with the program canon and, where it reports progress, matching the recorded state',
  },
  // Typed node↔node relations. Each edge kind answers a real retrieval
  // question ("what could slip this milestone?", "who owns this risk?").
  edge_kinds: [
    {
      key: 'supports',
      label: 'Supports',
      description:
        'The source contributes to achieving the destination goal — supporting goal → north star, metric → the goal it measures, milestone → the goal it advances.',
      src_kinds: ['goal', 'metric', 'milestone'],
      dst_kinds: ['goal'],
      directed: true,
    },
    {
      key: 'belongs_to',
      label: 'Belongs to',
      description:
        'Project scoping made explicit: a node that lives under one project of the program (its milestones, workstreams, goals, metrics, risks, decisions, stakeholders). ' +
        'Points FROM the scoped node TO its project. Draw it confidently for EVERY node whose project attr or body names the project — milestones, risks, constraints, commitments, scope boundaries, stakeholders scoped to it. ' +
        'Program-wide nodes (no project attr — budget caps, operating rules, program goals) belong to NO project; never infer membership from co-occurrence. ' +
        "ANCHOR: a project appears as several nodes, one per facet (definition, objective, plan, status) — attach to the project's subkind='definition' node; fall back to another facet only when no definition node exists.",
      src_kinds: [
        'milestone',
        'workstream',
        'goal',
        'metric',
        'risk',
        'decision',
        'stakeholder',
        'commitment',
        'constraint',
        'scope_boundary',
        'principle',
      ],
      dst_kinds: ['project'],
      directed: true,
      scope_attr: 'project',
    },
    {
      key: 'depends_on',
      label: 'Depends on',
      description:
        'The cross-project coupling that can slip the program: points FROM the dependent project, milestone, or workstream TO the one that must land first. ' +
        'The dependent is always the LATER one — its due date is on or after the prerequisite\'s. ' +
        "ANCHOR: when either end is a project, attach to its subkind='definition' node.",
      src_kinds: ['project', 'milestone', 'workstream'],
      dst_kinds: ['project', 'milestone', 'workstream'],
      directed: true,
      order_attr: 'due',
    },
    {
      key: 'owns',
      label: 'Owns',
      description:
        'Accountability: points FROM the stakeholder TO the project, workstream, milestone, or risk mitigation they own — ONLY when the source names them as owner/lead of that specific item. ' +
        'INTERNAL stakeholders only (sponsor, decision_maker, contributor): external stakeholders are counterparties and never own our work — do not draw owns from a subkind=external stakeholder. ' +
        "ANCHOR: when the destination is a project, attach to its subkind='definition' node.",
      src_kinds: ['stakeholder'],
      dst_kinds: ['project', 'workstream', 'milestone', 'risk'],
      directed: true,
    },
    {
      key: 'threatens',
      label: 'Threatens',
      description:
        'A risk, issue, or dependency that endangers a specific milestone, project, goal, or commitment — ONLY when the risk\'s own body states or implies that impact. ' +
        'Never draw threatens to a destination the risk\'s body explicitly says is NOT affected (e.g. "may slide, which moves GTM but NOT the alpha dates" never threatens the alpha dates).',
      src_kinds: ['risk'],
      dst_kinds: ['milestone', 'project', 'goal', 'commitment'],
      directed: true,
    },
    {
      key: 'mitigates',
      label: 'Mitigates',
      description: 'A decision or milestone that answers a tracked risk — the response the register points at.',
      src_kinds: ['decision', 'milestone'],
      dst_kinds: ['risk'],
      directed: true,
    },
    {
      key: 'bounds',
      label: 'Bounds',
      description:
        'A scope boundary that delimits a specific project or workstream — only when the boundary itself is scoped to it; program-wide boundaries bound no single project. ' +
        "ANCHOR: when the destination is a project, attach to its subkind='definition' node.",
      src_kinds: ['scope_boundary'],
      dst_kinds: ['project', 'workstream'],
      directed: true,
      scope_attr: 'project',
    },
  ],
  // Source types this profile expects. The router classifies each document;
  // the matched type's extraction_guidance is injected into capture calls.
  source_types: [
    {
      key: 'program_review',
      label: 'Program review',
      description: 'A weekly/periodic program review covering several projects: status, risks, decisions.',
      extraction_guidance:
        'A review is a STATE-SNAPSHOT source. For every project and tracked item it ' +
        'covers, emit a node carrying the CURRENT state as stated (project health, ' +
        'milestone status and due date, workstream health, risk status) — do not try ' +
        'to diff against history yourself; the downstream dedup/supersede pass compares ' +
        'against the graph. When the review ITSELF states a change ("slips from July 1 ' +
        'to July 15", "was on track last week, now at risk"), that is a reversal: flag ' +
        'red and put both old and new state in the body. Also extract decisions made in ' +
        'the review, commitments given, and new register entries. One node per project ' +
        'per state — never one mega-node summarizing the review.',
      // A review's reason to exist is the state snapshot (execution) plus the
      // decisions/commitments it records (judgment).
      group_floor: ['execution', 'judgment'],
      // Triage: the state snapshot IS the value — but only the LATEST
      // snapshot. Currency is the whole question for a review.
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['project', 'stakeholder', 'goal', 'metric', 'milestone', 'workstream', 'risk', 'decision', 'commitment'],
      triage_guidance:
        'A program review is authoritative for current state ONLY if it is the most recent one. A high contradiction rate against the graph means either this review is the newest truth (the graph is behind) or it is an older snapshot — always ask, never guess.',
    },
    {
      key: 'status_report',
      label: 'Status report',
      description: 'A single project\'s status report or update.',
      extraction_guidance:
        'Extract the project\'s reported state changes and any new risks, dependencies, or commitments — scoped to that project.',
      group_floor: ['execution'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['project', 'milestone', 'workstream', 'risk', 'commitment'],
      triage_guidance:
        'Same snapshot semantics as a program review, scoped to one project: authoritative only as the latest report for that project.',
    },
    {
      key: 'plan_or_charter',
      label: 'Plan / charter',
      description: 'A project plan, program charter, kickoff doc, or roadmap.',
      extraction_guidance: '',
      // A charter establishes the project itself (structure) and its
      // milestones/workstreams (execution).
      group_floor: ['structure', 'execution'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['project', 'stakeholder', 'goal', 'metric', 'milestone', 'workstream', 'constraint', 'scope_boundary', 'principle'],
      triage_guidance:
        'Legitimate when adopted (a kickoff/charter the program runs on), not a proposal. A charter for an already-running program may be behind the graph on dates — currency question, not silent commit.',
    },
    {
      key: 'steering_minutes',
      label: 'Steering minutes',
      description: 'Notes or minutes from a steering committee or governance meeting.',
      extraction_guidance:
        'Steering outcomes are the highest-authority canon here: decisions, escalation resolutions, and commitments given to the committee. Extract stated outcomes only; skip the discussion.',
      group_floor: ['judgment'],
      // Minutes record one meeting; their judgment outcomes are high-tier
      // kinds and get individual eyes regardless.
      currency: 'point_in_time',
    },
    {
      key: 'stakeholder_interview',
      label: 'Stakeholder interview',
      description: 'A 1:1 or interview with a sponsor, project lead, or external party about the program.',
      extraction_guidance: interviewGuidance(
        'Capture especially: the stakeholder\'s role and cadence expectations, risks they surface, and commitments made to or by them.',
      ),
      source_kinds: ['transcript'],
      // The stakeholder node itself (structure) and commitments made to or
      // by them (judgment) are why the interview is ingested at all.
      group_floor: ['structure', 'judgment'],
      currency: 'point_in_time',
      authority_kinds: ['stakeholder', 'risk', 'commitment', 'constraint'],
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between program/project people.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from program chat: settled scope/schedule/resourcing calls, milestone date changes both parties accept, newly surfaced risks or dependencies treated as real, health changes ("we\'re blocked on X"), and cadence/ritual changes ("risk review moves to Tuesdays") — operating rules settle in chat constantly. Standup-style snippets yield ONLY settled state changes, never plans-for-today. Status changes settled in chat are still reversals and flag red.',
      ),
      source_kinds: ['slack'],
      group_floor: ['execution', 'judgment'],
      currency: 'point_in_time',
    },
  ],
  seed_questions: [
    'Which projects are in the program, and what is each one’s health?',
    'What milestones are due in the next 30 days, and which are at risk?',
    'What are the open risks and issues, and who owns each mitigation?',
    'Which cross-project dependencies could slip the program?',
    'What did we commit to the steering committee, and by when?',
    'Who are the stakeholders, and what cadence does each expect?',
  ],
};
