import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance, interviewGuidance } from '../source-types.js';

/**
 * The `product` built-in profile, v2. A complete operating model for a
 * product person who may run SEVERAL products at once. Seven layers:
 *
 *   MARKET      competitor
 *   PORTFOLIO   product (definition | value_proposition | pricing | vision)
 *   AUDIENCE    segment (icp | persona | segment)
 *   DIRECTION   goal · metric            — portfolio-wide or product-scoped
 *   DELIVERY    feature · spec · sprint  — always product-scoped
 *   PLATFORM    design · design_rule · architecture — product design (how the
 *               product WORKS: interactions, flows, navigation), design rules
 *               (how the UI is BUILT: visual identity, components, UI rules),
 *               and engineering shape — all at PM altitude. Design PRINCIPLES
 *               (the why-level guidance) live in JUDGMENT as
 *               principle.design_principle.
 *   JUDGMENT    decision · commitment · constraint · scope_boundary · principle
 *   EVIDENCE    research · user_insight  — insights carry segment + study provenance
 *
 * Scoping rule: nodes carry a `product` attr when product-specific and omit
 * it when portfolio-wide. Delivery kinds always require it.
 */
export const productProfile: ContextProfile = {
  id: 'product',
  shape: 'items',
  name: 'Product',
  routing_hint:
    'The product itself: its definition, value proposition, target users/segments, pricing, ' +
    'vision and stage; the roadmap, features, specs and releases; and the product design and ' +
    'technical architecture. SHARED ZONES — also route here, ALONGSIDE the neighbor, when the ' +
    'document covers: value proposition / positioning / competitors (shared with marketing), ' +
    'or what was planned vs delivered and feature/sprint status (shared with program). A ' +
    'product vision or strategy doc belongs here even when it also states go-to-market or ' +
    'delivery.',
  description:
    'A product person (PM / head of product) who may run several products at the same ' +
    'time. The context is the portfolio: each product (its definition, value proposition, ' +
    'pricing, vision, stage), the audience segments served, the direction (goals and ' +
    'metrics — portfolio-wide or per product), the delivery state (features and their ' +
    'roadmap horizons, specs and their approval status, sprints and their health), the ' +
    'platform shape (product design — how the product WORKS for the user: interactions, ' +
    'user flows, navigation/IA; the design rules — how the UI is BUILT: visual identity, ' +
    'design-system components, UI construction rules; and the engineering architecture — ' +
    'system design, APIs, data stores, services, technology stack — all ' +
    'at PM altitude), the ' +
    'judgment layer (decisions, commitments, constraints, scope boundaries, principles), ' +
    'the competitive landscape, and the evidence (research studies and the user insights ' +
    'they produced). The work product is PRDs, specs, roadmap and sprint plans, exec ' +
    'updates, release notes, and customer-facing material.\n\n' +
    'SCOPING — this person may run MULTIPLE products. Set the `product` attr (the ' +
    "product's short name) on every node that is specific to one product; omit it only " +
    'when the claim is genuinely portfolio-wide. Delivery nodes (feature, spec, sprint) ' +
    'always belong to a product. When one source discusses several products, extract ' +
    'per-product nodes separately.\n\n' +
    'KIND DECISION TREE — test in this order, first match wins:\n' +
    '1. About a competitor or the market → competitor\n' +
    '2. Defines a product: what it is, its value prop, pricing, or vision → product\n' +
    '3. Defines who we serve: an ICP, persona, or segment → segment\n' +
    '4. A measured quantity with a definition or values → metric\n' +
    '5. A target or OKR being chased → goal\n' +
    '6. A research study or a discrete interview (its goal, method, who was studied) → research — emit it BEFORE its findings and tag each finding’s study attr\n' +
    '7. Evidence about users from research or data → user_insight\n' +
    '8. A capability being planned, built, or shipped → feature\n' +
    '9. A spec’s existence, approval status, or binding scope lines → spec\n' +
    '10. A sprint/cycle: its goal, contents, dates, or health → sprint\n' +
    '11. How the product WORKS for the user: a settled interaction behavior, a user flow, or the navigation/IA structure → design\n' +
    '12. How the UI is BUILT: a visual-identity rule (typography, color/accent usage, imagery style), a named design-system component or pattern, or a UI construction rule — incl. rules phrased as restrictions or never-dos → design_rule\n' +
    '13. A PM-level engineering fact: the system design/topology, an API surface, a data store, a deployed service, or a technology-stack choice → architecture\n' +
    '14. A promise to a named party with a date or condition → commitment\n' +
    '15. An imposed "can’t" (technical, legal, resourcing, dependency) → constraint\n' +
    '16. A chosen "won’t" — explicitly out of scope → scope_boundary\n' +
    '17. A dated one-off choice → decision\n' +
    '18. A durable always/never rule or canonical definition — incl. design principles, the why-level guidance behind design choices → principle\n\n' +
    'DO NOT EXTRACT (not canon, even in relevant documents): open questions and ' +
    'options still being weighed; risks under discussion; who-owns-what people/org ' +
    'information (except decided_by on decisions — approval RULES like "pricing changes ' +
    'need CFO sign-off" are principle.process_rule); key-account/customer details; ' +
    'implementation logistics and rollout instructions; numbers and sample records that appear INSIDE a UI mockup, screenshot, aria-label, or demo dataset — those specific embedded values are not real targets (the surrounding document is still canon); raw design-token values (hex/oklch codes, pixel sizes), CSS class names, code file paths, and installed-component inventories — capture the design RULE and the named elements (font names, pattern names), never the code that implements them; ML/synthesis eval thresholds, model quality gates, latency/cost/reliability targets, and phase acceptance criteria — these are build logistics, not product metrics or principles.\n\nPITCH AND POSITIONING SOURCES ARE CANON: an investor pitch, sales narrative, or positioning doc ABOUT OUR OWN PRODUCT is a first-class source — extract its product definition/value_proposition/vision, goals, competitor facts, segments, and principles exactly as from any strategy doc. The hypothesis-stage caution applies ONLY to what a founder says while pitching DURING a customer discovery call.',
  kinds: [
    {
      key: 'competitor',
      label: 'Competitor insight',
      label_plural: 'Competitors & market',
      color: 5,
      consequence: 'low',
      description:
        'A durable fact about a competitor or the market. Title: competitor + the fact in ' +
        '≤10 words (e.g. "Linear shipped native AI triage"). Emit ONE node per named ' +
        'competitor — never comma-join several companies into one node. A table with a ' +
        'competitor column yields one node per row. For market_trend and market_size ' +
        'spanning several vendors, OMIT the competitor attr. When the portfolio has a ' +
        'single product, OMIT the product attr on competitor nodes (portfolio-wide).\n\n' +
        'NOT a competitor insight: what OUR users say about a competitor in research — ' +
        'that is a user_insight; a claim WE make against competitors in our messaging — ' +
        'that belongs to the product value_proposition or a principle.\n\n' +
        'competitor.subkind — choose ONE:\n' +
        '- capability: what they have or shipped.\n' +
        '- pricing: how they charge.\n' +
        '- positioning: how they sell/frame themselves.\n' +
        '- market_trend: a market-level shift not tied to one competitor.\n' +
        '- market_size: a market-sizing or company-scale figure — TAM/SAM/SOM estimates, a ' +
        "competitor's ARR/valuation/funding. These are NEVER our metrics or goals.",
      subkinds: [
        { key: 'capability', label: 'Capability', description: 'What they have or shipped.' },
        { key: 'pricing', label: 'Pricing', description: 'How they charge.' },
        { key: 'positioning', label: 'Positioning', description: 'How they sell/frame themselves.' },
        { key: 'market_trend', label: 'Market trend', description: 'A market-level shift.' },
        { key: 'market_size', label: 'Market size', description: 'TAM/SAM/SOM or competitor ARR/valuation/funding.' },
      ],
      attrs: [
        { key: 'competitor', label: 'Competitor', type: 'string', description: 'Competitor name; omit for market_trend/market_size spanning vendors.' },
        { key: 'arr', label: 'ARR', type: 'string', description: 'Reported/estimated ARR, for market_size.' },
        { key: 'valuation', label: 'Valuation', type: 'string' },
        { key: 'raised', label: 'Raised', type: 'string', description: 'Funding raised.' },
        { key: 'source', label: 'Source', type: 'string', description: 'Where the figure comes from (analyst, filing, press).' },
        { key: 'product', label: 'Product', type: 'string', description: 'Which of OUR products this is most relevant to; omit if portfolio-wide.' },
      ],
    },
    {
      key: 'product',
      label: 'Product',
      label_plural: 'Products',
      color: 1,
      consequence: 'medium',
      description:
        'A facet of one of OUR products. One node per facet. Title: product name + facet ' +
        '(e.g. "Atlas — value proposition").\n\n' +
        'NOT a product node: a capability of the product (→ feature); a target for the ' +
        'product (→ goal); who it serves in general (→ segment).\n\n' +
        'product.subkind — choose ONE:\n' +
        '- definition: what the product is and the problem it solves.\n' +
        '- value_proposition: why it wins, for whom.\n' +
        '- pricing: the CURRENT plans, price points, and what they include.\n' +
        '- vision: the long-arc narrative of where the product is going.',
      subkinds: [
        { key: 'definition', label: 'Definition', description: 'What the product is and the problem it solves.' },
        { key: 'value_proposition', label: 'Value proposition', description: 'Why it wins, for whom.' },
        { key: 'pricing', label: 'Pricing', description: 'Current plans, price points, what they include.' },
        { key: 'vision', label: 'Vision', description: 'The long-arc narrative of where the product is going.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'The product short name. Required.' },
        { key: 'stage', label: 'Stage', type: 'enum', values: ['discovery', 'beta', 'ga', 'sunset'], description: 'Lifecycle stage, when stated.' },
      ],
      buckets: [
        { key: 'definition', label: 'Definition', match: 'subkind' },
        { key: 'value_proposition', label: 'Value prop', match: 'subkind' },
        { key: 'pricing', label: 'Pricing', match: 'subkind' },
        { key: 'vision', label: 'Vision', match: 'subkind' },
      ],
    },
    {
      key: 'segment',
      label: 'Segment',
      label_plural: 'Audience',
      color: 6,
      consequence: 'low',
      description:
        'A defined audience: an ICP, persona, or market segment. Segments can span ' +
        'products. Title: the segment name (e.g. "Enterprise admins").\n\n' +
        'NOT a segment: what a segment said or needs (→ user_insight, tagged with the ' +
        'segment); a competitor’s audience (→ competitor); an internal role or mode of our ' +
        'own team or a single operator; the same audience re-sliced by which page/surface ' +
        'targets it (one buyer described four ways is ONE segment).\n\n' +
        'segment.subkind — choose ONE:\n' +
        '- icp: an ideal customer profile (firmographic: company shape we sell to).\n' +
        '- persona: a person archetype (role, goals, pains).\n' +
        '- segment: any other defined slice of the audience/market.',
      subkinds: [
        { key: 'icp', label: 'ICP', description: 'Ideal customer profile — the company shape we sell to.' },
        { key: 'persona', label: 'Persona', description: 'A person archetype: role, goals, pains.' },
        { key: 'segment', label: 'Segment', description: 'Any other defined audience slice.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when the segment spans products.' },
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
        'A target, OKR, north star, or priority being chased — portfolio-wide or for one ' +
        'product. Title (≤10 words): noun phrase including the number and target if ' +
        'present (e.g. "$2M enterprise ARR").\n\n' +
        'NOT a goal: the metric itself and its definition (→ metric); a thing being ' +
        'built to reach the target (→ feature). Money and percentage targets (ACV, ARR, ' +
        'margin, NRR, expansion) ARE goals — a numbers-dense document never yields zero ' +
        'direction nodes.\n\n' +
        'goal.subkind — choose ONE: north_star, priority, supporting.',
      subkinds: [
        { key: 'north_star', label: 'North star', description: 'THE defining target.' },
        { key: 'priority', label: 'Priority', description: 'A first-order target.' },
        { key: 'supporting', label: 'Supporting', description: 'A secondary target.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' },
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
        'target values: "activation = first workflow run within 7 days, currently 23%". ' +
        'Title: the metric name. Body: the DEFINITION first, then values.\n\n' +
        'NOT a metric: a target attached to a period without a definition (→ goal, ' +
        'referencing the metric by name); one-off experiment numbers (→ user_insight ' +
        'experiment_result); a competitor’s ARR/valuation/funding (→ competitor ' +
        'market_size); TAM/SAM/SOM and company-finance figures like gross margin, blended ' +
        'ACV, or NRR (→ competitor market_size when market-level, otherwise not product ' +
        'canon); a period-bound money target with no measurement definition (→ goal). ' +
        'A metric with a defined acceptable BAND or breach THRESHOLD is a guardrail, ' +
        'not health.\n\n' +
        'metric.subkind — choose ONE: north_star, input, guardrail, health.',
      subkinds: [
        { key: 'north_star', label: 'North star', description: 'The defining product metric.' },
        { key: 'input', label: 'Input', description: 'A driver metric upstream of the north star.' },
        { key: 'guardrail', label: 'Guardrail', description: 'A must-not-degrade metric.' },
        { key: 'health', label: 'Health', description: 'Operational/quality health metric.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' },
        { key: 'current', label: 'Current', type: 'string' },
        { key: 'target', label: 'Target', type: 'string' },
      ],
    },
    {
      key: 'feature',
      label: 'Feature',
      label_plural: 'Roadmap & features',
      color: 4,
      consequence: 'medium',
      description:
        'A capability of a product — planned, building, shipped, or killed. The roadmap ' +
        'IS this kind bucketed by horizon. Title: the capability in ≤8 words.\n\n' +
        'NOT a feature: the outcome it serves (→ goal); the document specifying it ' +
        '(→ spec); a user asking for it (→ user_insight feature_request). A named skill, ' +
        'pipeline stage, classifier, hook, integration, or a "play" mapped to a phase IS ' +
        'a feature — set status and horizon from the phase.\n\n' +
        'Always set the product attr. Set status and horizon when the source states them.',
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Required.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['idea', 'committed', 'building', 'shipped', 'killed'] },
        { key: 'horizon', label: 'Horizon', type: 'enum', values: ['now', 'next', 'later'], description: 'Roadmap horizon, when placed.' },
        { key: 'shipped_on', label: 'Shipped on', type: 'date' },
      ],
      buckets: [
        { key: 'now', label: 'Now', match: 'horizon' },
        { key: 'next', label: 'Next', match: 'horizon' },
        { key: 'later', label: 'Later', match: 'horizon' },
      ],
    },
    {
      key: 'spec',
      label: 'Spec',
      label_plural: 'Specs',
      color: 4,
      consequence: 'low',
      description:
        'The existence and binding state of a spec/PRD: which feature it covers, its ' +
        'approval status, and its key binding scope lines ("MVP excludes SSO"). The spec ' +
        'DOCUMENT itself is a source to digest or a deliverable to review — never paste ' +
        'it into the body. Title: "<feature> spec".\n\n' +
        'NOT a spec node: the individual decisions inside a spec when the source is the ' +
        'spec itself — extract those as their own kinds (decision, scope_boundary, …).\n\n' +
        'Always set the product attr.',
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Required.' },
        { key: 'feature', label: 'Feature', type: 'string', description: 'The feature this spec covers.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['draft', 'in_review', 'approved', 'superseded'] },
        { key: 'approved_on', label: 'Approved on', type: 'date' },
        { key: 'source_ref', label: 'Source ref', type: 'string', description: 'Where the spec document lives.' },
      ],
      buckets: [
        { key: 'draft', label: 'Draft', match: 'status' },
        { key: 'in_review', label: 'In review', match: 'status' },
        { key: 'approved', label: 'Approved', match: 'status' },
      ],
    },
    {
      key: 'sprint',
      label: 'Sprint',
      label_plural: 'Sprints',
      color: 4,
      consequence: 'low',
      description:
        'A delivery cycle’s state: its goal, committed items, dates, and health. Body: ' +
        'sprint goal, committed items, and blockers as stated. Title: the cycle name ' +
        '(e.g. "Atlas sprint 23").\n\n' +
        'NOT a sprint: a feature’s own status (→ feature); a one-off delivery decision ' +
        '(→ decision). Health changes (on_track → blocked) are reversals: flag red.\n\n' +
        'Always set the product attr.',
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Required.' },
        { key: 'starts', label: 'Starts', type: 'date' },
        { key: 'ends', label: 'Ends', type: 'date' },
        { key: 'status', label: 'Status', type: 'enum', values: ['planned', 'active', 'done'] },
        { key: 'health', label: 'Health', type: 'enum', values: ['on_track', 'at_risk', 'blocked'] },
      ],
      buckets: [
        { key: 'active', label: 'Active', match: 'status' },
        { key: 'planned', label: 'Planned', match: 'status' },
        { key: 'done', label: 'Done', match: 'status' },
      ],
    },
    {
      key: 'design',
      label: 'Product design',
      label_plural: 'Product design',
      color: 2,
      consequence: 'low',
      description:
        'A PM-ALTITUDE product-design fact about how the product WORKS for the user: ' +
        'a settled interaction behavior, a defined user flow, or the navigation/IA ' +
        'structure. This is experience shape — what the user does, how the product ' +
        'responds, where the user goes. Title: the design fact in ≤8 words (e.g. ' +
        '"Grouped sidebar: Context / Use / Workspace").\n\n' +
        'NOT a design node: how the UI is visually BUILT — typography, color usage, ' +
        'component styling, construction conventions (→ design_rule); the technology ' +
        'it is built with — frameworks, UI libraries, icon sets (→ architecture, ' +
        'subkind stack); a why-level principle guiding design choices (→ principle, ' +
        'subkind design_principle); a capability the design serves (→ feature); a ' +
        'dated choice to adopt or drop a design — the resulting design IS the node, ' +
        'per the DO-NOT-WRAP rule; an unsettled design idea still being explored (not ' +
        'canon); pixel or designer-tool detail.\n\n' +
        'design.subkind — choose ONE:\n' +
        '- interaction: a settled interaction or experience behavior ("no modals on primary flows", "inline edit, never a save button").\n' +
        '- navigation: the navigation / information-architecture structure.\n' +
        '- flow: a defined user flow at step level ("onboarding: name → profile → create").\n\n' +
        'Set the feature attr when it concerns one feature; omit it when it concerns ' +
        'the product in general. Status changes (adopted → retired) are reversals: flag red.',
      subkinds: [
        { key: 'interaction', label: 'Interaction', description: 'A settled interaction or experience behavior.' },
        { key: 'navigation', label: 'Navigation', description: 'Navigation / information-architecture structure.' },
        { key: 'flow', label: 'Flow', description: 'A defined user flow at step level.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit only when it spans the portfolio.' },
        { key: 'feature', label: 'Feature', type: 'string', description: 'The feature it concerns; omit when it concerns the product in general.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['exploring', 'adopted', 'retired'], description: 'adopted is the default reading when the source states it as settled.' },
      ],
      buckets: [
        { key: 'interaction', label: 'Interactions', match: 'subkind' },
        { key: 'navigation', label: 'Navigation', match: 'subkind' },
        { key: 'flow', label: 'Flows', match: 'subkind' },
      ],
    },
    {
      key: 'design_rule',
      label: 'Design rule',
      label_plural: 'Design rules',
      color: 2,
      consequence: 'low',
      description:
        'A binding rule for how the UI is BUILT — the rendered-surface canon at PM ' +
        'altitude: visual identity (which typefaces and what each is for, where the ' +
        'accent color may appear, the imagery register), named design-system ' +
        'components/patterns and their usage, and UI construction rules ("gradients ' +
        'only on primary CTAs", "status feedback via toasts, never inline text"). ' +
        'THE TEST: a design_rule is CHECKABLE on a rendered screen — "does this ' +
        'surface comply?". A rule phrased as a restriction or never-do ("no gradients ' +
        'outside primary CTAs", "never neon") is STILL a design_rule — not a ' +
        'scope_boundary, not a principle. Title: the rule in ≤8 words. Capture the rule and the ' +
        'NAMED elements (font names, pattern names) — never raw token values ' +
        '(hex/oklch codes), CSS classes, file paths, or installed-library ' +
        'inventories.\n\n' +
        'NOT a design_rule: how the product behaves or where users go — ' +
        'interactions, flows, navigation (→ design); the technology or library that ' +
        'implements the UI — frameworks, component libraries, icon sets ' +
        '(→ architecture, subkind stack); the why-level principle BEHIND the rules — ' +
        'it guides choices but cannot be checked on a single screen (→ principle, ' +
        'subkind design_principle); concrete copy or one screen’s content (not canon).\n\n' +
        'design_rule.subkind — choose ONE:\n' +
        '- visual_identity: the visual register — typography roles, color/accent usage, iconography, imagery style.\n' +
        '- component: a named design-system component or reusable pattern and its usage rule.\n' +
        '- ui_rule: any other binding rule for constructing UI surfaces.\n\n' +
        'Set the feature attr when the rule governs one feature; omit it when it ' +
        'governs the product or the whole design system. Status changes ' +
        '(adopted → retired) are reversals: flag red.',
      subkinds: [
        { key: 'visual_identity', label: 'Visual identity', description: 'Typography roles, color/accent usage, iconography, imagery style.' },
        { key: 'component', label: 'Component', description: 'A named design-system component or reusable pattern and its usage rule.' },
        { key: 'ui_rule', label: 'UI rule', description: 'Any other binding rule for constructing UI surfaces.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit only when it spans the portfolio (a shared design system).' },
        { key: 'feature', label: 'Feature', type: 'string', description: 'The feature it governs; omit when it governs the product or design system.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['exploring', 'adopted', 'retired'], description: 'adopted is the default reading when the source states it as settled.' },
      ],
      buckets: [
        { key: 'visual_identity', label: 'Visual identity', match: 'subkind' },
        { key: 'component', label: 'Components', match: 'subkind' },
        { key: 'ui_rule', label: 'UI rules', match: 'subkind' },
      ],
    },
    {
      key: 'architecture',
      label: 'Architecture',
      label_plural: 'Architecture',
      color: 5,
      consequence: 'medium',
      description:
        'A PM-ALTITUDE engineering fact: the system design/topology, an API surface, a ' +
        'data store, a deployed service, or a technology-stack choice — the shape of ' +
        'the system and the binding choices, never code-level detail. Title: the ' +
        'entity + the fact in ≤8 words ' +
        '(e.g. "Single SQLite database, workspace-scoped").\n\n' +
        'NOT an architecture node: a capability built on it (→ feature); an imposed ' +
        'technical limit (→ constraint, subkind technical); a rule for how UI ' +
        'surfaces look or are constructed — even when it names the library that ' +
        'renders them (→ design_rule; the LIBRARY choice itself is architecture, ' +
        'subkind stack); a dated choice to adopt — ' +
        'the resulting architecture IS the node, per the DO-NOT-WRAP rule; ' +
        'implementation detail below PM altitude (function names, configs, library ' +
        'versions, file paths); build logistics and eval thresholds (already excluded).\n\n' +
        'architecture.subkind — choose ONE:\n' +
        '- system_design: the overall topology or a major structural pattern ("routed multi-call capture pipeline").\n' +
        '- api: an API surface or contract and what it serves ("REST API under /workspaces/:ws", "MCP server for AI tools").\n' +
        '- data_store: a database or storage system and what lives in it.\n' +
        '- service: a deployed service/component and its responsibility ("Slack bot runs as its own compose stack").\n' +
        '- stack: a binding technology choice — framework, UI library, icon set, language ("Tailwind v4 + shadcn/ui", "icons: Lucide everywhere").\n\n' +
        'Set the feature attr when it underpins one feature; omit it when it is ' +
        'product-wide. Status changes (current → deprecated) are reversals: flag red.',
      subkinds: [
        { key: 'system_design', label: 'System design', description: 'Overall topology or a major structural pattern.' },
        { key: 'api', label: 'API', description: 'An API surface or contract and what it serves.' },
        { key: 'data_store', label: 'Data store', description: 'A database or storage system and what lives in it.' },
        { key: 'service', label: 'Service', description: 'A deployed service/component and its responsibility.' },
        { key: 'stack', label: 'Stack', description: 'A binding technology choice — framework, UI library, icon set, language.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit only when it spans the portfolio (shared platform).' },
        { key: 'feature', label: 'Feature', type: 'string', description: 'The feature it underpins; omit when product-wide.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['planned', 'current', 'deprecated'] },
      ],
      buckets: [
        { key: 'system_design', label: 'System design', match: 'subkind' },
        { key: 'api', label: 'APIs', match: 'subkind' },
        { key: 'data_store', label: 'Data stores', match: 'subkind' },
        { key: 'service', label: 'Services', match: 'subkind' },
        { key: 'stack', label: 'Stack', match: 'subkind' },
      ],
    },
    {
      key: 'decision',
      label: 'Decision',
      label_plural: 'Decisions',
      color: 5,
      consequence: 'high',
      description:
        'A dated one-off product choice that is not better captured by a more specific ' +
        'kind (see the decision tree — features, scope boundaries, commitments, ' +
        'principles, designs, design rules, and architecture are NOT wrapped in ' +
        'decisions: choosing/retiring a technology or library is architecture (subkind ' +
        'stack), adopting a UI rule is design_rule, adopting a flow is design — the ' +
        'resulting entity IS the node, with a red flag when it reverses prior state). ' +
        'Title (≤12 words): imperative verb + ' +
        'object + key constraint.\n\n' +
        'decision.category — choose ONE: scope, prioritization, pricing, build_vs_buy, ' +
        'architecture, ux, process, sunset.\n' +
        'Fill `impacts` with the names of features/metrics/goals/commitments the source ' +
        'says this decision affects.',
      categories: [
        { key: 'scope', label: 'Scope' },
        { key: 'prioritization', label: 'Prioritization' },
        { key: 'pricing', label: 'Pricing' },
        { key: 'build_vs_buy', label: 'Build vs buy' },
        { key: 'architecture', label: 'Architecture' },
        { key: 'ux', label: 'UX' },
        { key: 'process', label: 'Process' },
        { key: 'sunset', label: 'Sunset' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' },
        { key: 'decided_on', label: 'Decided on', type: 'date' },
        { key: 'decided_by', label: 'Decided by', type: 'string' },
        { key: 'impacts', label: 'Impacts', type: 'string', description: 'Names of features/metrics/goals/commitments this decision affects, when stated.' },
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
        'leadership, or the board. Title: what was promised to whom in ≤10 words.\n\n' +
        'NOT a commitment: an internal plan with no named counterparty (→ feature or ' +
        'goal); a contractual restriction imposed ON us (→ constraint).\n\n' +
        '"Promised/told/agreed with someone" wins over decision — extract here.',
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' },
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
        'An imposed "can’t" — a limit from external reality, not a choice: technical, ' +
        'legal/compliance, resourcing, or a dependency. Title: the limit in ≤10 words.\n\n' +
        'NOT a constraint: a chosen "won’t" (→ scope_boundary); a RISK someone worries ' +
        'about (acquisition risk, market risk, "what if X") — risks under discussion ' +
        'are not canon at all; a PHASE GATE or acceptance criterion ("Phase 1 blocked ' +
        'until ≥20 nodes") — build logistics, not canon.\n\n' +
        'constraint.subkind — choose ONE: technical, legal_compliance, resourcing, dependency.',
      subkinds: [
        { key: 'technical', label: 'Technical' },
        { key: 'legal_compliance', label: 'Legal / compliance' },
        { key: 'resourcing', label: 'Resourcing' },
        { key: 'dependency', label: 'Dependency', description: 'A platform/partner/vendor dependency that binds us.' },
      ],
      attrs: [{ key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' }],
    },
    {
      key: 'scope_boundary',
      label: 'Scope boundary',
      label_plural: 'Scope boundaries',
      color: 2,
      consequence: 'medium',
      description:
        'An explicit chosen not-doing: "We are NOT building X." State the boundary ' +
        'plainly. Title: "Not doing: <X>". Fan EACH bullet of a "Non-goals" / "What we ' +
        'are not" / "Out of scope" list into its own node. Competitive category ' +
        'disavowals ("we are not an OKR tool") are scope_boundaries. "Deferred to ' +
        'later" / "stays out for now" is a chosen sequencing boundary — it belongs here, ' +
        'NOT in constraint.\n\n' +
        'NOT a scope boundary: an imposed limit (→ constraint); a feature being killed ' +
        'after existing (→ feature with status killed, red flag); a UI or visual ' +
        'restriction ("no gradients outside primary CTAs", "never neon", "bg-page only ' +
        'on login") → design_rule — scope_boundary is about what we BUILD, never about ' +
        'how surfaces look or are constructed.',
      attrs: [{ key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' }],
    },
    {
      key: 'principle',
      label: 'Principle',
      label_plural: 'Principles',
      color: 1,
      consequence: 'medium',
      description:
        'A durable always/never rule the team holds itself to, or a canonical ' +
        'definition. Timeless guidance, not a dated choice.\n\n' +
        'NOT a principle: ML/synthesis eval thresholds, model quality gates, latency/' +
        'cost/reliability targets, or spec-internal requirements — a quality_bar is a ' +
        'durable standard for the PRODUCT’S output, not for building it.\n\n' +
        'principle.subkind — choose ONE:\n' +
        '- product_principle: how we build product generally (e.g. "default to opinionated defaults").\n' +
        '- design_principle: a why-level principle that guides product strategy and design CHOICES ("information is carried by structure, not decoration", "the user never has to read the graph to get value"). It shapes decisions across surfaces; it is NOT checkable on a single rendered screen — a screen-checkable rule is a design_rule, NOT a principle. THE TELL: if it names a concrete visual element or surface (a typeface role, a color and where it may appear, which feedback pattern to use), it is a design_rule, however principled it sounds. An interaction/flow/navigation fact is design, NOT a principle.\n' +
        '- quality_bar: a bar work must clear.\n' +
        '- process_rule: how the TEAM operates, incl. approval rules ("pricing changes need CFO sign-off"). NOT how the product\'s surfaces behave or are constructed — "every destructive action gets a confirm dialog" is a design_rule even when phrased as "let\'s make it a rule".\n' +
        '- messaging_rule: a voice/phrasing rule — banned or required phrases, framing rules. One node per phrase/rule, quoted verbatim.\n' +
        '- definition: a canonical term or naming rule ("it’s workspaces, not projects").\n\n' +
        'Strategic framing BELIEFS ("we are a system of record, not a tool") are product_principle. ' +
        'Fan numbered/bulleted principle lists into one node per item.\n\n' +
        'NOT a principle (most common leak): a binding rule for how the UI is built — ' +
        'accent/gradient placement, typography usage, feedback patterns ("toasts, not ' +
        'inline text") — those are design_rule, however durable they sound. A why-' +
        'framing does not rescue it: "the accent is used deliberately and sparingly", ' +
        '"data always renders in mono — it signals canon", "exactly one red object ' +
        'per image" all name a concrete element and a placement, so they are ' +
        'design_rule, not design_principle. When torn between design_principle and ' +
        'design_rule, choose design_rule.',
      subkinds: [
        { key: 'product_principle', label: 'Product principle' },
        { key: 'design_principle', label: 'Design principle', description: 'Why-level guidance for product strategy and design choices — never a screen-checkable UI rule.' },
        { key: 'quality_bar', label: 'Quality bar' },
        { key: 'process_rule', label: 'Process rule' },
        { key: 'messaging_rule', label: 'Messaging rule' },
        { key: 'definition', label: 'Definition' },
      ],
      attrs: [{ key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide (most principles are).' }],
    },
    {
      key: 'research',
      label: 'Research study',
      label_plural: 'Research',
      color: 6,
      consequence: 'low',
      description:
        'A research study as an entity: the question it set out to answer, the method, ' +
        'who was studied, and when. Title: the study name (e.g. "Q2 churn interviews"). ' +
        'Body: research goal first, then method/n.\n\n' +
        'NOT research: the findings themselves (→ user_insight, one per finding, tagged ' +
        'with this study’s name). For a single discrete study or interview, emit the ' +
        'research node FIRST and propagate its name into every sibling user_insight’s ' +
        'study attr.',
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' },
        { key: 'research_goal', label: 'Research goal', type: 'string', description: 'The question the study set out to answer.' },
        { key: 'method', label: 'Method', type: 'string', description: 'e.g. "interviews", "survey", "usage analysis".' },
        { key: 'segment', label: 'Segment', type: 'string', description: 'Who was studied.' },
        { key: 'date', label: 'Date', type: 'date' },
      ],
    },
    {
      key: 'user_insight',
      label: 'User insight',
      label_plural: 'User insights',
      color: 3,
      consequence: 'low',
      description:
        'A durable, settled piece of evidence about users. Tag the segment it is about ' +
        'and the study it came from when stated. In any multi-speaker source, an ' +
        'insight MUST originate from an EXTERNAL participant (the customer, prospect, ' +
        'or user) — statements by the interviewer/founder/our team NEVER yield a ' +
        'user_insight, no matter how insightful; set the speaker attr to who said it.\n\n' +
        'NOT a user_insight: an open question or a hypothesis not yet tested (not ' +
        'canon); a fact about a competitor’s product (→ competitor) — but what OUR ' +
        'users SAY about a competitor IS a user_insight.\n\n' +
        'user_insight.subkind — choose ONE:\n' +
        '- research_finding: a finding from research or data.\n' +
        '- pain_point: a validated user pain.\n' +
        '- objection: a recurring objection.\n' +
        '- feature_request: a recurring ask.\n' +
        '- experiment_result: an experiment/AB outcome with its number.\n' +
        '- willingness_to_pay: evidence about what users would pay.\n' +
        '- concept_validation: a user’s reaction to OUR OWN unshipped concept or pitch. ' +
        'Reactions to a COMPETITOR’s product are research_finding (or → competitor when ' +
        'they state a fact about it rather than a reaction).\n\n' +
        'In discovery calls, the FOUNDER’s own pitch language is hypothesis-stage — capture ' +
        'the USER’s reactions as insights; do not harden the pitch into settled canon.',
      subkinds: [
        { key: 'research_finding', label: 'Research finding' },
        { key: 'pain_point', label: 'Pain point' },
        { key: 'objection', label: 'Objection' },
        { key: 'feature_request', label: 'Feature request' },
        { key: 'experiment_result', label: 'Experiment result' },
        { key: 'willingness_to_pay', label: 'Willingness to pay' },
        { key: 'concept_validation', label: 'Concept validation' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when portfolio-wide.' },
        { key: 'segment', label: 'Segment', type: 'string', description: 'Which audience this is about.' },
        { key: 'study', label: 'Study', type: 'string', description: 'The research study that produced it, when stated.' },
        { key: 'speaker', label: 'Speaker', type: 'string', description: 'Who said it — must be an external participant, never the interviewer.' },
      ],
    },
  ],
  feedback_dimensions: [
    { key: 'decisions', label: 'Decisions', description: 'alignment with what has been decided, including each decision’s stated impacts' },
    { key: 'goals_priorities', label: 'Goals & priorities', description: 'does this lead with / serve the current portfolio and product direction' },
    {
      key: 'product_accuracy',
      label: 'Product accuracy',
      description:
        'claims about a product match its defined features and their status, its metrics and their definitions, its pricing, and its value proposition; competitive and "only we" claims match the competitor record in the context',
    },
    {
      key: 'delivery_truth',
      label: 'Delivery truth',
      description: 'claims about delivery state match the context: spec approval status, sprint health, feature status and horizons',
    },
    {
      key: 'platform_consistency',
      label: 'Platform consistency',
      description:
        'claims about UI behavior, user flows, navigation, visual identity and UI construction rules, APIs, data stores, or system structure match the recorded design, design-rule, and architecture canon — including each entity’s status (adopted/retired, current/deprecated)',
    },
    { key: 'scope_and_constraints', label: 'Scope & constraints', description: 'respects explicit scope boundaries and imposed constraints' },
    { key: 'commitments', label: 'Commitments', description: 'does not promise anything not committed, and does not contradict committed dates or terms' },
    { key: 'user_evidence', label: 'User evidence', description: 'claims about users are backed by insights from the right segment, not assertion' },
    { key: 'context_recency', label: 'Context recency', description: 'recent decisions, status changes, or insights the work should reflect' },
  ],
  review_kinds: [
    'prd',
    'spec',
    'design_doc',
    'rfc',
    'roadmap_update',
    'sprint_plan',
    'exec_update',
    'release_note',
    'customer_comm',
    'sales_material',
    'marketing_copy',
    'research_plan',
    'other',
  ],
  query_scopes: [
    { key: 'market', label: 'Market & competitors', kind_keys: ['competitor'] },
    { key: 'products', label: 'Products', kind_keys: ['product'] },
    { key: 'audience', label: 'Audience', kind_keys: ['segment'] },
    { key: 'direction', label: 'Goals & metrics', kind_keys: ['goal', 'metric'] },
    { key: 'roadmap', label: 'Roadmap', kind_keys: ['feature'] },
    { key: 'delivery', label: 'Delivery', kind_keys: ['feature', 'spec', 'sprint'] },
    { key: 'design', label: 'Product design', kind_keys: ['design'] },
    { key: 'design_rules', label: 'Design rules', kind_keys: ['design_rule'] },
    { key: 'architecture', label: 'Architecture', kind_keys: ['architecture'] },
    { key: 'platform', label: 'Design & architecture', kind_keys: ['design', 'design_rule', 'architecture'] },
    { key: 'decisions', label: 'Decisions', kind_keys: ['decision'] },
    { key: 'commitments', label: 'Commitments', kind_keys: ['commitment'] },
    { key: 'guardrails', label: 'Scope, constraints & principles', kind_keys: ['constraint', 'scope_boundary', 'principle'] },
    { key: 'evidence', label: 'Research & insights', kind_keys: ['research', 'user_insight'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  extraction_groups: [
    {
      key: 'landscape',
      label: 'Market, products & audience',
      kind_keys: ['competitor', 'product', 'segment'],
      description:
        'Competitor/market facts, definitions of our products (value prop, pricing, vision, stage), and audience definitions (ICPs, personas, segments).',
    },
    {
      key: 'direction',
      label: 'Goals & metrics',
      kind_keys: ['goal', 'metric'],
      description: 'Targets, OKRs, north stars, and metric definitions with current/target values.',
    },
    {
      key: 'delivery',
      label: 'Delivery',
      kind_keys: ['feature', 'spec', 'sprint'],
      description: 'Features and roadmap placements, spec existence/approval status, sprint contents and health.',
    },
    {
      key: 'platform',
      label: 'Design & architecture',
      kind_keys: ['design', 'design_rule', 'architecture'],
      description:
        'Product-design facts (interactions, user flows, navigation/IA), design rules for how the UI is built (visual identity, design-system components, UI construction rules), and engineering shape (system design, APIs, data stores, services, technology stack).',
    },
    {
      key: 'judgment',
      label: 'Decisions & guardrails',
      kind_keys: ['decision', 'commitment', 'constraint', 'scope_boundary', 'principle'],
      description:
        'Dated choices, promises to named parties, imposed constraints, explicit not-doings, and durable principles/definitions.',
    },
    {
      key: 'evidence',
      label: 'Research & insights',
      kind_keys: ['research', 'user_insight'],
      description:
        'Research studies (goal/method/segment) and settled user insights, pains, ' +
        'objections, experiment results. PROCEDURE for a discrete study or interview ' +
        'transcript: emit ONE research node FIRST (name the study, e.g. "Priya ' +
        'discovery call"), then one user_insight per finding with its study attr set ' +
        'to that name and segment set to who the evidence is about.',
    },
  ],
  flag_semantics: {
    red: 'contradicts or changes a prior decision, scope boundary, constraint, commitment, roadmap placement, spec status, or sprint health — or misstates a product’s features, metrics, pricing, value proposition, or its recorded design, design-rule, and architecture canon',
    yellow: 'hedged or low-conviction, lacks user evidence, or conflicts with stated horizons without an explicit change',
    green: 'consistent with the portfolio canon and, where it makes user claims, backed by evidence',
  },
  // Typed node↔node relations. Small on purpose: each edge kind must answer a
  // real retrieval question ("what evidence is about this segment?", "what
  // supports this goal?"). src/dst constraints are enforced at write time.
  edge_kinds: [
    {
      key: 'supports',
      label: 'Supports',
      description:
        'The source contributes to achieving the destination goal — supporting goal → north star, metric → the goal it measures, feature → the goal it advances.',
      src_kinds: ['goal', 'metric', 'feature'],
      dst_kinds: ['goal'],
      directed: true,
    },
    {
      key: 'about',
      label: 'About',
      description:
        'Evidence pointing at the entity it concerns — a user insight or research study that is about a specific segment, competitor, product, or feature.',
      src_kinds: ['user_insight', 'research'],
      dst_kinds: ['segment', 'competitor', 'product', 'feature'],
      directed: true,
    },
    {
      key: 'belongs_to',
      label: 'Belongs to',
      description:
        'Product scoping made explicit: a node that lives under one product of the portfolio (its features, specs, sprints, goals, metrics, decisions, segments, principles). ' +
        'Points FROM the scoped node TO its product — only for nodes whose product attr or body names the product; portfolio-wide nodes belong to no product. ' +
        "ANCHOR: a product appears as several nodes, one per aspect (definition, value_proposition, pricing, vision) — attach to the product's subkind='definition' node; fall back to another aspect only when no definition node exists.",
      src_kinds: [
        'feature',
        'spec',
        'sprint',
        'goal',
        'metric',
        'decision',
        'segment',
        'principle',
        'commitment',
        'constraint',
        'scope_boundary',
        'competitor',
        'user_insight',
        'research',
        'design',
        'design_rule',
        'architecture',
      ],
      dst_kinds: ['product'],
      directed: true,
      scope_attr: 'product',
    },
    {
      key: 'applies_to',
      label: 'Applies to',
      description:
        'The surface a design, design-rule, or architecture entity governs: points FROM the design/design_rule/architecture node TO the specific feature it concerns, or TO the product when it applies in general. ' +
        'ONLY when the source node is scoped to that product (its product attr matches) — portfolio-wide design-system rules apply to no single product. ' +
        "ANCHOR: when the destination is a product, attach to its subkind='definition' node.",
      src_kinds: ['design', 'design_rule', 'architecture'],
      dst_kinds: ['feature', 'product'],
      directed: true,
      scope_attr: 'product',
    },
    {
      key: 'evolves',
      label: 'Evolves',
      description:
        'Execution touching the platform: points FROM the feature, spec, or sprint TO the design, design-rule, or architecture entity it creates, modifies, or retires — answers "what work is changing this part of the system?". ' +
        'ONLY when the source explicitly states that the work changes that entity — never from shared topic or shared product alone.',
      src_kinds: ['feature', 'spec', 'sprint'],
      dst_kinds: ['design', 'design_rule', 'architecture'],
      directed: true,
    },
    {
      key: 'depends_on',
      label: 'Depends on',
      description:
        'System coupling at PM altitude: points FROM the architecture entity that needs the destination TO the one it relies on (a service on its data store, an API on a service).',
      src_kinds: ['architecture'],
      dst_kinds: ['architecture'],
      directed: true,
    },
    {
      key: 'refines',
      label: 'Refines',
      description:
        'The source is a narrower version of the destination — persona within a segment, SOM refines SAM refines TAM, a sharper goal refining a broad one.',
      src_kinds: ['segment', 'competitor', 'goal'],
      dst_kinds: ['segment', 'competitor', 'goal'],
      directed: true,
    },
    {
      key: 'addresses',
      label: 'Addresses',
      description:
        'A solution pointing at the problem or evidence it answers — a decision, feature, or principle that addresses a user insight, constraint, or scope boundary.',
      src_kinds: ['decision', 'feature', 'principle'],
      dst_kinds: ['user_insight', 'constraint', 'scope_boundary'],
      directed: true,
    },
    {
      key: 'bounds',
      label: 'Bounds',
      description:
        'A scope boundary that delimits something specific — the competitor category we refuse to replace, the product or feature the not-doing applies to. ' +
        'Only when the boundary itself is scoped to the destination; portfolio-wide boundaries bound no single product. ' +
        "ANCHOR: when the destination is a product, attach to its subkind='definition' node.",
      src_kinds: ['scope_boundary'],
      dst_kinds: ['competitor', 'product', 'feature'],
      directed: true,
    },
    {
      key: 'competes_with',
      label: 'Competes with',
      description:
        'One of our products competing in the space a competitor node describes. ' +
        "ANCHOR: attach the source end to the product's subkind='definition' node.",
      src_kinds: ['product'],
      dst_kinds: ['competitor'],
      directed: true,
    },
  ],
  // Source types this profile expects. The router classifies each document;
  // the matched type's extraction_guidance is injected into capture calls.
  source_types: [
    {
      key: 'prd_or_spec',
      label: 'PRD / spec',
      description: 'A product requirements doc, spec, or design doc for a feature or product.',
      extraction_guidance:
        'This is a formal spec: extract its binding lines (scope, non-goals, decisions) as first-class canon, and emit the spec-existence node per the taxonomy.',
      // A spec whose spec/feature nodes (delivery) or binding lines (judgment)
      // were never extracted is a capture failure, not a routing judgment call.
      group_floor: ['delivery', 'judgment'],
      // Triage: a PRD/spec is the authoritative artifact for what we build
      // and the binding lines around it — commit-as-a-unit when current.
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['product', 'goal', 'metric', 'feature', 'spec', 'sprint', 'design', 'design_rule', 'architecture', 'decision', 'commitment', 'constraint', 'scope_boundary', 'principle'],
      triage_guidance:
        'Legitimate when it reads as an adopted spec (scope and non-goals stated as settled, an owner identifiable). Drafts and option docs are not commit units. Specs decay: anchor currency on version markers and whether its scope contradicts newer delivery state in the graph.',
    },
    {
      key: 'design_guidelines',
      label: 'Design guidelines',
      description: 'A design-guidelines, design-system, brand, or UI-standards document.',
      extraction_guidance:
        'This is the design canon: extract design rules (visual identity, components, UI construction rules), product-design facts (interactions, flows, navigation), the why-level design principles behind them, and binding stack choices — at PM altitude: the rule and its named elements, never token values, CSS classes, code identifiers, or file paths.',
      // The platform group IS the point of ingesting design guidelines; the
      // why-level principles in them live in judgment — floor both so neither
      // depends on a router vote (same shape as the Dan-interview incident).
      group_floor: ['platform', 'judgment'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['design', 'design_rule', 'architecture', 'principle'],
      triage_guidance:
        'Legitimate when it reads as adopted standards (rules stated as binding, a source of truth identified). Authoritative for the design canon only — direction or judgment nodes beyond design principles need individual eyes. Decays: newer rules in the graph win over an older guidelines doc.',
    },
    {
      key: 'strategy_doc',
      label: 'Strategy doc',
      description: 'A product/GTM strategy memo, vision doc, positioning doc, or investor pitch about OUR product.',
      extraction_guidance: '',
      group_floor: ['direction', 'judgment'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['competitor', 'product', 'segment', 'goal', 'metric', 'decision', 'commitment', 'constraint', 'scope_boundary', 'principle'],
      triage_guidance:
        'A strategy memo speaks for direction and landscape, not for user evidence. Currency is the central question: a strategy doc from a prior period contradicting the graph is more often the stale party.',
    },
    {
      key: 'customer_interview',
      label: 'Customer interview',
      description: 'A discovery, sales, or research call transcript with a customer, prospect, or user.',
      extraction_guidance: interviewGuidance(
        'Capture especially: pains, objections, willingness-to-pay, and concept reactions — tagged to the segment and study.',
      ),
      source_kinds: ['transcript'],
      // The evidence group IS the point of ingesting a customer interview —
      // the 2026-06-04 zero-yield incident was exactly this type routed away
      // from evidence (relevant=true, 16 specialists, 0 candidates).
      group_floor: ['evidence'],
      // A point-in-time record of what the customer said — never stale,
      // authoritative for evidence about users, not for our own judgment.
      currency: 'point_in_time',
      authority_kinds: ['research', 'user_insight', 'segment'],
    },
    {
      key: 'expert_interview',
      label: 'Expert interview',
      description: 'A call with a domain expert, advisor, or analyst (not a buyer or user of our product).',
      extraction_guidance: interviewGuidance(
        'Capture especially: market facts, competitor facts, and segment definitions the expert asserts — these are landscape canon, not user evidence.',
      ),
      group_floor: ['landscape'],
      currency: 'point_in_time',
      authority_kinds: ['competitor', 'segment', 'research', 'user_insight'],
    },
    {
      key: 'stakeholder_interview',
      label: 'Stakeholder interview',
      description: 'An internal interview or 1:1 with a teammate, executive, or board member about the product.',
      extraction_guidance: interviewGuidance(
        'Internal voices yield direction and judgment canon (goals, decisions, constraints, principles) — never user evidence.',
      ),
      group_floor: ['direction', 'judgment'],
      currency: 'point_in_time',
      authority_kinds: ['product', 'goal', 'metric', 'decision', 'commitment', 'constraint', 'scope_boundary', 'principle'],
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between teammates.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from product-team chat: settled product decisions (naming, scope, sequencing, build-vs-buy), competitor facts a teammate reports, product definitions or value-prop language both parties converge on, and concrete commitments with dates. ' +
          'KIND CARE: a settled rule about UI surfaces (confirm dialogs, visual/styling rules) is design_rule — NEVER principle.process_rule, even when phrased "let\'s make it a rule"; a settled technology choice (icon set, library, framework) is architecture (stack), not a decision.',
      ),
      source_kinds: ['slack'],
      group_floor: ['judgment'],
      currency: 'point_in_time',
    },
    {
      key: 'meeting_notes',
      label: 'Meeting notes',
      description: 'Notes or minutes from an internal meeting: decisions, action items, status.',
      extraction_guidance:
        'Meeting notes mix settled outcomes with discussion. Extract only stated outcomes and facts; skip the discussion that led there. Action items are logistics, not canon.',
      group_floor: ['judgment'],
      // A record of one meeting — never accurate "as a unit".
      currency: 'point_in_time',
    },
    {
      key: 'research_report',
      label: 'Research report',
      description: 'A research summary, survey results, usage analysis, or experiment write-up.',
      extraction_guidance:
        'Emit the research study node FIRST, then one insight per finding with its study attr set — per the evidence procedure in the taxonomy.',
      group_floor: ['evidence'],
      // An authored artifact whose findings do not decay: commit-as-a-unit
      // with no currency question (point_in_time).
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['research', 'user_insight', 'segment'],
      triage_guidance:
        'Legitimate when it is a finished write-up (methodology or study identifiable, findings stated as conclusions). Authoritative for evidence only — any direction or judgment nodes it yields need individual eyes.',
    },
  ],
  seed_questions: [
    'What products are in the portfolio and what stage is each at?',
    'What is on the roadmap for each product right now?',
    'What have we committed to customers, and when?',
    'What is out of scope, and what constraints bind us?',
    'What does the latest research say about our ICP’s pain points?',
    'How do we compare to our main competitors?',
    'What is the system architecture, and what does each service do?',
    'Which user flows and navigation structure are adopted, and for which features?',
    'What design rules govern how the UI is built?',
  ],
};
