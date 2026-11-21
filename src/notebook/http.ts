import { z } from "zod";
import {
  linearProjectTeamsSteps,
  listWorkspaceRepositoriesSteps,
  notebookChangeLabelsSteps,
  workItemProjectsSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceNotebooksSteps,
  type Db,
  type NotebookScope,
  type NotebookScopeKind,
} from "../db";
import {
  NOTEBOOK_LIMITS,
  editNotebook,
  notebookChanges,
  readNotebook,
  undoNotebookChange,
  undoableChange,
} from "./notebook";

const PATH = "/api/notebooks";
const BODY_LIMIT = 64 * 1024;
const NO_STORE = { "cache-control": "no-store, private", vary: "cookie" };
const NOT_FOUND = { error: "This notebook is not available." };

const EDIT = z.object({
  operations: z.array(
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("add"), content: z.string() }),
      z.object({ action: z.literal("patch"), old_text: z.string(), content: z.string() }),
      z.object({ action: z.literal("remove"), old_text: z.string() }),
    ]),
  ),
});
const UNDO = z.object({ changeId: z.string().min(1).max(64) });

type Principal = { readonly workspaceId: string; readonly userId: string };

export type NotebookChannelAccess = {
  members(
    workspaceId: string,
    channelScopeId: string,
  ): Promise<{ slackUserIds: ReadonlySet<string>; name: string | null } | null>;
  slackUserId(workspaceId: string, userId: string): Promise<string | null>;
};

type Viewer = {
  repositories: ReadonlySet<string>;
  teamIds: ReadonlySet<string>;
  userId: string;
  workspaceId: string;
  slackUserId: () => Promise<string | null>;
};

type Access = { db: Db; channels: NotebookChannelAccess | undefined };

const KINDS = new Set<string>(["repository", "project", "channel", "user"]);
const OWN_NAME = "Your notebook";

const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

async function viewerFor(access: Access, principal: Principal): Promise<Viewer | null> {
  const { workspaceId, userId } = principal;
  const found = await access.db.run(function* (q) {
    const member = yield* workspaceMemberSteps(q, workspaceId, userId);
    if (!workspaceMemberUsable(member)) return null;
    const repositories = (yield* listWorkspaceRepositoriesSteps(q, workspaceId))
      .filter((entry) => member.teamIds.includes(entry.teamId))
      .map((entry) => entry.repository);
    return { teamIds: member.teamIds, repositories };
  });
  if (found === null) return null;
  let slack: Promise<string | null> | undefined;
  return {
    repositories: new Set(found.repositories.map((name) => name.toLowerCase())),
    teamIds: new Set(found.teamIds),
    userId,
    workspaceId,
    slackUserId: () =>
      (slack ??= access.channels?.slackUserId(workspaceId, userId) ?? Promise.resolve(null)),
  };
}

async function channelName(access: Access, viewer: Viewer, id: string) {
  if (access.channels === undefined) return null;
  try {
    const [members, slackUserId] = await Promise.all([
      access.channels.members(viewer.workspaceId, id),
      viewer.slackUserId(),
    ]);
    if (members === null || slackUserId === null || !members.slackUserIds.has(slackUserId))
      return null;
    return `#${members.name ?? id}`;
  } catch {
    return null;
  }
}

async function notebookAccess(
  access: Access,
  viewer: Viewer,
  scope: NotebookScope,
): Promise<string | null> {
  if (scope.workspaceId !== viewer.workspaceId) return null;
  if (scope.kind === "user") return scope.id === viewer.userId ? OWN_NAME : null;
  if (scope.kind === "repository")
    return viewer.repositories.has(scope.id.toLowerCase()) ? scope.id : null;
  if (scope.kind === "channel") return channelName(access, viewer, scope.id);
  return access.db.run(function* (q) {
    const teams = yield* linearProjectTeamsSteps(q, scope.workspaceId, scope.id);
    if (!teams.some((team) => viewer.teamIds.has(team))) return null;
    const names = yield* workItemProjectsSteps(q, [scope.id]);
    return names.find((row) => row.name !== null)?.name ?? scope.id;
  });
}

