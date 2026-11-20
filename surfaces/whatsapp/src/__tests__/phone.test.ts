import { describe, expect, it } from 'vitest';
import { normalizePhoneDigits } from '../phone.js';

describe('normalizePhoneDigits', () => {
  it('strips +, spaces, dashes, and parens', () => {
    expect(normalizePhoneDigits('+1 (415) 555-0100')).toBe('14155550100');
  });

  it('strips a WhatsApp JID suffix', () => {
    expect(normalizePhoneDigits('14155550100@s.whatsapp.net')).toBe('14155550100');
    expect(normalizePhoneDigits('555555555@lid')).toBe('555555555');
  });

  it('is already-idempotent on a bare digit string', () => {
    expect(normalizePhoneDigits('14155550100')).toBe('14155550100');
  });

  it('returns empty string for input with no digits', () => {
    expect(normalizePhoneDigits('@g.us')).toBe('');
  });
});
