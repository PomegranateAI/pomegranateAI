import { AsyncLocalStorage } from 'node:async_hooks';
import type { MediaProvenance } from './media-service.js';

// Server-owned provenance survives nested surface / instructed / MCP calls.
// It is never part of a model-authored tool argument.
const context = new AsyncLocalStorage<MediaProvenance[]>();
export const mediaProvenance = () => context.getStore() ?? [];
export function withMediaProvenance<T>(sources: MediaProvenance[], action: () => T): T {
  return context.run(sources, action);
}