async function list(access: Access, principal: Principal) {
  const viewer = await viewerFor(access, principal);
  if (viewer === null) return [];
  const stored = await access.db.run((q) => workspaceNotebooksSteps(q, viewer.workspaceId));
  const own =
    stored.find((notebook) => notebook.kind === "user" && notebook.id === viewer.userId) ??
    ({ kind: "user", id: viewer.userId, size: 0 } as const);
  const others = stored.filter((notebook) => notebook !== own);
  const names = await Promise.all(
    others.map((notebook) =>
      notebookAccess(access, viewer, { workspaceId: viewer.workspaceId, ...notebook }),
    ),
  );
  return [
    { ...own, name: OWN_NAME, limit: NOTEBOOK_LIMITS.user },
    ...others.flatMap((notebook, index) => {
      const name = names[index];
      return name == null ? [] : [{ ...notebook, name, limit: NOTEBOOK_LIMITS[notebook.kind] }];
    }),
  ];
}

async function visible(access: Access, principal: Principal, scope: NotebookScope) {
  const viewer = await viewerFor(access, principal);
  return viewer !== null && (await notebookAccess(access, viewer, scope)) !== null;
}

async function view(db: Db, scope: NotebookScope) {
  const [notebook, changes] = await Promise.all([
    readNotebook(db, scope),
    notebookChanges(db, scope, 50),
  ]);
  const labels = await db.run((q) =>
    notebookChangeLabelsSteps(q, {
      actorIds: [...new Set(changes.flatMap((change) => change.actorId ?? []))],
      itemIds: [...new Set(changes.flatMap((change) => change.itemId ?? []))],
    }),
  );
  return {
    kind: scope.kind,
    id: scope.id,
    revision: notebook.revision,
    size: notebook.size,
    limit: notebook.limit,
    entries: notebook.entries.map(({ id, body, updatedAt }) => ({ id, body, updatedAt })),
    changes: changes.map((change) => {
      const { id, entryId, action, before, after, itemId, actorId, at } = change;
      const item = itemId === null ? null : (labels.items.get(itemId) ?? itemId);
      const actor = actorId === null ? null : (labels.actors.get(actorId) ?? null);
      const undoable = undoableChange(scope, notebook.entries, change);
      return { id, entryId, action, before, after, item, actor, at, undoable };
    }),
  };
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}

async function json(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.length > BODY_LIMIT ? undefined : new Response(text).json().catch(() => undefined);
}

export function createNotebookHttp(options: {
  db: Db;
  now?: () => number;
  channelAccess?: NotebookChannelAccess;
}) {
  const { db } = options;
  const access: Access = { db, channels: options.channelAccess };
  const now = options.now ?? Date.now;
  return async (request: Request, principal: Principal): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (path === PATH) {
      if (request.method !== "GET") return answer({ error: "List notebooks with GET." }, 405);
      return answer({ notebooks: await list(access, principal) });
    }
    if (!path.startsWith(`${PATH}/`)) return null;
    const [kind = "", encoded = "", action, ...rest] = path.slice(PATH.length + 1).split("/");
    const id = decoded(encoded);
    if (
      !KINDS.has(kind) ||
      id.length === 0 ||
      rest.length > 0 ||
      (action !== undefined && action !== "edits" && action !== "undo")
    )
      return answer(NOT_FOUND, 404);
    const scope: NotebookScope = {
      workspaceId: principal.workspaceId,
      kind: kind as NotebookScopeKind,
      id,
    };
    if (!(await visible(access, principal, scope))) return answer(NOT_FOUND, 404);
    if (request.method !== (action === undefined ? "GET" : "POST"))
      return answer({ error: "Read with GET and change with POST." }, 405);
    if (action === undefined) return answer(await view(db, scope));
    const actor = { itemId: null, actorId: principal.userId, now: now() };
    const input = await json(request);
    let result;
    if (action === "edits") {
      const parsed = EDIT.safeParse(input);
      if (!parsed.success) return answer({ error: "Send { operations }." }, 400);
      result = await editNotebook(db, scope, parsed.data.operations, actor);
    } else {
      const parsed = UNDO.safeParse(input);
      if (!parsed.success) return answer({ error: "Send { changeId }." }, 400);
      result = await undoNotebookChange(db, scope, parsed.data.changeId, actor);
    }
    if (!result.ok)
      return answer(
        { error: result.reason, operation: result.operation, notebook: await view(db, scope) },
        409,
      );
    return answer(await view(db, scope));
  };
}
