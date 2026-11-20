/**
 * The DATA the multi-subgraph router weighs — not the LLM call itself. The
 * router under-routed (vision.md → product only; plan.md → product only)
 * because each profile's `description` is a comprehensive extraction charter
 * that overlaps its neighbors, so one subgraph looked sufficient and the router
 * never fanned out. The fix is a discriminative `routing_hint` per profile that
 * names the SHARED ZONES, plus an intersection-aware system prompt. These tests
 * lock the routing surface (which is pure) without paying for the API.
 */
import { describe, it, expect } from 'vitest';
import {
  subgraphRoutingAbout,
  buildSubgraphRouteCatalog,
  SUBGRAPH_ROUTE_SYSTEM,
  type RouteSubgraph,
} from './anthropic.js';
import { productProfile } from './profiles/__fixtures__/product.js';
import { marketingProfile } from './profiles/__fixtures__/marketing.js';
import { programProfile } from './profiles/__fixtures__/program.js';
import { foundingProfile } from './profiles/__fixtures__/founding.js';
import { marketingComplianceProfile } from './profiles/__fixtures__/marketing-compliance.js';
import { designerProfile } from './profiles/__fixtures__/designer.js';

const BUILTINS = [
  productProfile,
  marketingProfile,
  programProfile,
  foundingProfile,
  marketingComplianceProfile,
  designerProfile,
];

describe('subgraphRoutingAbout', () => {
  it('prefers the routing_hint over the (overlapping) extraction charter', () => {
    const about = subgraphRoutingAbout({
      routingHint: 'SHORT discriminative hint',
      description: 'A very long comprehensive extraction charter that overlaps neighbors…',
    });
    expect(about).toBe('SHORT discriminative hint');
  });

  it('falls back to the description (capped) when no hint is set', () => {
    const long = 'x'.repeat(2000);
    const about = subgraphRoutingAbout({ description: long });
    expect(about.length).toBe(700);
  });

  it('never truncates a normal-length hint', () => {
    const hint = productProfile.routing_hint!;
    expect(subgraphRoutingAbout({ routingHint: hint })).toBe(hint);
    expect(hint.length).toBeLessThanOrEqual(700);
  });
});

describe('builtin profiles all carry a routing_hint', () => {
  for (const p of BUILTINS) {
    it(`${p.id} has a routing_hint`, () => {
      expect(p.routing_hint, `${p.id} must define routing_hint`).toBeTruthy();
    });
  }
});

describe('the routing surface names the intersections we care about', () => {
  it('product ∩ marketing (value proposition / positioning / competitors) is on BOTH sides', () => {
    const prod = productProfile.routing_hint!.toLowerCase();
    const mkt = marketingProfile.routing_hint!.toLowerCase();
    expect(prod).toMatch(/value proposition|positioning|competitor/);
    expect(prod).toContain('marketing'); // points at the neighbor
    expect(mkt).toMatch(/value proposition|positioning/);
    expect(mkt).toContain('product');
  });

  it('product ∩ program (execution / delivery status) is on BOTH sides', () => {
    const prod = productProfile.routing_hint!.toLowerCase();
    const prog = programProfile.routing_hint!.toLowerCase();
    expect(prod).toMatch(/delivered|delivery|status/);
    expect(prod).toContain('program');
    expect(prog).toMatch(/plan-vs-actual|planned vs|delivered|status/);
    expect(prog).toContain('product');
  });
});

describe('buildSubgraphRouteCatalog', () => {
  it('emits id/name/about per subgraph, using the hint as the about line', () => {
    const subs: RouteSubgraph[] = [
      { id: 'default', name: 'Product', description: 'long charter…', routingHint: 'product hint' },
      { id: 'sg_m', name: 'Marketing', description: 'long charter…', routingHint: 'marketing hint' },
    ];
    const catalog = buildSubgraphRouteCatalog(subs);
    expect(catalog).toContain('- id: default\n  name: Product\n  about: product hint');
    expect(catalog).toContain('- id: sg_m\n  name: Marketing\n  about: marketing hint');
    expect(catalog).not.toContain('long charter');
  });
});

describe('SUBGRAPH_ROUTE_SYSTEM (multi-routing prompt)', () => {
  it('forces one-at-a-time per-folder judgment and multi-routing on shared topics', () => {
    // Light (2026-07-17) rewrote this prompt in plainer terms — it no longer
    // uses the old "INDEPENDENTLY / shared zone / cross-cutting" vocabulary,
    // but the invariant these tests pin (a document can, and often should,
    // land in more than one folder) is unchanged. See route-to-subgraphs.md.
    expect(SUBGRAPH_ROUTE_SYSTEM.toLowerCase()).toContain('more than one folder');
    expect(SUBGRAPH_ROUTE_SYSTEM.toLowerCase()).toContain('one at a time');
    expect(SUBGRAPH_ROUTE_SYSTEM.toLowerCase()).toMatch(/product.*marketing|marketing.*product/s);
  });
});
