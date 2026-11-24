/**
 * Transport-agnostic tool failure. REST maps httpStatus directly; the MCP
 * transport returns body() as an isError tool result so the model can react
 * conversationally (e.g. "that candidate was already approved").
 *
 * Lives in its own module (not registry.ts) so helpers like the folder
 * resolver can throw it without importing the tool registry (which imports
 * them back).
 */
export class ToolError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'invalid_kind'
      | 'invalid_targets'
      | 'not_found'
      | 'already_resolved'
      | 'not_supported'
      | 'forbidden'
      | 'not_your_route'
      | 'ambiguous'
      | 'redaction_unavailable',
    readonly httpStatus: 400 | 403 | 404 | 409 | 422 | 501,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
  body(): Record<string, unknown> {
    return { error: this.code, ...this.extra };
  }
}
