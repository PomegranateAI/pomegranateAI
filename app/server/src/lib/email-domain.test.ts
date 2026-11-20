import { describe, it, expect, afterEach } from 'vitest';
import {
  builtinPersonalEmailDomains,
  domainKind,
  emailDomain,
  isOrgEmailDomain,
  isPersonalEmailDomain,
  sameOrgDomain,
} from './email-domain.js';

// The org boundary every cross-workspace surface reads: a company domain means
// "colleague", a public mailbox provider means nothing at all.

afterEach(() => {
  delete process.env.POMEGRANATE_PERSONAL_EMAIL_DOMAINS;
  delete process.env.POMEGRANATE_ORG_EMAIL_DOMAINS;
});

describe('emailDomain', () => {
  it('lower-cases, trims, and splits on the last @', () => {
    expect(emailDomain('Ada@Acme.COM')).toBe('acme.com');
    expect(emailDomain('  ada@acme.com  ')).toBe('acme.com');
    expect(emailDomain('"a@b"@acme.com')).toBe('acme.com');
  });

  it('is empty for anything without a domain', () => {
    for (const bad of ['', '   ', 'ada', 'ada@', null, undefined]) {
      expect(emailDomain(bad)).toBe('');
    }
  });
});

describe('personal vs org domains', () => {
  it('treats the big consumer providers as personal', () => {
    for (const d of [
      'gmail.com',
      'googlemail.com',
      'outlook.com',
      'hotmail.com',
      'live.com',
      'yahoo.com',
      'yahoo.co.uk',
      'aol.com',
      'icloud.com',
      'me.com',
      'proton.me',
      'protonmail.com',
      'gmx.de',
      'yandex.ru',
      'qq.com',
      'comcast.net',
    ]) {
      expect(isPersonalEmailDomain(d), d).toBe(true);
      expect(isOrgEmailDomain(d), d).toBe(false);
      expect(domainKind(d)).toBe('personal');
    }
  });

  it('treats a company domain as an org', () => {
    for (const d of ['acme.com', 'example.org', 'mailchimp.com', 'gmail.acme.com']) {
      expect(isPersonalEmailDomain(d), d).toBe(false);
      expect(isOrgEmailDomain(d), d).toBe(true);
      expect(domainKind(d)).toBe('org');
    }
  });

  it('matches exactly: a subdomain of a provider is somebody else’s domain', () => {
    // Only the provider's own domains are personal — `gmail.com.evil.co` and
    // `mail.gmail.com` are not addresses Google hands out.
    expect(isPersonalEmailDomain('gmail.com.evil.co')).toBe(false);
    expect(isPersonalEmailDomain('mail.gmail.com')).toBe(false);
  });

  it('normalizes case, whitespace and a leading @; no domain is never an org', () => {
    expect(isPersonalEmailDomain(' @Gmail.COM ')).toBe(true);
    expect(isPersonalEmailDomain('')).toBe(true);
    expect(isPersonalEmailDomain(null)).toBe(true);
    expect(isOrgEmailDomain('')).toBe(false);
  });

  it('has a de-duplicated, lower-case built-in list', () => {
    const list = builtinPersonalEmailDomains();
    expect(new Set(list).size).toBe(list.length);
    expect(list.every((d) => d === d.toLowerCase().trim())).toBe(true);
    expect(list.length).toBeGreaterThan(50);
  });
});

describe('sameOrgDomain', () => {
  it('is true only for two addresses on the same company domain', () => {
    expect(sameOrgDomain('ada@acme.com', 'ben@acme.com')).toBe(true);
    expect(sameOrgDomain('ada@ACME.com', 'ben@acme.COM')).toBe(true);
    expect(sameOrgDomain('ada@acme.com', 'zoe@other.com')).toBe(false);
  });

  it('is false for identical personal domains — strangers, not colleagues', () => {
    expect(sameOrgDomain('ada@gmail.com', 'ben@gmail.com')).toBe(false);
    expect(sameOrgDomain('ada@outlook.com', 'ben@outlook.com')).toBe(false);
    // Even for the very same person's address: "same org" is about the domain
    // carrying an org, and a provider never does.
    expect(sameOrgDomain('ada@gmail.com', 'ada@gmail.com')).toBe(false);
  });

  it('is false when either side has no domain', () => {
    expect(sameOrgDomain('ada', 'ben@acme.com')).toBe(false);
    expect(sameOrgDomain('', '')).toBe(false);
  });
});

describe('env overrides', () => {
  it('POMEGRANATE_PERSONAL_EMAIL_DOMAINS adds providers the list missed', () => {
    process.env.POMEGRANATE_PERSONAL_EMAIL_DOMAINS = '@newmail.example, other.example';
    expect(isPersonalEmailDomain('newmail.example')).toBe(true);
    expect(isPersonalEmailDomain('other.example')).toBe(true);
    expect(sameOrgDomain('a@newmail.example', 'b@newmail.example')).toBe(false);
    // Unrelated domains are untouched.
    expect(isPersonalEmailDomain('acme.com')).toBe(false);
  });

  it('POMEGRANATE_ORG_EMAIL_DOMAINS wins, so a team really on a provider opts back in', () => {
    process.env.POMEGRANATE_ORG_EMAIL_DOMAINS = 'gmail.com';
    expect(isPersonalEmailDomain('gmail.com')).toBe(false);
    expect(sameOrgDomain('ada@gmail.com', 'ben@gmail.com')).toBe(true);
    // And it beats the personal override too.
    process.env.POMEGRANATE_PERSONAL_EMAIL_DOMAINS = 'gmail.com';
    expect(domainKind('gmail.com')).toBe('org');
  });

  it('picks up a change to either variable without a reload (memo keyed on the value)', () => {
    expect(isPersonalEmailDomain('late.example')).toBe(false);
    process.env.POMEGRANATE_PERSONAL_EMAIL_DOMAINS = 'late.example';
    expect(isPersonalEmailDomain('late.example')).toBe(true);
    delete process.env.POMEGRANATE_PERSONAL_EMAIL_DOMAINS;
    expect(isPersonalEmailDomain('late.example')).toBe(false);
  });
});
