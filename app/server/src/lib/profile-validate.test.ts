import { describe, it, expect } from 'vitest';
import {
  validateNode,
  validateReviewKind,
  validateFeedbackCategory,
  validateScope,
} from './profile-validate.js';
import { foundingProfile } from './profiles/__fixtures__/founding.js';
import { marketingProfile } from './profiles/__fixtures__/marketing.js';
import { brandVoiceProfile } from './profiles/__fixtures__/brand_voice.js';
import type { Node } from './schemas.js';

const TS = '2026-01-01T00:00:00Z';

function pos(extra: Record<string, unknown>): Node {
  return {
    id: 'n1',
    type: 'positioning',
    created_at: TS,
    updated_at: TS,
    status: 'active',
    body: 'x',
    ...extra,
  } as unknown as Node;
}

describe('profile write-time validation', () => {
  it('accepts a valid founding positioning node (legacy `kind` field)', () => {
    expect(validateNode(foundingProfile, pos({ kind: 'killed_messaging' }))).toBeNull();
  });

  it('accepts a valid founding positioning node (generalized `subkind`)', () => {
    expect(validateNode(foundingProfile, pos({ subkind: 'stance' }))).toBeNull();
  });

  it('rejects a kind not in the profile', () => {
    const node = { ...pos({}), type: 'voice' } as unknown as Node;
    const err = validateNode(foundingProfile, node);
    expect(err).toMatch(/kind 'voice' is not in profile 'founding'/);
  });

  it('rejects a subkind not valid for the kind', () => {
    const err = validateNode(foundingProfile, pos({ subkind: 'not_a_real_subkind' }));
    expect(err).toMatch(/subkind 'not_a_real_subkind' is not valid/);
  });

  it('rejects a category not valid for the decision kind', () => {
    const node = {
      id: 'd1',
      type: 'decision',
      created_at: TS,
      updated_at: TS,
      status: 'active',
      summary: 's',
      body: 'b',
      decided_on: TS,
      category: 'bogus',
    } as unknown as Node;
    expect(validateNode(foundingProfile, node)).toMatch(/category 'bogus' is not valid/);
  });

  it('a brand_voice `lexicon` node passes against brand_voice but not marketing or founding', () => {
    const node = {
      id: 'v1',
      type: 'lexicon',
      created_at: TS,
      updated_at: TS,
      status: 'active',
      body: 'never say synergy',
      subkind: 'banned_phrase',
    } as unknown as Node;
    expect(validateNode(brandVoiceProfile, node)).toBeNull();
    // The v3 split: the voice canon is brand_voice's, not marketing's.
    expect(validateNode(marketingProfile, node)).not.toBeNull();
    expect(validateNode(foundingProfile, node)).not.toBeNull();
  });

  it('review kind / feedback category / scope validate against the profile', () => {
    expect(validateReviewKind(foundingProfile, 'prd')).toBeNull();
    expect(validateReviewKind(foundingProfile, 'blog_article')).toMatch(/not in profile/);
    expect(validateReviewKind(marketingProfile, 'blog_article')).toBeNull();

    expect(validateFeedbackCategory(foundingProfile, 'brand_voice')).toBeNull();
    expect(validateFeedbackCategory(foundingProfile, 'user_evidence')).toMatch(/not in profile/);

    expect(validateScope(foundingProfile, 'all')).toBeNull();
    expect(validateScope(foundingProfile, 'nope')).toMatch(/not in profile/);
  });
});
