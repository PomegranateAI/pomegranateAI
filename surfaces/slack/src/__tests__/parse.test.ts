import { describe, it, expect } from 'vitest';
import { parseMention } from '../parse.js';
import { BadCommand, USAGE_HINT } from '../errors.js';

describe('parseMention', () => {
  it('parses a basic review command', () => {
    const cmd = parseMention('<@BOT> review from <@U_ALICE>', 'BOT');
    expect(cmd.verb).toBe('review');
    expect(cmd.subjectUserId).toBe('U_ALICE');
  });

  it('parses verb case variants', () => {
    expect(parseMention('<@BOT> Review from <@U_ALICE>', 'BOT').verb).toBe(
      'review',
    );
    expect(parseMention('<@BOT> REVIEW from <@U_ALICE>', 'BOT').verb).toBe(
      'review',
    );
  });

  it('parses getcontext, stripping verb/about/from from remainder', () => {
    const cmd = parseMention(
      '<@BOT> GetContext about our Q3 roadmap from <@U_ALICE>',
      'BOT',
    );
    expect(cmd.verb).toBe('getcontext');
    expect(cmd.subjectUserId).toBe('U_ALICE');
    expect(cmd.remainder).toContain('Q3 roadmap');
    expect(cmd.remainder.toLowerCase()).not.toContain('getcontext');
    expect(cmd.remainder.toLowerCase()).not.toContain('about');
    expect(cmd.remainder.toLowerCase()).not.toContain('from');
  });

  it('parses two-word `get context` to getcontext', () => {
    const cmd = parseMention(
      '<@BOT> get context about churn from <@U_ALICE>',
      'BOT',
    );
    expect(cmd.verb).toBe('getcontext');
    expect(cmd.subjectUserId).toBe('U_ALICE');
    expect(cmd.remainder).toBe('churn');
  });

  it('parses with the bot mention at the END', () => {
    const cmd = parseMention('review this doc from <@U_ALICE> <@BOT>', 'BOT');
    expect(cmd.verb).toBe('review');
    expect(cmd.subjectUserId).toBe('U_ALICE');
    expect(cmd.remainder).toBe('this doc');
  });

  it('throws BadCommand when `from` is missing', () => {
    try {
      parseMention('<@BOT> review this doc', 'BOT');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadCommand);
      expect((e as BadCommand).userMessage).toBe(USAGE_HINT);
    }
  });

  it('throws BadCommand when `from` has no user mention after it', () => {
    try {
      parseMention('<@BOT> review this doc from the team', 'BOT');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadCommand);
      expect((e as BadCommand).userMessage).toBe(USAGE_HINT);
    }
  });

  it('throws BadCommand for an unknown verb', () => {
    try {
      parseMention('hello from <@U_ALICE>', 'BOT');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadCommand);
      expect((e as BadCommand).userMessage).toBe(USAGE_HINT);
    }
  });

  it('builds remainder with verb + from-clause + bot mention stripped', () => {
    const cmd = parseMention(
      '<@BOT> review the launch email from <@U_ALICE>',
      'BOT',
    );
    expect(cmd.remainder).toBe('the launch email');
  });

  it('strips literal @pomegranate / pomegranate tokens', () => {
    const cmd = parseMention(
      '@pomegranate review the deck from <@U_ALICE>',
    );
    expect(cmd.verb).toBe('review');
    expect(cmd.subjectUserId).toBe('U_ALICE');
    expect(cmd.remainder).toBe('the deck');
  });

  it('picks the first mention after `from` as the subject', () => {
    const cmd = parseMention(
      '<@BOT> review for <@U_OTHER> from <@U_ALICE>',
      'BOT',
    );
    expect(cmd.subjectUserId).toBe('U_ALICE');
    expect(cmd.remainder).toContain('<@U_OTHER>');
  });

  it('handles piped mention syntax <@U_ALICE|henry>', () => {
    const cmd = parseMention('<@BOT> review from <@U_ALICE|henry>', 'BOT');
    expect(cmd.subjectUserId).toBe('U_ALICE');
  });

  describe('ingest audience (`as <…>`)', () => {
    it('parses each tier and strips it from the payload', () => {
      const only = parseMention('<@BOT> ingest as only me the roadmap memo', 'BOT');
      expect(only.verb).toBe('ingest');
      expect(only.audience).toBe('only_me');
      expect(only.remainder).toBe('the roadmap memo');

      expect(parseMention('<@BOT> ingest as private notes', 'BOT').audience).toBe('private');
      expect(parseMention('<@BOT> ingest as my AI notes', 'BOT').audience).toBe('private');
      expect(parseMention('<@BOT> ingest as team the plan', 'BOT').audience).toBe('team');
      // "only-me" / trailing colon variants normalize too.
      expect(parseMention('<@BOT> ingest as only-me: secret', 'BOT').audience).toBe('only_me');
    });

    it('leaves audience undefined and payload intact without an `as` prefix', () => {
      const cmd = parseMention('<@BOT> ingest team offsite recap and action items', 'BOT');
      expect(cmd.verb).toBe('ingest');
      // No bare-word swallow: "team" here is the first word of the document.
      expect(cmd.audience).toBeUndefined();
      expect(cmd.remainder).toBe('team offsite recap and action items');
    });
  });
});
