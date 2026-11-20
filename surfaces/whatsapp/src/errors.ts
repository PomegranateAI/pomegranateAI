/**
 * [shared pattern with surfaces/slack/src/errors.ts] Typed errors. Each
 * carries a `userMessage` — the clean text safe to send back over WhatsApp.
 * The webhook handler maps any thrown SurfaceError to its `userMessage`;
 * anything else becomes a generic failure reply. Raw internals never reach
 * the user.
 */
export class SurfaceError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string, internal?: string) {
    super(internal ?? userMessage);
    this.userMessage = userMessage;
    this.name = new.target.name;
  }
}

/** Boot-time misconfiguration (missing token/secret). */
export class MissingToken extends SurfaceError {}

/** The Pomegranate API failed or returned an unexpected response. */
export class UpstreamError extends SurfaceError {}

/** The WasenderAPI send-message call failed. */
export class SendFailedError extends SurfaceError {}
