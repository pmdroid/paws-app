import { z } from "zod";
import {
  notebookChangeLabelsSteps,
  workItemProjectsSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceNotebooksSteps,
  type Db,
  type NotebookScope,
  type NotebookScopeKind,
  type Q,
  type Steps,
} from "../db";
import { memberRepositoriesSteps } from "../improvements";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";
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

type Viewer = {
  admin: boolean;
  repositories: ReadonlySet<string>;
  userId: string;
  workspaceId: string;
};

const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

function* viewerSteps(q: Q, principal: WorkspacePrincipal): Steps<Viewer | null> {
  const { workspaceId, userId } = principal;
  const member = yield* workspaceMemberSteps(q, workspaceId, userId);
  if (!workspaceMemberUsable(member)) return null;
  const repositories = yield* memberRepositoriesSteps(q, workspaceId, userId);
  return {
    admin: isWorkspaceAdmin(member.role),
    repositories: new Set(repositories.map((name) => name.toLowerCase())),
    userId,
    workspaceId,
  };
}

function* projectsSteps(q: Q, viewer: Viewer, ids: readonly string[]) {
  const projects = yield* workItemProjectsSteps(q, {
    projectIds: ids,
    ...(viewer.admin ? {} : { ownerUserId: viewer.userId }),
  });
  const names = new Map<string, string>();
  for (const project of projects)
    if (project.name !== null || !names.has(project.id))
      names.set(project.id, project.name ?? project.id);
  return names;
}

function* listSteps(q: Q, principal: WorkspacePrincipal) {
  const viewer = yield* viewerSteps(q, principal);
  if (viewer === null) return [];
  const stored = yield* workspaceNotebooksSteps(q, viewer.workspaceId);
  const projects = yield* projectsSteps(
    q,
    viewer,
    stored.filter((notebook) => notebook.kind === "project").map((notebook) => notebook.id),
  );
  return stored.flatMap((notebook) => {
    const name = notebook.kind === "project" ? projects.get(notebook.id) : notebook.id;
    const visible =
      viewer.admin ||
      (notebook.kind === "project"
        ? name !== undefined
        : viewer.repositories.has(notebook.id.toLowerCase()));
    return visible
      ? [{ ...notebook, name: name ?? notebook.id, limit: NOTEBOOK_LIMITS[notebook.kind] }]
      : [];
  });
}

function* visibleSteps(q: Q, principal: WorkspacePrincipal, scope: NotebookScope) {
  const viewer = yield* viewerSteps(q, principal);
  if (viewer === null) return false;
  if (viewer.admin) return true;
  if (scope.kind === "repository") return viewer.repositories.has(scope.id.toLowerCase());
  return (yield* projectsSteps(q, viewer, [scope.id])).has(scope.id);
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

async function json(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.length > BODY_LIMIT ? undefined : new Response(text).json().catch(() => undefined);
}

export function createNotebookHttp(options: { db: Db; now?: () => number }) {
  const { db } = options;
  const now = options.now ?? Date.now;
  return async (request: Request, principal: WorkspacePrincipal): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (path === PATH) {
      if (request.method !== "GET") return answer({ error: "List notebooks with GET." }, 405);
      return answer({ notebooks: await db.run((q) => listSteps(q, principal)) });
    }
    if (!path.startsWith(`${PATH}/`)) return null;
    const [kind = "", encoded = "", action, ...rest] = path.slice(PATH.length + 1).split("/");
    let id = "";
    try {
      id = decodeURIComponent(encoded);
    } catch {}
    if (
      (kind !== "repository" && kind !== "project") ||
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
    if (!(await db.run((q) => visibleSteps(q, principal, scope)))) return answer(NOT_FOUND, 404);
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
