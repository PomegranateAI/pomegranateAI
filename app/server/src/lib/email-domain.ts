/**
 * Email-domain policy — which email domains stand for an ORGANISATION.
 *
 * Several deliberately cross-workspace surfaces read "shares my email domain"
 * as "is my colleague": the folder explorer (`GET /team/directory`, the MCP
 * `list_team` / `explore_team_folders` tools), the team leaderboard, the
 * folder-reference resolver, and request-access. That reading holds for a
 * company domain and is plainly wrong for a public mailbox provider — two
 * strangers who both signed up with a gmail.com address are not a team, and
 * must not find each other's folders in the explorer.
 *
 * So every domain is one of two kinds:
 *
 *   - `org`      — a company domain. Same domain = same organisation, which is
 *                  the behaviour every one of those surfaces already assumes.
 *   - `personal` — a public mailbox provider (gmail.com, outlook.com, …), or no
 *                  domain at all. Every such account is its own island: as far
 *                  as any surface is concerned the only person on the domain is
 *                  the account holder. Membership is then the only way into a
 *                  folder — an invite from its owner, which is unchanged.
 *
 * This list is a heuristic, not identity. The real boundary is the
 * `organizations` table plus a verified domain claim in
 * the internal design notes ("'The
 * team' is an emergent property of shared email domains"); until that ships,
 * this list *is* the boundary, so it fails closed: anything on it is personal,
 * and a company that genuinely runs on one of these providers opts back in
 * explicitly through `POMEGRANATE_ORG_EMAIL_DOMAINS`.
 *
 * Matching is exact on the full domain, lower-cased. Subdomains are not
 * folded in (`gmail.com.example.org` is somebody's own domain, not Gmail), so
 * every variant a provider actually hands out is listed below.
 *
 * Env overrides (both accept a comma/space/semicolon-separated list, with or
 * without a leading `@`):
 *   - `POMEGRANATE_PERSONAL_EMAIL_DOMAINS` — extra providers to treat as
 *     personal, for a domain this list has not caught up with.
 *   - `POMEGRANATE_ORG_EMAIL_DOMAINS` — domains to treat as an org even when
 *     listed here. Wins over both lists above; the escape hatch for a team
 *     whose real company mail lives on a public provider.
 */

/**
 * Public mailbox providers: free/consumer webmail, ISP mailboxes, and the
 * privacy mail services. Grouped by family so additions land in the right
 * place; keep each group alphabetical.
 */
const BUILTIN_PERSONAL_EMAIL_DOMAINS: readonly string[] = [
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'hotmail.co.uk',
  'hotmail.com',
  'hotmail.fr',
  'hotmail.it',
  'live.co.uk',
  'live.com',
  'live.fr',
  'msn.com',
  'outlook.com',
  'outlook.fr',
  'passport.com',
  // Yahoo / AOL
  'aol.com',
  'aol.co.uk',
  'rocketmail.com',
  'yahoo.co.in',
  'yahoo.co.jp',
  'yahoo.co.uk',
  'yahoo.com',
  'yahoo.com.br',
  'yahoo.de',
  'yahoo.es',
  'yahoo.fr',
  'yahoo.it',
  'ymail.com',
  // Apple
  'icloud.com',
  'mac.com',
  'me.com',
  // Privacy-first / independent providers
  'fastmail.com',
  'fastmail.fm',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'hey.com',
  'hushmail.com',
  'mail.com',
  'mailfence.com',
  'pm.me',
  'posteo.de',
  'proton.me',
  'protonmail.ch',
  'protonmail.com',
  'runbox.com',
  'tuta.com',
  'tutanota.com',
  'tutanota.de',
  'zoho.com',
  'zohomail.com',
  // Europe
  'aliceadsl.fr',
  'bluewin.ch',
  'btinternet.com',
  'blueyonder.co.uk',
  'earthlink.net',
  'free.fr',
  'freenet.de',
  'laposte.net',
  'libero.it',
  'mail.ru',
  'neuf.fr',
  'ntlworld.com',
  'online.no',
  'orange.fr',
  'seznam.cz',
  'sfr.fr',
  'sky.com',
  't-online.de',
  'talktalk.net',
  'telenet.be',
  'tin.it',
  'tiscali.it',
  'virgilio.it',
  'virginmedia.com',
  'wanadoo.fr',
  'web.de',
  'wp.pl',
  'yandex.com',
  'yandex.ru',
  // Asia
  '126.com',
  '163.com',
  'daum.net',
  'foxmail.com',
  'hanmail.net',
  'naver.com',
  'qq.com',
  'rediffmail.com',
  'sina.com',
  'sina.cn',
  // Americas / Oceania
  'att.net',
  'bellsouth.net',
  'bigpond.com',
  'bigpond.net.au',
  'bol.com.br',
  'charter.net',
  'comcast.net',
  'cox.net',
  'frontier.com',
  'juno.com',
  'optonline.net',
  'optusnet.com.au',
  'rogers.com',
  'sbcglobal.net',
  'shaw.ca',
  'sympatico.ca',
  'telus.net',
  'terra.com.br',
  'uol.com.br',
  'verizon.net',
  'videotron.ca',
  'xtra.co.nz',
];

