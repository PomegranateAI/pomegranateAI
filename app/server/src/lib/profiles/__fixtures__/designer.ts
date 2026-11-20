import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance } from '../source-types.js';

/**
 * The `designer` built-in profile. The operating model of a senior/lead
 * designer who maintains the design canon and reviews other designers'
 * product-design and visual-design work. Five layers:
 *
 *   CANON      brand_asset · component   — visual identity and the design
 *              system, captured BY LINK (asset_url + per-version links),
 *              never by visual description
 *   STANDARDS  guideline · principle     — screen-checkable rules vs
 *              why-level principles (same split the product profile earned)
 *   WORK       surface · project         — screens/flows/prototypes in
 *              flight and the projects they belong to
 *   JUDGMENT   critique · decision · constraint — settled review feedback
 *              (dimension × severity), dated choices, imposed limits
 *   EVIDENCE   insight                   — usability/research/accessibility
 *              findings
 *
 * THE ASSET LINK RULE is this profile's defining extraction principle: the
 * graph carries usage and judgment; the LINK carries the visual. It is
 * restated on every visual kind, enforced by flag semantics (yellow when a
 * visual node has no link), checked at review time (link_integrity), and
 * re-injected by the brand_guidelines / design_spec source types.
 */
export const designerProfile: ContextProfile = {
  id: 'designer',
  shape: 'items',
  name: 'Designer',
  routing_hint:
    'The visual / design canon: brand identity (logo, color, typography, iconography, ' +
    'illustration / imagery / motion), the design system (components, patterns, templates) ' +
    'and their usage rules — captured by reference — plus screens, flows and design ' +
    'critique. SHARED ZONES — route here ALONGSIDE the neighbor when a document defines or ' +
    'changes brand assets (shared with marketing) or how the UI is built / how the product ' +
    'works for the user (shared with product).',
  description:
    'A senior designer / design lead who owns the design canon and reviews product-design ' +
    'and visual-design work created by other designers. The context is: the visual identity ' +
    'canon (logos, palettes, typography, iconography, illustration/imagery/motion styles — ' +
    'each as a LINKED asset with usage rules), the design system (components and patterns ' +
    'with usage rules and links), the standards (screen-checkable guidelines and why-level ' +
    'principles, quality bars, process rules), the work in flight (screens, flows, ' +
    'prototypes and the projects they belong to), the judgment layer (settled critique ' +
    'feedback with its dimension and severity, dated design decisions, imposed constraints), ' +
    'and the evidence (usability, research, and accessibility findings). The work product ' +
    'is screen and flow designs, prototypes, design specs, brand assets, and design ' +
    'presentations.\n\n' +
    'ASSET LINK RULE — the defining extraction principle of this profile: visual entities ' +
    'are captured BY REFERENCE, never by description. A node about a logo, palette, ' +
    'typeface, icon set, component, or screen carries LINKS to the artifact — the ' +
    'asset_url attr for the canonical source of truth (Figma file/frame, brand portal, ' +
    'Drive folder, repo path) and one body line per version/variant in the form ' +
    '"<version> — <when to use it> — <link>". The body is a USAGE MAP, not a portrait: ' +
    'capture WHERE each version applies and the rules around it, NEVER what it looks like ' +
    '("rounded red wordmark on cream" is banned content — the link carries the visual). ' +
    'When the source names or shows a visual artifact but provides no link or file ' +
    'reference, still capture the entity and its usage rules, end the body with "No link ' +
    'in source.", and flag the candidate yellow — a visual node without a link is ' +
    'incomplete canon.\n\n' +
    'SCOPING — set the `product` attr (the product or brand SHORT NAME, lowercase) on ' +
    'every node specific to one product/brand; omit it only when the claim spans the whole ' +
    'studio/portfolio. Work-in-flight nodes (surface, critique, decision, constraint, ' +
    'insight) additionally carry a `project` attr (the project short name) when they ' +
    'belong to a named design project. Write both attrs as lowercase space-separated ' +
    'words exactly as the team names them — never hyphenate or invent punctuation ' +
    '("checkout redesign", not "checkout-redesign") — and set ONLY the attrs each kind ' +
    'declares, never invented ones.\n\n' +
    'KIND DECISION TREE — test in this order, first match wins:\n' +
    '1. A named visual-identity asset family — logo, color palette, typography, icon set, ' +
    'illustration/imagery/motion style → brand_asset\n' +
    '2. A named design-system component, pattern, or template and its usage rule → component\n' +
    '3. A screen, flow, or prototype being designed — the work artifact itself → surface\n' +
    '4. A design project/initiative and its status → project\n' +
    '5. A usability, research, or accessibility finding about users → insight\n' +
    '6. Settled review feedback on a specific piece of design work → critique\n' +
    '7. A binding rule checkable on a rendered screen (layout, spacing, accessibility, ' +
    'content/voice, motion, platform convention) → guideline\n' +
    '8. An imposed "can\'t" (technical, brand-legal, platform, resourcing) → constraint\n' +
    '9. A dated one-off design choice not better captured above → decision\n' +
    '10. A durable why-level principle, quality bar, process rule, or canonical ' +
    'definition → principle\n\n' +
    'NOT THIS DOMAIN: "design" here means PRODUCT and VISUAL design. Engineering design — ' +
    'system/API/schema design, service topology, data models, infra and deploy facts, ' +
    'code-level implementation — is NOT this canon, even when the source says "design" ' +
    'in every heading or touches screens the design team owns. An engineering RFC or ' +
    'deploy note is irrelevant unless it states a product/visual-design fact (a binding ' +
    'constraint ON design work may qualify as constraint/technical; the engineering ' +
    'content itself never does).\n\n' +
    'DO NOT EXTRACT (not canon, even in relevant documents): prose descriptions of how a ' +
    'visual looks — shapes, colors-in-words, moods, "feels premium" (the ASSET LINK RULE: ' +
    'capture the entity, its links, and its usage rules instead); raw design-token value ' +
    'enumerations — hex/oklch codes, px sizes, font-size scales, CSS classes (link to the ' +
    'token source and name the roles instead); open explorations, moodboard musings, and ' +
    'concept options still on the table; critique back-and-forth that never settled; ' +
    'meeting/file logistics and tool operations; who-owns-what people/org information ' +
    '(except the reviewer attr on critiques and decided_by on decisions); embedded sample ' +
    'content inside a mockup (placeholder names, demo numbers).',
  kinds: [
    {
      key: 'brand_asset',
      label: 'Brand asset',
      label_plural: 'Brand assets',
      color: 1,
      consequence: 'high',
      anchor: { match: 'subkind', values: ['logo'] },
      description:
        'A named visual-identity asset family: the logo, a color palette, the typography ' +
        'set, an icon set, an illustration/imagery/motion style. ONE node per asset ' +
        'family — versions and variants live INSIDE the node as the usage map. EVERY ' +
        'identity section of a brand book (Logo, Color, Typography, Iconography, …) ' +
        'yields its brand_asset node — emit the asset node even when its rules are also ' +
        'extracted as guidelines; the asset (with its link) and the rules are separate ' +
        'canon. Title: the asset name in ≤6 words (e.g. "Primary logo", "Brand color ' +
        'palette").\n\n' +
        'ASSET LINK RULE (binding here): the body is a USAGE MAP — one line per ' +
        'version/variant in the form "<version> — <when to use it> — <link>" (e.g. ' +
        '"Mono white lockup — dark backgrounds, video overlays — figma.com/file/…?node=12"). ' +
        'When the source deprecates or replaces a prior version or family, that deprecation ' +
        'IS canon — add a usage-map line for it: "<old version/family> — DEPRECATED <date ' +
        'when stated>, <what to do with remaining instances> — <link if any>". ' +
        'ALWAYS mirror the canonical link into the asset_url attr — in conversations and ' +
        'reviews as much as formal documents. ' +
        'Set asset_url to the canonical source of truth. NEVER describe what the asset ' +
        'looks like — no shapes, colors-in-words, or style adjectives; the link carries ' +
        'the visual, the node carries usage. A palette node names the ROLES (primary, ' +
        'accent, surface) and links to the token source — never enumerates hex values. ' +
        'If the source provides no link, end the body with "No link in source." and ' +
        'flag yellow.\n\n' +
        'NOT a brand_asset: a design-system component built WITH the identity (→ ' +
        'component); a rule about where the identity may appear (→ guideline); the ' +
        'why behind the identity (→ principle). A redesigned asset replacing a prior ' +
        'one is a NEW status reading on the same family — status current → deprecated ' +
        'transitions are reversals: flag red.\n\n' +
        'brand_asset.subkind — choose ONE: logo, color_palette, typography, iconography, ' +
        'illustration, imagery, motion.',
      subkinds: [
        { key: 'logo', label: 'Logo', description: 'Logo / wordmark / app-icon family and its version usage map.' },
        { key: 'color_palette', label: 'Color palette', description: 'A palette: role names + link to the token source, never hex enumerations.' },
        { key: 'typography', label: 'Typography', description: 'The typeface set and each face\'s role.' },
        { key: 'iconography', label: 'Iconography', description: 'An icon set and its usage rules.' },
        { key: 'illustration', label: 'Illustration', description: 'An illustration style/library.' },
        { key: 'imagery', label: 'Imagery', description: 'A photography/imagery style/library.' },
        { key: 'motion', label: 'Motion', description: 'A motion/animation style or library.' },
      ],
      attrs: [
        {
          key: 'asset_url',
          label: 'Asset link',
          type: 'string',
          description:
            'Link/URI to the canonical artifact source of truth (Figma, brand portal, Drive, repo path). ' +
            'Required whenever the source provides one — a brand_asset without it is incomplete (flag yellow).',
        },
        { key: 'product', label: 'Product', type: 'string', description: 'The product/brand SHORT NAME, lowercase; omit when studio-wide.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['current', 'deprecated'], description: 'current is the default reading; a replacement deprecates the old family (red flag).' },
      ],
      buckets: [
        { key: 'logo', label: 'Logos', match: 'subkind' },
        { key: 'color_palette', label: 'Color', match: 'subkind' },
        { key: 'typography', label: 'Type', match: 'subkind' },
        { key: 'iconography', label: 'Icons', match: 'subkind' },
        { key: 'illustration', label: 'Illustration', match: 'subkind' },
        { key: 'imagery', label: 'Imagery', match: 'subkind' },
        { key: 'motion', label: 'Motion', match: 'subkind' },
      ],
    },
    {
      key: 'component',
      label: 'Component',
      label_plural: 'Design system',
      color: 2,
      consequence: 'medium',
      description:
        'A named design-system component, reusable pattern, or template and its usage ' +
        'rule. Title: the component/pattern name in ≤6 words (e.g. "Primary button", ' +
        '"Empty-state pattern").\n\n' +
        'ASSET LINK RULE (binding here): body = the usage rule (when to use it, when ' +
        'not, which variant where) with one line per variant in the form "<variant> — ' +
        '<when to use it> — <link>"; set asset_url to where the component lives ' +
        '(Figma library frame, Storybook page). NEVER describe its appearance — no ' +
        'paddings, radii, or colors-in-words; the link carries the visual. If the ' +
        'source provides no link, end the body with "No link in source." and flag ' +
        'yellow.\n\n' +
        'NOT a component: an identity asset it is built with (→ brand_asset); a rule ' +
        'that spans components ("all touch targets ≥44px") (→ guideline); one screen ' +
        'using it (→ surface). Deprecating or replacing a component is a status ' +
        'reversal: flag red.\n\n' +
        'component.subkind — choose ONE: component, pattern, template.',
      subkinds: [
        { key: 'component', label: 'Component', description: 'A single named UI component and its variants.' },
        { key: 'pattern', label: 'Pattern', description: 'A reusable multi-component solution (e.g. empty states, bulk select).' },
        { key: 'template', label: 'Template', description: 'A page/screen template or layout scaffold.' },
      ],
      attrs: [
        {
          key: 'asset_url',
          label: 'Asset link',
          type: 'string',
          description:
            'Link/URI to where the component lives (Figma library, Storybook). Required whenever the ' +
            'source provides one — a component without it is incomplete (flag yellow).',
        },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when the design system spans products.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['draft', 'adopted', 'deprecated'], description: 'adopted is the default reading when stated as settled; deprecation is a reversal (red flag).' },
      ],
      buckets: [
        { key: 'draft', label: 'Draft', match: 'status' },
        { key: 'adopted', label: 'Adopted', match: 'status' },
        { key: 'deprecated', label: 'Deprecated', match: 'status' },
      ],
    },
    {
      key: 'surface',
      label: 'Surface',
      label_plural: 'Surfaces',
      color: 4,
      consequence: 'low',
      description:
        'A piece of design work as an artifact: a screen, a user flow, or a prototype ' +
        'being designed, reviewed, or shipped. Title: the surface name in ≤6 words ' +
        '(e.g. "Onboarding flow v3", "Checkout — payment screen").\n\n' +
        'ASSET LINK RULE (binding here): set asset_url to the artifact (Figma frame, ' +
        'prototype URL); body = what the surface covers, its intent, and its review ' +
        'state — NEVER a walkthrough of how it looks. If the source provides no link, ' +
        'end the body with "No link in source." and flag yellow.\n\n' +
        'NOT a surface: the feedback on it (→ critique); the component it instantiates ' +
        '(→ component); the project it belongs to (→ project). Status changes ' +
        '(approved → back to exploring) are reversals: flag red.\n\n' +
        'THE WORK UNDER REVIEW IS ALWAYS A SURFACE: when the source is a review, crit, ' +
        'or spec of a named screen/flow/prototype, ALWAYS emit that surface node — its ' +
        'link as asset_url and its review status — even when the source spends all its ' +
        'words on the feedback. It is the anchor the critiques bind to; a review ' +
        'document that yields critiques but no surface is an extraction failure.\n\n' +
        'surface.subkind — choose ONE: screen, flow, prototype.',
      subkinds: [
        { key: 'screen', label: 'Screen', description: 'A single screen/page design.' },
        { key: 'flow', label: 'Flow', description: 'A multi-step user flow design.' },
        { key: 'prototype', label: 'Prototype', description: 'An interactive prototype.' },
      ],
      attrs: [
        { key: 'asset_url', label: 'Asset link', type: 'string', description: 'Link to the artifact (Figma frame, prototype URL). Required whenever the source provides one.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit only when genuinely cross-product.' },
        { key: 'project', label: 'Project', type: 'string', description: 'The design project this work belongs to, when named.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['exploring', 'in_review', 'approved', 'shipped'], description: 'Read from the source; approval reversals flag red.' },
      ],
      buckets: [
        { key: 'exploring', label: 'Exploring', match: 'status' },
        { key: 'in_review', label: 'In review', match: 'status' },
        { key: 'approved', label: 'Approved', match: 'status' },
        { key: 'shipped', label: 'Shipped', match: 'status' },
      ],
    },
    {
      key: 'project',
      label: 'Project',
      label_plural: 'Projects',
      color: 4,
      consequence: 'low',
      description:
        'A design project/initiative as an entity: its goal, scope, status, and dates ' +
        '(e.g. "Onboarding redesign", "Design-system refresh"). Title: the project name ' +
        'in ≤5 words. Body: the design goal and scope as stated.\n\n' +
        'NOT a project: the individual surfaces inside it (→ surface, with the project ' +
        'attr set); feedback given within it (→ critique). Health/status changes ' +
        '(active → paused) are reversals: flag red.\n\n' +
        'Always set the project attr to the project\'s own SHORT NAME, lowercase — ' +
        'work nodes reference it by that name.',
      attrs: [
        { key: 'project', label: 'Project', type: 'string', description: 'The project\'s own short name, lowercase. Required.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when cross-product.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['discovery', 'active', 'in_review', 'shipped', 'paused'] },
        { key: 'due', label: 'Due', type: 'date', description: 'Target date, when stated.' },
      ],
      buckets: [
        { key: 'discovery', label: 'Discovery', match: 'status' },
        { key: 'active', label: 'Active', match: 'status' },
        { key: 'in_review', label: 'In review', match: 'status' },
        { key: 'shipped', label: 'Shipped', match: 'status' },
      ],
    },
    {
      key: 'guideline',
      label: 'Guideline',
      label_plural: 'Guidelines',
      color: 2,
      consequence: 'medium',
      description:
        'A binding design rule CHECKABLE ON A RENDERED SCREEN — "does this surface ' +
        'comply?": layout/grid/spacing rules, accessibility standards, content/voice ' +
        'rules for UI copy, motion rules, platform conventions, and visual-application ' +
        'rules (where the accent may appear, imagery register). A rule phrased as a ' +
        'restriction or never-do is STILL a guideline. Title: the rule in ≤8 words. ' +
        'Capture the rule and its NAMED elements (role names, component names) — never ' +
        'raw token values (hex codes, px scales); when the rule lives in a linked ' +
        'standard (WCAG section, spec page), include the link in the body.\n\n' +
        'NOT a guideline: the why-level principle behind it — guides choices but is ' +
        'not checkable on one screen (→ principle, subkind design_principle); the ' +
        'asset or component the rule applies to (→ brand_asset / component, with the ' +
        'rule in ITS usage map when it is version- or variant-specific); an imposed ' +
        'external limit (→ constraint). When torn between guideline and ' +
        'design_principle, choose guideline.\n\n' +
        'guideline.subkind — choose ONE: visual, layout, accessibility, content, ' +
        'motion, platform.',
      subkinds: [
        { key: 'visual', label: 'Visual', description: 'Visual-application rules: accent placement, imagery register, elevation.' },
        { key: 'layout', label: 'Layout', description: 'Grid, spacing, density, alignment rules.' },
        { key: 'accessibility', label: 'Accessibility', description: 'Contrast, target size, focus, screen-reader, motion-sensitivity rules.' },
        { key: 'content', label: 'Content', description: 'UX-writing/microcopy rules: tone, terminology, label form.' },
        { key: 'motion', label: 'Motion', description: 'Animation purpose, duration/easing rules.' },
        { key: 'platform', label: 'Platform', description: 'Platform-convention rules (HIG/Material, responsive, input modality).' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when it governs all products (shared standards).' },
        { key: 'status', label: 'Status', type: 'enum', values: ['adopted', 'retired'], description: 'adopted is the default reading; retiring a rule is a reversal (red flag).' },
      ],
      buckets: [
        { key: 'visual', label: 'Visual', match: 'subkind' },
        { key: 'layout', label: 'Layout', match: 'subkind' },
        { key: 'accessibility', label: 'Accessibility', match: 'subkind' },
        { key: 'content', label: 'Content', match: 'subkind' },
        { key: 'motion', label: 'Motion', match: 'subkind' },
        { key: 'platform', label: 'Platform', match: 'subkind' },
      ],
    },
    {
      key: 'principle',
      label: 'Principle',
      label_plural: 'Principles',
      color: 1,
      consequence: 'medium',
      description:
        'A durable why-level rule the design team holds itself to, a quality bar, a ' +
        'process rule, or a canonical definition. Timeless guidance, not a dated ' +
        'choice. Fan numbered/bulleted principle lists into one node per item.\n\n' +
        'NOT a principle (most common leak): a rule checkable on a rendered screen — ' +
        'accent placement, spacing, contrast, copy form — those are guideline, however ' +
        'principled they sound. THE TELL: if it names a concrete visual element and ' +
        'where/how it appears, it is a guideline. When torn, choose guideline.\n\n' +
        'principle.subkind — choose ONE:\n' +
        '- design_principle: why-level guidance shaping design choices across surfaces ' +
        '("clarity over cleverness", "structure carries information, not decoration").\n' +
        '- quality_bar: a bar design work must clear before it ships.\n' +
        '- process_rule: how the design team operates — crit etiquette, handoff rules, ' +
        'approval rules, file-hygiene conventions.\n' +
        '- definition: a canonical term or naming rule ("it\'s surfaces, not pages").',
      subkinds: [
        { key: 'design_principle', label: 'Design principle', description: 'Why-level guidance for design choices — never a screen-checkable rule.' },
        { key: 'quality_bar', label: 'Quality bar', description: 'A bar design work must clear.' },
        { key: 'process_rule', label: 'Process rule', description: 'How the design team operates: crit, handoff, approval, file hygiene.' },
        { key: 'definition', label: 'Definition', description: 'A canonical term or naming rule.' },
      ],
      attrs: [{ key: 'product', label: 'Product', type: 'string', description: 'Omit when studio-wide (most principles are).' }],
    },
    {
      key: 'critique',
      label: 'Critique',
      label_plural: 'Critiques',
      color: 3,
      consequence: 'medium',
      description:
        'A SETTLED piece of review feedback on a specific piece of design work — given ' +
        'by a reviewer and accepted, acted on, or explicitly waived. One node per ' +
        'distinct point of feedback; never bundle a whole review into one node. Title: ' +
        'the target + the point in ≤10 words (e.g. "Checkout — primary action lacks ' +
        'hierarchy").\n\n' +
        'Body: the feedback point and its rationale; when the reviewer cited a ' +
        'guideline, principle, or finding, name it. Set target to the surface/' +
        'component/asset reviewed, category to the feedback dimension, severity to its ' +
        'weight, and status to its resolution state. Status reversals (addressed → ' +
        'reopened, or new work reintroducing a resolved issue) flag red.\n\n' +
        'NOT a critique: in-flight back-and-forth that never settled (not canon); a ' +
        'reviewer\'s rule stated as binding for ALL work ("all touch targets ≥44px") ' +
        '(→ guideline); a usability finding from research (→ insight); praise alone ' +
        'IS capturable — severity praise — when it marks a pattern worth repeating.\n\n' +
        'critique.category — the dimension reviewed — choose ONE: framing, structure, ' +
        'interaction, visual, content, consistency, accessibility, feasibility, craft.',
      categories: [
        { key: 'framing', label: 'Problem framing', description: 'Solving the right problem; user/goal fit; scope.' },
        { key: 'structure', label: 'Structure & IA', description: 'Information architecture, mental model, flow design.' },
        { key: 'interaction', label: 'Interaction', description: 'Affordances, feedback, states, error handling, responsiveness.' },
        { key: 'visual', label: 'Visual', description: 'Layout, hierarchy, typography, color, spacing, depth.' },
        { key: 'content', label: 'Content', description: 'Microcopy, tone, terminology, scannability.' },
        { key: 'consistency', label: 'Consistency', description: 'Design-system adherence, pattern reuse, token usage.' },
        { key: 'accessibility', label: 'Accessibility', description: 'Contrast, targets, keyboard, screen reader, cognitive load.' },
        { key: 'feasibility', label: 'Feasibility', description: 'Buildability, performance, spec completeness, edge cases.' },
        { key: 'craft', label: 'Craft', description: 'Polish, pixel alignment, optical adjustments, finish.' },
      ],
      attrs: [
        { key: 'target', label: 'Target', type: 'string', description: 'The surface/component/asset the feedback is about. Required.' },
        { key: 'severity', label: 'Severity', type: 'enum', values: ['blocking', 'recommendation', 'suggestion', 'praise'], description: 'blocking = must fix before ship; praise = a pattern to repeat.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['open', 'addressed', 'waived'], description: 'Resolution state; reopening or regressing an addressed critique flags red.' },
        { key: 'reviewer', label: 'Reviewer', type: 'string', description: 'Who gave the feedback, when stated.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when cross-product.' },
        { key: 'project', label: 'Project', type: 'string', description: 'The project the reviewed work belongs to, when named.' },
      ],
      buckets: [
        { key: 'blocking', label: 'Blocking', match: 'severity' },
        { key: 'recommendation', label: 'Recommendations', match: 'severity' },
        { key: 'suggestion', label: 'Suggestions', match: 'severity' },
        { key: 'praise', label: 'Praise', match: 'severity' },
      ],
    },
    {
      key: 'decision',
      label: 'Decision',
      label_plural: 'Decisions',
      color: 5,
      consequence: 'high',
      description:
        'A dated one-off design choice not better captured by a more specific kind ' +
        '(see the decision tree — adopting an asset version is brand_asset, adopting ' +
        'a component is component, adopting a rule is guideline: the resulting entity ' +
        'IS the node, never a decision wrapper). What remains here: direction picks ' +
        '("concept B for onboarding"), tooling choices, brand-level calls, process ' +
        'changes. Title (≤12 words): imperative verb + object + key constraint.\n\n' +
        'decision.category — choose ONE: direction, system, brand, tooling, process.',
      categories: [
        { key: 'direction', label: 'Direction', description: 'Which concept/approach a piece of work takes.' },
        { key: 'system', label: 'System', description: 'Design-system governance calls.' },
        { key: 'brand', label: 'Brand', description: 'Brand-level calls.' },
        { key: 'tooling', label: 'Tooling', description: 'Design tooling and workflow choices.' },
        { key: 'process', label: 'Process', description: 'One-off process changes.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when studio-wide.' },
        { key: 'project', label: 'Project', type: 'string', description: 'The project it concerns, when named.' },
        { key: 'decided_on', label: 'Decided on', type: 'date' },
        { key: 'decided_by', label: 'Decided by', type: 'string' },
      ],
    },
    {
      key: 'constraint',
      label: 'Constraint',
      label_plural: 'Constraints',
      color: 3,
      consequence: 'medium',
      description:
        'An imposed "can\'t" — a limit from external reality, not a choice: technical ' +
        '(eng feasibility, performance budgets), brand-legal (trademark, licensing — ' +
        'incl. font/image licenses), platform (HIG/Material/store requirements), or ' +
        'resourcing. Title: the limit in ≤10 words.\n\n' +
        'NOT a constraint: a rule the team chose (→ guideline or principle); a ' +
        'reviewer\'s feasibility feedback on one piece of work (→ critique, category ' +
        'feasibility); a risk under discussion (not canon).\n\n' +
        'constraint.subkind — choose ONE: technical, brand_legal, platform, resourcing.',
      subkinds: [
        { key: 'technical', label: 'Technical', description: 'Engineering feasibility / performance limits.' },
        { key: 'brand_legal', label: 'Brand / legal', description: 'Trademark, licensing (fonts, imagery), regulatory.' },
        { key: 'platform', label: 'Platform', description: 'OS/store/platform requirements that bind design.' },
        { key: 'resourcing', label: 'Resourcing', description: 'Team/time/budget limits that bind design.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when studio-wide.' },
        { key: 'project', label: 'Project', type: 'string', description: 'The project it binds, when named.' },
      ],
    },
    {
      key: 'insight',
      label: 'Insight',
      label_plural: 'Insights',
      color: 6,
      consequence: 'low',
      description:
        'A durable, settled finding about users from usability testing, research, ' +
        'analytics, or an accessibility audit. Tag the study it came from and the ' +
        'segment it concerns when stated. In any multi-speaker source, evidence must ' +
        'originate from the PARTICIPANT/user — statements by the moderator or our own ' +
        'team never yield an insight.\n\n' +
        'NOT an insight: a reviewer\'s expert judgment in a crit (→ critique); a ' +
        'hypothesis not yet tested (not canon); a guideline derived from a finding ' +
        '(→ guideline, with this insight linked as its grounding).\n\n' +
        'ATTRS: set ONLY study, segment, product, project. NEVER a speaker attr — ' +
        'participants are anonymous evidence. `product` is the product/brand short ' +
        'name; a feature, screen, or flow area ("checkout") is NEVER a product — ' +
        'omit product unless the source names the actual product/brand.\n\n' +
        'insight.subkind — choose ONE: usability_finding, research_finding, ' +
        'accessibility_finding, experiment_result.',
      subkinds: [
        { key: 'usability_finding', label: 'Usability finding', description: 'A finding from usability testing.' },
        { key: 'research_finding', label: 'Research finding', description: 'A finding from generative/evaluative research or analytics.' },
        { key: 'accessibility_finding', label: 'Accessibility finding', description: 'A finding from an accessibility audit or assistive-tech testing.' },
        { key: 'experiment_result', label: 'Experiment result', description: 'An A/B or experiment outcome with its number.' },
      ],
      attrs: [
        { key: 'study', label: 'Study', type: 'string', description: 'The study/test that produced it, when stated.' },
        { key: 'segment', label: 'Segment', type: 'string', description: 'Which users it concerns.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when cross-product.' },
        { key: 'project', label: 'Project', type: 'string', description: 'The project it informs, when named.' },
      ],
    },
  ],
  feedback_dimensions: [
    {
      key: 'asset_fidelity',
      label: 'Asset fidelity',
      description:
        'uses the CURRENT version of every brand asset per its recorded usage map — the right logo ' +
        'version for the context, the current palette and typography roles; using a deprecated or ' +
        'superseded asset version is a red finding',
    },
    {
      key: 'system_consistency',
      label: 'System consistency',
      description:
        'components and patterns match the recorded design-system canon and its usage rules; does not ' +
        'reinvent a component or pattern where an adopted one exists',
    },
    {
      key: 'standards_compliance',
      label: 'Standards compliance',
      description: 'complies with adopted guidelines across visual, layout, accessibility, content, motion, and platform rules',
    },
    {
      key: 'principle_alignment',
      label: 'Principle alignment',
      description: 'aligns with recorded design principles and clears the recorded quality bars',
    },
    {
      key: 'feedback_follow_through',
      label: 'Feedback follow-through',
      description:
        'open blocking critiques on the same surface or component are addressed, not ignored; resolved ' +
        'critiques are not regressed by reintroducing the flagged issue',
    },
    {
      key: 'decision_consistency',
      label: 'Decision consistency',
      description: 'consistent with recorded design decisions and each project\'s chosen direction',
    },
    {
      key: 'constraint_respect',
      label: 'Constraint respect',
      description: 'respects imposed constraints — technical, brand-legal (incl. licensing), platform, resourcing',
    },
    {
      key: 'evidence_grounding',
      label: 'Evidence grounding',
      description: 'claims about users and usability are backed by recorded insights from the right study/segment, not assertion',
    },
    {
      key: 'link_integrity',
      label: 'Link integrity',
      description:
        'every visual artifact the work references or introduces is identified by LINK (matching or ' +
        'extending the recorded asset_url canon), never by prose description; new asset versions ship ' +
        'with links and usage rules',
    },
    { key: 'context_recency', label: 'Context recency', description: 'recent decisions, asset/component status changes, or findings the work should reflect' },
  ],
  review_kinds: [
    'screen_design',
    'flow_design',
    'prototype',
    'component_design',
    'brand_asset',
    'design_spec',
    'design_presentation',
    'marketing_creative',
    'ux_copy',
    'other',
  ],
  query_scopes: [
    { key: 'identity', label: 'Brand assets', kind_keys: ['brand_asset'] },
    { key: 'system', label: 'Design system', kind_keys: ['component'] },
    { key: 'canon', label: 'Visual canon', kind_keys: ['brand_asset', 'component'] },
    { key: 'standards', label: 'Guidelines & principles', kind_keys: ['guideline', 'principle'] },
    { key: 'work', label: 'Work in flight', kind_keys: ['surface', 'project'] },
    { key: 'feedback', label: 'Critiques', kind_keys: ['critique'] },
    { key: 'judgment', label: 'Decisions & constraints', kind_keys: ['decision', 'constraint'] },
    { key: 'evidence', label: 'Insights', kind_keys: ['insight'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  extraction_groups: [
    {
      key: 'canon',
      label: 'Visual canon',
      kind_keys: ['brand_asset', 'component'],
      description:
        'Named visual-identity assets (logos, palettes, typography, icon/illustration/imagery/motion styles) ' +
        'and design-system components/patterns — their links, versions, and usage rules.',
    },
    {
      key: 'standards',
      label: 'Standards',
      kind_keys: ['guideline', 'principle'],
      description:
        'Binding screen-checkable design rules (layout, accessibility, content, motion, platform, visual application) ' +
        'and why-level principles, quality bars, process rules.',
    },
    {
      key: 'work',
      label: 'Work in flight',
      kind_keys: ['surface', 'project'],
      description: 'Screens, flows, prototypes being designed (with links and review status) and design projects with their status.',
    },
    {
      key: 'judgment',
      label: 'Feedback & decisions',
      kind_keys: ['critique', 'decision', 'constraint'],
      description:
        'Settled review feedback on specific work (with dimension, severity, resolution), dated design choices, and imposed limits.',
    },
    {
      key: 'evidence',
      label: 'Insights',
      kind_keys: ['insight'],
      description: 'Usability, research, accessibility, and experiment findings about users.',
    },
  ],
  flag_semantics: {
    red:
      'contradicts the recorded canon — uses or reinstates a deprecated/superseded asset version or component, ' +
      'violates an adopted guideline or an imposed constraint, reverses a recorded decision, surface approval, ' +
      'or a settled critique resolution, or replaces a previously linked asset reference with a prose description',
    yellow:
      'hedged or low-conviction; a visual entity captured without a usable link ("No link in source."); user or ' +
      'usability claims without recorded evidence; implicitly settled conversational feedback',
    green: 'consistent with the canon: current linked assets, guideline-compliant, and evidence-backed where it makes user claims',
  },
  // Typed node↔node relations. Each answers a retrieval question: "what
  // feedback exists on X?", "which standard backs this feedback?", "where is
  // this component used?", "what replaced this asset?".
  edge_kinds: [
    {
      key: 'critiques',
      label: 'Critiques',
      description:
        'Review feedback pointing at the work it reviews: points FROM the critique TO the ONE surface, component, or ' +
        'brand asset its target attr names — the item under review. NEVER to assets, components, or rules merely ' +
        'mentioned in the critique\'s rationale (a critique about a screen that cites the accent rule still ' +
        'critiques ONLY the screen, not the palette or the button). Exactly one critiques edge per critique.',
      src_kinds: ['critique'],
      dst_kinds: ['surface', 'component', 'brand_asset'],
      directed: true,
    },
    {
      key: 'grounded_in',
      label: 'Grounded in',
      description:
        'The standard or evidence a piece of feedback invokes: points FROM the critique TO the guideline, principle, ' +
        'or insight whose rule the critique body EXPLICITLY names or quotes ("per the one-accent rule", "our 4.5:1 ' +
        'floor", "the second principle"). NEVER from topical similarity — a hierarchy critique does not ground in a ' +
        'contrast guideline, an error-message wording critique does not ground in a semantic-color rule. When unsure ' +
        'whether the critique cites it, emit NO edge.',
      src_kinds: ['critique'],
      dst_kinds: ['guideline', 'principle', 'insight'],
      directed: true,
    },
    {
      key: 'uses',
      label: 'Uses',
      description:
        'A surface instantiating canon: points FROM the surface TO the component or brand asset it uses — ' +
        'ONLY when the source states the usage, never inferred from the kind of surface it is.',
      src_kinds: ['surface'],
      dst_kinds: ['component', 'brand_asset'],
      directed: true,
    },
    {
      key: 'belongs_to',
      label: 'Belongs to',
      description:
        'Project scoping made explicit: points FROM a work node (surface, critique, decision, constraint, insight) ' +
        'TO the project it belongs to — only for nodes whose project attr or body names the project.',
      src_kinds: ['surface', 'critique', 'decision', 'constraint', 'insight'],
      dst_kinds: ['project'],
      directed: true,
      scope_attr: 'project',
    },
    {
      key: 'supersedes',
      label: 'Supersedes',
      description:
        'Version history for the visual canon: points FROM the newer brand asset or component TO the OLDER VERSION ' +
        'OF THE SAME THING it replaces. Both ends MUST be the same kind AND the same entity lineage — a typeface ' +
        'set never supersedes a usage rule about it, an asset never supersedes a component. Retired guidelines need ' +
        'no chain (their status carries it). Review binds to the active end; history stays queryable.',
      src_kinds: ['brand_asset', 'component'],
      dst_kinds: ['brand_asset', 'component'],
      directed: true,
    },
    {
      key: 'addresses',
      label: 'Addresses',
      description:
        'Work resolving recorded judgment or evidence: points FROM the surface or decision TO the critique or ' +
        'insight it responds to — ONLY when the source explicitly states that a NEWER revision or choice resolves ' +
        'that earlier feedback/finding ("this rework closes round 1\'s note"). NEVER because a finding or critique ' +
        'is merely ABOUT the surface — a finding that criticizes a screen is not addressed by that screen; that ' +
        'relation is critiques (or no edge at all for insights).',
      src_kinds: ['surface', 'decision'],
      dst_kinds: ['critique', 'insight'],
      directed: true,
    },
  ],
  // Source types this profile expects. The router classifies each document;
  // the matched type's extraction_guidance is injected into capture calls.
  source_types: [
    {
      key: 'brand_guidelines',
      label: 'Brand guidelines',
      description: 'A brand book, visual-identity guideline, or design-system documentation.',
      extraction_guidance:
        'This is the visual canon. APPLY THE ASSET LINK RULE STRICTLY: every asset and component node carries ' +
        'its asset_url and a usage map of "<version> — <when to use> — <link>" lines; capture usage rules and ' +
        'roles, NEVER visual descriptions or token value enumerations (hex/px) — link to the token source ' +
        'instead. Extract the screen-checkable rules as guidelines and the why-level statements as principles.',
      // The canon + standards groups ARE the point of ingesting a brand book.
      group_floor: ['canon', 'standards'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['brand_asset', 'component', 'guideline', 'principle'],
      triage_guidance:
        'Legitimate when it reads as adopted identity/system documentation (rules stated as binding, a source of ' +
        'truth identifiable). Decays: newer asset versions or rules in the graph win over an older brand book. ' +
        'Suspicious when asset references carry no links — a linkless brand book is likely an exploration deck.',
    },
    {
      key: 'design_spec',
      label: 'Design spec',
      description: 'A design spec, handoff document, or annotated mockup deck for a screen, flow, or component.',
      extraction_guidance:
        'This is a work artifact. Emit the surface node(s) with their links and review status per the ASSET LINK ' +
        'RULE; binding rules stated as system-wide become guidelines; spec-internal redlines and annotations on ' +
        'one screen are NOT guidelines. Embedded sample content (placeholder names, demo numbers) is never canon.',
      group_floor: ['work'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['surface', 'project', 'component', 'decision', 'constraint'],
      triage_guidance:
        'Legitimate when it reads as a handed-off spec (an identifiable surface, a link, a settled state). ' +
        'Exploration decks and option studies are not commit units. Decays: a spec contradicting newer surface ' +
        'status in the graph is the stale party.',
    },
    {
      key: 'design_review',
      label: 'Design review',
      description: 'A written design review, crit write-up, or feedback document on design work.',
      extraction_guidance:
        'This is a record of review judgment. Extract ONE critique node per distinct settled feedback point — ' +
        'never bundle a review into one node — with target, category (the dimension reviewed), severity ' +
        '(blocking/recommendation/suggestion/praise), and status. Capture only feedback given as concluded ' +
        'judgment; floated alternatives and questions the reviewer left open are not canon. A rule the reviewer ' +
        'states as binding for ALL work is a guideline; a finding they cite from research is an insight. ' +
        'ALWAYS emit (or refresh) the surface node for the work under review — its asset_url link and review ' +
        'status per the ASSET LINK RULE — it is the anchor the critiques bind to.',
      // Judgment is the point of a review doc; work carries the reviewed
      // surface the critiques anchor to — floor both.
      group_floor: ['judgment', 'work'],
      currency: 'point_in_time',
      authority_kinds: ['critique', 'decision', 'guideline'],
    },
    {
      key: 'crit_session',
      label: 'Crit session',
      description: 'A transcript of a live critique session, design review meeting, or portfolio walkthrough.',
      extraction_guidance:
        'This source is a LIVE CRIT TRANSCRIPT — multi-voice and exploratory by default. Capture only feedback ' +
        'that SETTLED in the room: the reviewer concluded a point and the designer accepted it, committed to a ' +
        'change, or it was explicitly waived; reactions mid-exploration ("hmm, what if…") stay out. One critique ' +
        'node per settled point, with target, category, and severity read from how it was delivered. End each ' +
        'candidate body with one sentence naming who gave the feedback and how it settled. Set confidence ≤ 0.8; ' +
        'flag yellow when the settlement was implicit. Decisions and guidelines settled in the session follow the ' +
        'same care.',
      source_kinds: ['transcript'],
      group_floor: ['judgment'],
      currency: 'point_in_time',
      authority_kinds: ['critique', 'decision', 'insight'],
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between teammates.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from design-team chat: settled feedback on named work (with severity as delivered), ' +
          'asset or component version changes ("v3 logo is now in the library: <link>"), adopted rules, and dated ' +
          'direction calls. KIND CARE: a settled screen-checkable rule is a guideline — never a principle, even ' +
          'when phrased "let\'s make it a rule"; a link shared for a new asset version updates the brand_asset ' +
          'usage map per the ASSET LINK RULE — capture the link and when each version applies, never how it looks.',
      ),
      source_kinds: ['slack'],
      // Design chat settles judgment (feedback, decisions) AND rules
      // (guidelines) — the 04-06-2026 golden run lost a settled toast rule
      // when the router skipped standards; floor both.
      group_floor: ['judgment', 'standards'],
      currency: 'point_in_time',
    },
    {
      key: 'research_report',
      label: 'Research report',
      description: 'A usability test report, research summary, accessibility audit, or experiment write-up.',
      extraction_guidance:
        'Emit one insight per finding, with its study attr set to the study/test name and segment set to who the ' +
        'evidence concerns. Findings about a specific surface keep the surface name in the body so the edge can ' +
        'bind. Moderator/team commentary is not evidence. Set ONLY the declared attrs (study, segment, product, ' +
        'project) — participants are anonymous evidence; never add a speaker or moderator attr.',
      group_floor: ['evidence'],
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['insight'],
      triage_guidance:
        'Legitimate when it is a finished write-up (a study and method identifiable, findings stated as ' +
        'conclusions). Authoritative for evidence only — any judgment or canon nodes it yields need individual eyes.',
    },
  ],
  seed_questions: [
    'What is the current logo, which versions exist, and where do the files live?',
    'Which logo version is used on dark backgrounds?',
    'Where is the canonical color palette defined, and what are its usage rules?',
    'What usage rules govern the primary button component, and where does it live?',
    'What open blocking feedback exists on the onboarding flow?',
    'What design principles and quality bars does the team hold work to?',
    'Which accessibility guidelines are binding?',
    'What did the last usability test find, and which surfaces did it concern?',
    'What design projects are in flight, and what is each one\'s status?',
  ],
};
