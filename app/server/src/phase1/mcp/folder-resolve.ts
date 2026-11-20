/**
 * Folder-reference resolver (surface unification). Turns a caller-supplied
 * `folder` reference into a workspace id and enforces the membership gate.
 *
 * A reference may identify the folder directly or a PERSON whose default
 * folder we should use:
 *   1. workspace id            "ws_example01"
 *   2. folder name             "Marketing"        (viewer's own first, then domain)
 *   3. member email            "alice@example.com"
 *   4. slack handle / user id  "@alice.martin", "U0B7T66JUES"
 *   5. display name            "Alice Martin"
 *
 * Person refs resolve to that person's default folder (surface-aware); if
 * they have none, the folder of their last recorded activity — but only when
 * the viewer is a member of it (an inferred folder must never leak through a
 * denial); failing that, the single folder viewer and person share. Anything
 * unresolvable is a typed ToolError: 'not_found' (nothing matched),
 * 'ambiguous' (several matched — options listed, never guessed), or
 * 'forbidden' (matched, but the viewer is not a member: a default folder is
 * a pointer, never a grant).
 *
 * Who counts as "the domain" here is the org boundary in
 * `src/lib/email-domain.ts`: a public mailbox provider (gmail.com,
 * outlook.com, …) groups nobody, so on such a domain names and people resolve
 * only within the viewer's own folders and the folders they already share.
 */
import type { Repo, DefaultSurface, User } from '../db/repo.js';
import { emailDomain, sameOrgDomain } from '../../lib/email-domain.js';
import { ToolError } from './errors.js';

export interface ResolvedFolder {
  workspace_id: string;
  /** How the reference resolved — recorded in audit payloads. */
  via: 'id' | 'name' | 'email' | 'slack' | 'display_name';
  /** Set when the reference was a person (their default folder was used). */
  person?: { user_id: string; email: string };
}

async function viewerEmail(repo: Repo, viewer_user_id: string): Promise<string> {
  return (await repo.getUserById(viewer_user_id))?.email ?? '';
}

async function viewerDomain(repo: Repo, viewer_user_id: string): Promise<string> {
  return emailDomain(await viewerEmail(repo, viewer_user_id));
}

/**
 * All workspaces visible in the viewer's domain directory, deduped by id. On a
 * personal mailbox domain the directory is the viewer alone (see
 * `listDomainDirectory`), so this is just their own folders — a folder NAME
 * never resolves to a stranger who happens to share gmail.com.
 */
async function domainWorkspaces(
  repo: Repo,
  viewer_user_id: string,
  aiOnly = false,
): Promise<Array<{ id: string; name: string }>> {
  const domain = await viewerDomain(repo, viewer_user_id);
  if (!domain) return [];
  const seen = new Map<string, { id: string; name: string }>();
  for (const u of await repo.listDomainDirectory(domain, viewer_user_id)) {
    for (const w of u.workspaces) {
      if (aiOnly && (await repo.getWorkspace(w.id))?.ai_allowed === 0) continue;
      if (!seen.has(w.id)) seen.set(w.id, { id: w.id, name: w.name });
    }
  }
  return [...seen.values()];
}

/** The one folder a person's reference points at, or a typed failure. */
async function folderForPerson(
  repo: Repo,
  viewer_user_id: string,
  person: User,
  surface: DefaultSurface,
  via: ResolvedFolder['via'],
  aiOnly = false,
): Promise<ResolvedFolder> {
  const mine = new Set((await repo.listMembershipsWithWorkspace(viewer_user_id)).map((m) => m.id));

  // A person reference resolves only for someone the viewer actually has a
  // relationship with: themselves, an ORG colleague, or someone they already
  // share a folder with (the cross-company collaborator). A stranger who
  // merely shares a mailbox provider is not resolvable at all — otherwise the
  // name of their default folder would come back in the 403 below to anyone
  // who guessed their gmail address.
  const related =
    person.id === viewer_user_id ||
    sameOrgDomain(await viewerEmail(repo, viewer_user_id), person.email) ||
    (await repo.listMembershipsWithWorkspace(person.id)).some((m) => mine.has(m.id));
  if (!related) {
    throw new ToolError('not_found', 404, {
      detail: `no directory or teammate matches '${person.email}' — try list_folders or list_team`,
    });
  }

  const dflt = await repo.getUserDefault(person.id, surface);
  if (dflt && (!aiOnly || (await repo.getWorkspace(dflt.workspace_id))?.ai_allowed !== 0)) {
    return {
      workspace_id: dflt.workspace_id,
      via,
      person: { user_id: person.id, email: person.email },
    };
  }
  // No default set: their last-activity folder acts as the implicit default.
  // Only when the viewer is a member — an explicit default may surface in a
  // 403 (the person chose to publish it), but an INFERRED folder must not
  // leak where someone last worked; a non-member viewer falls through.
  const lastActive = await repo.getLastActivityWorkspace(person.id);
  if (lastActive && mine.has(lastActive) && (!aiOnly || (await repo.getWorkspace(lastActive))?.ai_allowed !== 0)) {
    return {
      workspace_id: lastActive,
      via,
      person: { user_id: person.id, email: person.email },
    };
  }
  // Failing that, the single folder viewer and person share.
  const shared = [];
  for (const m of await repo.listMembershipsWithWorkspace(person.id)) {
    if (mine.has(m.id) && (!aiOnly || (await repo.getWorkspace(m.id))?.ai_allowed !== 0)) shared.push(m);
  }
  if (shared.length === 1) {
    return {
      workspace_id: shared[0]!.id,
      via,
      person: { user_id: person.id, email: person.email },
    };
  }
  if (shared.length > 1) {
    throw new ToolError('ambiguous', 422, {
      detail: `${person.email} has no default directory and you share ${shared.length} directories — name one explicitly`,
      options: shared.map((m) => ({ id: m.id, name: m.name })),
    });
  }
  throw new ToolError('not_found', 404, {
    detail: `${person.email} has no default directory and you share no directories with them`,
  });
}

