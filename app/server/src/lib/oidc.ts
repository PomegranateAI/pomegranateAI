// OpenID Connect client for single sign-on: Microsoft Entra ID and
// Google Workspace (any standards-compliant OIDC provider).
//
// Authorization-code flow with PKCE and a nonce. The ID token is verified
// here with Node's crypto — signature against the provider's JWKS (RS256 /
// ES256), issuer, audience, expiry, nonce — so no OIDC library is trusted
// with the decision. Discovery and keys are cached and refetched on a key id
// miss (key rotation).

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Lower-case email domains allowed to sign in; empty = any (invitation still required). */
  allowedDomains: string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export class OidcError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function randomToken(): string {
  return b64url(randomBytes(24));
}

type Fetch = typeof fetch;

export class OidcClient {
  private discovery?: { at: number; doc: Discovery };
  private jwks?: { at: number; keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> };

  constructor(
    readonly config: OidcConfig,
    private readonly fetchImpl: Fetch = (...a) => globalThis.fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  /** Microsoft Entra's multi-tenant issuer carries {tenantid}; single-tenant config is exact. */
  private issuerMatches(iss: string, expected: string): boolean {
    return iss === expected || iss.replace(/\/$/, '') === expected.replace(/\/$/, '');
  }

  async discover(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.at < 3600_000) return this.discovery.doc;
    const url = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new OidcError('discovery_failed', String(res.status));
    const doc = (await res.json()) as Discovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new OidcError('discovery_incomplete');
    if (!this.issuerMatches(doc.issuer, this.config.issuer)) throw new OidcError('issuer_mismatch', doc.issuer);
    this.discovery = { at: this.now(), doc };
    return doc;
  }

  async authorizationUrl(opts: { state: string; nonce: string; codeChallenge: string; loginHint?: string }): Promise<string> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('redirect_uri', this.config.redirectUri);
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', opts.state);
    u.searchParams.set('nonce', opts.nonce);
    u.searchParams.set('code_challenge', opts.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
    return u.toString();
  }

  /** Exchange the code, verify the ID token, and return the verified email. */
  async completeLogin(opts: { code: string; codeVerifier: string; nonce: string }): Promise<{ email: string; subject: string; claims: Record<string, unknown> }> {
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: opts.codeVerifier,
    });
    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (!res.ok) throw new OidcError('token_exchange_failed', String(res.status));
    const tok = (await res.json()) as { id_token?: string };
    if (!tok.id_token) throw new OidcError('no_id_token');
    const claims = await this.verifyIdToken(tok.id_token, opts.nonce);
    const email = this.emailFrom(claims);
    return { email, subject: String(claims.sub), claims };
  }

  async verifyIdToken(idToken: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new OidcError('malformed_id_token');
    const header = JSON.parse(fromB64url(parts[0]!).toString('utf8')) as { alg?: string; kid?: string };
    const claims = JSON.parse(fromB64url(parts[1]!).toString('utf8')) as Record<string, unknown>;
    if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new OidcError('unsupported_alg', String(header.alg));

    const jwk = await this.keyFor(header.kid);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = fromB64url(parts[2]!);
    const ok =
      header.alg === 'RS256'
        ? cryptoVerify('RSA-SHA256', data, key, sig)
        : cryptoVerify('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!ok) throw new OidcError('bad_signature');

    const d = await this.discover();
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof claims.iss !== 'string' || !this.issuerMatches(claims.iss, d.issuer)) throw new OidcError('bad_issuer');
    const aud = claims.aud;
    if (!(aud === this.config.clientId || (Array.isArray(aud) && aud.includes(this.config.clientId)))) throw new OidcError('bad_audience');
    if (Array.isArray(aud) && aud.length > 1 && claims.azp !== this.config.clientId) throw new OidcError('bad_azp');
    if (typeof claims.exp !== 'number' || claims.exp < nowSec - 60) throw new OidcError('expired');
    if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) throw new OidcError('issued_in_future');
    if (claims.nonce !== nonce) throw new OidcError('bad_nonce');
    return claims;
  }

  /** Verified email: `email` (Google requires email_verified) or Entra's UPN / preferred_username. */
  emailFrom(claims: Record<string, unknown>): string {
    let email: unknown = claims.email;
    if (typeof email === 'string' && claims.email_verified === false) throw new OidcError('email_not_verified');
    if (typeof email !== 'string') email = claims.preferred_username ?? claims.upn;
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new OidcError('no_email');
    const normalized = email.trim().toLowerCase();
    const domain = normalized.split('@')[1]!;
    if (this.config.allowedDomains.length && !this.config.allowedDomains.includes(domain)) {
      throw new OidcError('domain_not_allowed', domain);
    }
    return normalized;
  }

  private async keyFor(kid: string | undefined): Promise<JsonWebKey> {
    const pick = () => this.jwks?.keys.find((k) => (kid ? k.kid === kid : true) && (k.use === undefined || k.use === 'sig'));
    let key = this.jwks && this.now() - this.jwks.at < 3600_000 ? pick() : undefined;
    if (!key) {
      const d = await this.discover();
      const res = await this.fetchImpl(d.jwks_uri);
      if (!res.ok) throw new OidcError('jwks_failed', String(res.status));
      this.jwks = { at: this.now(), keys: ((await res.json()) as { keys: any[] }).keys ?? [] };
      key = pick();
    }
    if (!key) throw new OidcError('unknown_key', kid);
    return key;
  }
}
