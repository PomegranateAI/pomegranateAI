// Proof-of-ownership linking for Slack / WhatsApp identities.
//
// A signed-in user mints a short single-use code in the web app (POST
// /me/identities/:kind/link-code) and sends it to the bot FROM the identity
// they want to link. The surface relay — authenticated by
// SURFACE_AGENT_SECRET and carrying the sender identity Slack / WhatsApp
// actually delivered — redeems it here. Only a sha256 of the code is stored.

import { randomInt } from 'node:crypto';
import { TokenBucketLimiter } from './rate-limit.js';
import type { RouteCore } from './routes/core.js';

export type LinkKind = 'slack' | 'whatsapp';
export const LINK_KINDS: readonly LinkKind[] = ['slack', 'whatsapp'];

/** No 0/O, 1/I/L: easy to read off a screen and retype on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
export const LINK_CODE_TTL_MS = 10 * 60_000;

export function mintLinkCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `PMG-${s}`;
}

const CODE_RE = new RegExp(`^(?:LINK\\s+)?PMG-?([${ALPHABET}]{${CODE_LEN}})$`);

/**
 * The canonical code in a message, or null. The whole trimmed message must be
 * the code, optionally preceded by the word "link"; case-insensitive, and
 * tolerant of the quote/backtick/asterisk wrapping a paste can pick up.
 */
export function parseLinkCode(text: string): string | null {
  const t = text.trim().replace(/^[`*_"'“”]+|[`*_"'“”.!]+$/g, '').trim().toUpperCase();
  const m = CODE_RE.exec(t.replace(/\s+/g, ' '));
  return m ? `PMG-${m[1]}` : null;
}

/** Direct linking (PUT /me/identities/*) without a code: local / dev only. */
export function unverifiedIdentityLinkAllowed(): boolean {
  return process.env.POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK === '1';
}

export function linkInstructions(kind: LinkKind, code: string): string {
  return kind === 'slack'
    ? `DM ${code} to the Pomegranate bot in Slack from the Slack account you want to link.`
    : `Send ${code} to the Pomegranate WhatsApp number from the phone you want to link.`;
}

// ---- relay replies (same voice as UNMAPPED_REPLY / UNMAPPED_REPLY_WHATSAPP) ----

const LABEL: Record<LinkKind, { account: string; connect: string }> = {
  slack: { account: 'Slack account', connect: 'Connect Slack' },
  whatsapp: { account: 'WhatsApp number', connect: 'Connect WhatsApp' },
};

export const LINK_REPLIES = {
  linked: (k: LinkKind, email: string) => `Linked this ${LABEL[k].account} to ${email}. You can now message me.`,
  invalid: (k: LinkKind) =>
    `That link code isn't valid or has expired. Open Pomegranate → Setup → Your profile → ${LABEL[k].connect}, get a new code, and send it here.`,
  alreadyLinkedOther: (k: LinkKind) =>
    `This ${LABEL[k].account} is already linked to a Pomegranate account. To link it to a different one, unlink it in the web app first (Setup → Your profile), then send a new code.`,
  alreadyLinkedSelf: (k: LinkKind) => `This ${LABEL[k].account} is already linked to your Pomegranate account. You can message me.`,
  notDirect: (k: LinkKind) =>
    `Link codes only work in a direct message, so I've cancelled that one. Open Pomegranate → Setup → Your profile → ${LABEL[k].connect}, get a new code, and send it to me directly.`,
  rateLimited: () => 'Too many link attempts. Wait a while, then get a new code and try again.',
};

/** The sender identity exactly as the relay received it from the platform. */
export type LinkSender =
  | { kind: 'slack'; team_id: string; slack_user_id: string; handle?: string; direct: boolean }
  | { kind: 'whatsapp'; phone: string; direct: boolean };

export interface LinkRedeemer {
  /**
   * Handle a message that is a link code. Returns the reply to send, or null
   * when the text isn't a code (the caller carries on as normal).
   * `mappedUserId` is who the sender already resolves to, if anyone.
   */
  maybeRedeem(
    sender: LinkSender,
    text: string,
    mappedUserId: string | null,
    meta: { source_ip?: string },
  ): Promise<{ reply: string; linked?: boolean } | null>;
}

export function createLinkRedeemer(repo: RouteCore['repo']): LinkRedeemer {
  // Failed redemptions per sender identity: 5 burst, one back every 12 min.
  const perSender = new TokenBucketLimiter({ capacity: 5, refillIntervalMs: 12 * 60_000 });
  // And across all senders, so many identities can't brute-force together.
  const global = new TokenBucketLimiter({ capacity: 50, refillIntervalMs: 2_000 });

  return {
    async maybeRedeem(sender, text, mappedUserId, meta) {
      const code = parseLinkCode(text);
      if (!code) return null;
      const kind = sender.kind;
      const senderKey = kind === 'slack' ? `slack:${sender.team_id}:${sender.slack_user_id}` : `whatsapp:${sender.phone}`;
      const fail = () => {
        perSender.take(senderKey);
        global.take('all');
      };

      if (mappedUserId) {
        // Never reveal anything about a code that isn't the caller's own.
        const live = await repo.peekIdentityLinkCode(code, kind);
        if (live && live.user_id === mappedUserId) {
          await repo.takeIdentityLinkCode(code, kind);
          return { reply: LINK_REPLIES.alreadyLinkedSelf(kind) };
        }
        return { reply: LINK_REPLIES.alreadyLinkedOther(kind) };
      }

      if (perSender.retryAfterSec(senderKey) > 0 || global.retryAfterSec('all') > 0) {
        return { reply: LINK_REPLIES.rateLimited() };
      }

      if (!sender.direct) {
        // Posted where others can read it: burn it so nobody else can use it.
        await repo.takeIdentityLinkCode(code, kind);
        return { reply: LINK_REPLIES.notDirect(kind) };
      }

      const taken = await repo.takeIdentityLinkCode(code, kind);
      if (!taken) {
        fail();
        return { reply: LINK_REPLIES.invalid(kind) };
      }
      const owner = await repo.getUserById(taken.user_id);
      if (!owner) {
        fail();
        return { reply: LINK_REPLIES.invalid(kind) };
      }

      let identity;
      try {
        identity = await repo.upsertUserIdentity(
          kind === 'slack'
            ? {
                user_id: owner.id,
                kind,
                team_id: sender.team_id,
                external_id: sender.slack_user_id,
                handle: sender.handle?.replace(/^@/, '') || null,
              }
            : { user_id: owner.id, kind, team_id: null, external_id: sender.phone },
        );
      } catch (err) {
        if ((err as Error).message === 'identity_claimed_by_other_user') {
          return { reply: LINK_REPLIES.alreadyLinkedOther(kind) };
        }
        if ((err as Error).message === 'invalid_external_id') {
          fail();
          return { reply: LINK_REPLIES.invalid(kind) };
        }
        throw err;
      }

      for (const m of await repo.listMembershipsWithWorkspace(owner.id)) {
        await repo.logCustomerAudit(m.id, {
          event: 'identity_linked',
          actor_user_id: owner.id,
          actor_email: owner.email,
          source_ip: meta.source_ip,
          user_agent: `surface:${kind}`,
          resource_type: 'user_identity',
          resource_id: identity.id,
          payload: { kind, external_id: identity.external_id, handle: identity.handle, via: 'link_code' },
        });
      }
      return { reply: LINK_REPLIES.linked(kind, owner.email), linked: true };
    },
  };
}