/**
 * Resolve `ref` WITHOUT the membership gate. Only for callers whose whole job
 * is a folder the viewer cannot reach yet — today that is
 * `request_folder_access`, which asks the owner for membership. Everything
 * else must use `resolveFolderRef`: a resolved id is not a grant, and handlers
 * key reads on ctx.ws.
 */
export async function resolveFolderRefUngated(
  repo: Repo,
  viewer_user_id: string,
  ref: string,
  surface: DefaultSurface = 'mcp',
  aiOnly = false,
): Promise<ResolvedFolder> {
  const needle = ref.trim();
  if (!needle) throw new ToolError('invalid', 400, { detail: 'empty directory reference' });
  return await resolveUngated(repo, viewer_user_id, needle, surface, aiOnly);
}

/**
 * Resolve `ref` for `viewer_user_id`, then enforce membership. Every return
 * is a folder the viewer is a member of; everything else throws ToolError.
 */
export async function resolveFolderRef(
  repo: Repo,
  viewer_user_id: string,
  ref: string,
  surface: DefaultSurface = 'mcp',
  aiOnly = false,
): Promise<ResolvedFolder> {
  const needle = ref.trim();
  if (!needle) throw new ToolError('invalid', 400, { detail: 'empty directory reference' });

  const resolved = await resolveUngated(repo, viewer_user_id, needle, surface, aiOnly);

  if (aiOnly && (await repo.getWorkspace(resolved.workspace_id))?.ai_allowed === 0) {
    throw new ToolError('not_found', 404, { detail: 'directory not found' });
  }

  if (!await repo.getMembership(resolved.workspace_id, viewer_user_id)) {
    const w = await repo.getWorkspace(resolved.workspace_id);
    throw new ToolError('forbidden', 403, {
      detail: `you are not a member of '${w?.name ?? resolved.workspace_id}'`,
      hint: 'ask the directory owner to add you, or use "Request access" in the Pomegranate web app (Setup → Explore directories)',
    });
  }
  return resolved;
}

async function resolveUngated(
  repo: Repo,
  viewer_user_id: string,
  needle: string,
  surface: DefaultSurface,
  aiOnly = false,
): Promise<ResolvedFolder> {
  // 1. Exact workspace id.
  if (await repo.getWorkspace(needle)) return { workspace_id: needle, via: 'id' };

  // 2. Folder name — the viewer's own memberships first (an exact hit there
  //    can't surprise), then the domain directory.
  const lower = needle.toLowerCase();
  let mine = (await repo
    .listMembershipsWithWorkspace(viewer_user_id))
    .filter((m) => m.name.toLowerCase() === lower);
  if (aiOnly) {
    const visible = [];
    for (const m of mine) if ((await repo.getWorkspace(m.id))?.ai_allowed !== 0) visible.push(m);
    mine = visible;
  }
  const domainHits =
    mine.length > 0
      ? []
      : (await domainWorkspaces(repo, viewer_user_id, aiOnly)).filter((w) => w.name.toLowerCase() === lower);
  const nameHits = mine.length > 0 ? mine : domainHits;

  // 3–5. Person references.
  let person: User | undefined;
  let via: ResolvedFolder['via'] = 'display_name';
  if (needle.includes('@') && !needle.startsWith('@')) {
    person = await repo.findUserByEmail(needle);
    via = 'email';
  } else if (needle.startsWith('@') || /^U[A-Z0-9]{5,}$/.test(needle)) {
    person = await repo.findUserBySlackIdentity(null, needle);
    via = 'slack';
  }
  let displayMatches: User[] = [];
  if (!person && !needle.includes('@')) {
    displayMatches = await repo.findUsersByDisplayName(needle);
    // Only people in the viewer's own ORG are resolvable — mirrors the
    // directory boundary, which does not treat a mailbox provider as one
    // (two "Ada Lovelace"s on gmail.com are strangers), so on a personal
    // domain only the viewer themselves matches by display name.
    const myEmail = await viewerEmail(repo, viewer_user_id);
    displayMatches = displayMatches.filter(
      (u) => u.id === viewer_user_id || sameOrgDomain(myEmail, u.email),
    );
    via = 'display_name';
  }

  // Folder-vs-person collision: list both, never guess.
  const personCount = (person ? 1 : 0) + displayMatches.length;
  if (nameHits.length + personCount > 1) {
    throw new ToolError('ambiguous', 422, {
      detail: `'${needle}' matches more than one thing — use a directory id or email`,
      options: [
        ...nameHits.map((w) => ({ kind: 'folder', id: w.id, name: w.name })),
        ...(person ? [{ kind: 'person', email: person.email }] : []),
        ...displayMatches.map((u) => ({ kind: 'person', email: u.email })),
      ],
    });
  }

  if (nameHits.length === 1) return { workspace_id: nameHits[0]!.id, via: 'name' };
  if (person) return await folderForPerson(repo, viewer_user_id, person, surface, via, aiOnly);
  if (displayMatches.length === 1) {
    return await folderForPerson(repo, viewer_user_id, displayMatches[0]!, surface, 'display_name', aiOnly);
  }

  throw new ToolError('not_found', 404, {
    detail: `no directory or teammate matches '${needle}' — try list_folders or list_team`,
  });
}
