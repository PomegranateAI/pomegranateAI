// The "From your apps" connector registry.
//
// Every entry is a Composio-backed connector (see COMPOSIO_CONNECTORS in
// routes/core.ts and the matching `<toolkit>-live.ts` client). A user connects
// their own account through Composio OAuth; this app never sees or stores the
// provider token, only a connected_account_id. Until the calling user has an
// active connection, preview and pull answer `app_not_connected`.

export type AppSourceItem = {
  id: string;
  /** Becomes the document's source_ref (email subject, filename, thread title). */
  title: string;
  /** Sender / channel / author + date line shown in the preview list. */
  meta: string;
  /** One-line preview snippet. */
  snippet: string;
};

export type AppCatalogEntry = {
  id: string;
  name: string;
  /** Preview-list unit noun ("email", "thread"…). */
  unit: string;
};

export const APP_CATALOG: Record<string, AppCatalogEntry> = {
  gmail: { id: 'gmail', name: 'Gmail', unit: 'email' },
  gdrive: { id: 'gdrive', name: 'Google Drive', unit: 'file' },
  slack: { id: 'slack', name: 'Slack', unit: 'thread' },
  notion: { id: 'notion', name: 'Notion', unit: 'page' },
  github: { id: 'github', name: 'GitHub', unit: 'PR' },
  jira: { id: 'jira', name: 'Jira', unit: 'issue' },
  microsoft_teams: { id: 'microsoft_teams', name: 'Microsoft Teams', unit: 'message' },
  fathom: { id: 'fathom', name: 'Fathom', unit: 'meeting' },
};