/** Which side of the org boundary a domain falls on. */
export type DomainKind = 'org' | 'personal';

/** Split an env list on commas / semicolons / whitespace; `@acme.com` → `acme.com`. */
function parseDomainList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .toLowerCase()
      .split(/[\s,;]+/)
      .map((d) => d.trim().replace(/^@/, ''))
      .filter(Boolean),
  );
}

// Env is read lazily and memoised on the raw strings, so a deploy (or a test)
// that sets either variable takes effect without a module reload, and the
// normal path does no work per call.
let cached: { personalRaw: string; orgRaw: string; personal: Set<string>; org: Set<string> } | null = null;

function lists(): { personal: Set<string>; org: Set<string> } {
  const personalRaw = process.env.POMEGRANATE_PERSONAL_EMAIL_DOMAINS ?? '';
  const orgRaw = process.env.POMEGRANATE_ORG_EMAIL_DOMAINS ?? '';
  if (!cached || cached.personalRaw !== personalRaw || cached.orgRaw !== orgRaw) {
    const personal = new Set(BUILTIN_PERSONAL_EMAIL_DOMAINS);
    for (const d of parseDomainList(personalRaw)) personal.add(d);
    cached = { personalRaw, orgRaw, personal, org: parseDomainList(orgRaw) };
  }
  return cached;
}

/**
 * The domain part of an email address, lower-cased and trimmed; `''` when
 * there isn't one. Split on the LAST `@` — the local part may legally quote one.
 */
export function emailDomain(email: string | null | undefined): string {
  const norm = (email ?? '').trim().toLowerCase();
  const at = norm.lastIndexOf('@');
  if (at < 0 || at === norm.length - 1) return '';
  return norm.slice(at + 1);
}

/**
 * True when the domain is a public mailbox provider (or absent) — i.e. sharing
 * it says nothing about who you work with. An empty domain counts as personal:
 * "no domain" is never an org.
 */
export function isPersonalEmailDomain(domain: string | null | undefined): boolean {
  const d = (domain ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!d) return true;
  const { personal, org } = lists();
  if (org.has(d)) return false;
  return personal.has(d);
}

/** True when the domain may act as an org boundary (a real company domain). */
export function isOrgEmailDomain(domain: string | null | undefined): boolean {
  return !isPersonalEmailDomain(domain);
}

export function domainKind(domain: string | null | undefined): DomainKind {
  return isPersonalEmailDomain(domain) ? 'personal' : 'org';
}

/**
 * True when two addresses belong to the same organisation. Identical personal
 * domains are NOT the same org — that is the whole point: `a@gmail.com` and
 * `b@gmail.com` are strangers.
 */
export function sameOrgDomain(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = emailDomain(a);
  if (!da || da !== emailDomain(b)) return false;
  return isOrgEmailDomain(da);
}

/** The built-in list, for tests and diagnostics. Env overrides are not applied. */
export function builtinPersonalEmailDomains(): readonly string[] {
  return BUILTIN_PERSONAL_EMAIL_DOMAINS;
}
