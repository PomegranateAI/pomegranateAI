/**
 * Typed errors. Each carries a `userMessage` — the clean text safe to post into
 * Slack (SPEC §7). Handlers map any thrown SurfaceError to its `userMessage`;
 * anything else becomes a generic failure reply. Raw internals never reach Slack.
 */
export class SurfaceError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string, internal?: string) {
    super(internal ?? userMessage);
    this.userMessage = userMessage;
    this.name = new.target.name;
  }
}

/** The Slack workspace isn't connected to Pomegranate. */
export class TeamNotMapped extends SurfaceError {}

/** The named subject has no mapped Pomegranate canon. */
export class SubjectNotMapped extends SurfaceError {}

/** A mapped subject's MCP token env var is missing at runtime. */
export class MissingToken extends SurfaceError {}

/** The message didn't parse into a valid command. */
export class BadCommand extends SurfaceError {}

/** No usable payload (no file, link, or text) after parsing. */
export class EmptyPayload extends SurfaceError {}

/** A file was attached but its type isn't supported. */
export class UnsupportedFile extends SurfaceError {}

/**
 * A file was attached but Slack didn't return its contents — e.g. the app
 * lacks the `files:read` scope and Slack served its HTML sign-in page (with a
 * 200) instead of the file bytes. Without this, that HTML would be reviewed as
 * if it were the deliverable.
 */
export class FileFetchError extends SurfaceError {}

/** The Pomegranate API failed or returned an unexpected response. */
export class UpstreamError extends SurfaceError {}

/** The canonical usage hint (SPEC §7.4). */
export const USAGE_HINT =
  'Mention me with one of:\n' +
  "  • `review` <attach a file, paste text, or link a doc> `from @person`\n" +
  "  • `GetContext about` <topic / paste text / attach a file> `from @person`\n" +
  '  • `ingest [as only me|private|team]` <attach a `.txt`/`.md` file or paste text> — proposes changes to *your* graph (audience defaults to team)\n' +
  '  • `pending` — review and approve/reject proposed changes to *your* graph\n' +
  '  • `listen [every 12h]` / `stop listening` / `listening` — periodically ingest this channel into *your* graph (default 24h)\n' +
  'where @person is someone connected to Pomegranate.';
