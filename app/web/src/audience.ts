// The one audience model, shared by every sharing control on every surface
// (spec-unified-sharing-and-always-sync.md §3). Three tiers, ordered by
// openness. The UI shows exactly these — no 'local', no 'shared'.
export type Audience = 'only_me' | 'private' | 'team';

export interface AudienceTier {
  key: Audience;
  /** Menu label. */
  label: string;
  /** Compact pill label. */
  short: string;
  /** One-line explanation under the label. */
  hint: string;
}

export const AUDIENCE_TIERS: readonly AudienceTier[] = [
  { key: 'only_me', label: 'Only me', short: 'Only me', hint: 'You, in the app — your AI agents can’t use it' },
  { key: 'private', label: 'My AI agents', short: 'AI agents', hint: 'You and your own AI agents, not the team' },
  { key: 'team', label: 'Team', short: 'Team', hint: 'Everyone in your directory + their AI agents' },
];

export const AUDIENCE_LABEL: Record<Audience, string> = {
  only_me: 'Only me',
  private: 'My AI agents',
  team: 'Team',
};

export const AUDIENCE_SHORT: Record<Audience, string> = {
  only_me: 'Only me',
  private: 'AI agents',
  team: 'Team',
};
