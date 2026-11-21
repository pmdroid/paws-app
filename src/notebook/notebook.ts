import {
  lockNotebookSteps,
  notebookChangesSteps,
  notebookStateSteps,
  writeNotebookSteps,
  type Db,
  type NotebookChangeRow,
  type NotebookEntryRow,
  type NotebookScope,
  type NotebookWrite,
  type Q,
  type Steps,
} from "../db";
import { sanitizedContextText } from "../project-context";

export const NOTEBOOK_LIMITS = { repository: 12_000, project: 4_000, entry: 1_000 } as const;

const OPERATIONS = 8;

export type NotebookOperation =
  | { readonly action: "add"; readonly content: string }
  | { readonly action: "patch"; readonly old_text: string; readonly content: string }
  | { readonly action: "remove"; readonly old_text: string };

export type Notebook = {
  revision: number;
  entries: NotebookEntryRow[];
  size: number;
  limit: number;
};

export type NotebookApplied = {
  action: NotebookOperation["action"];
  entryId: string;
  duplicate: boolean;
};

export type NotebookActor = {
  readonly itemId: string | null;
  readonly actorId: string | null;
  readonly now: number;
};

type Refused = Notebook & { ok: false; reason: string; operation: number | null };

export type NotebookEditResult =
  | (Notebook & { ok: true; applied: NotebookApplied[]; changes: NotebookChangeRow[] })
  | Refused;

export type NotebookUndoResult = (Notebook & { ok: true; changes: NotebookChangeRow[] }) | Refused;

class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly operation: number | null = null,
  ) {
    super(reason);
  }
}

const PENDING = "pending:";

type Draft = { id: string; body: string };

const sizeOf = (entries: readonly { body: string }[]) =>
  entries.reduce((total, entry) => total + entry.body.length, 0);

const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();

function cleaned(content: string): string {
  const text = sanitizedContextText(content, NOTEBOOK_LIMITS.entry * 8);
  if (text.length === 0) throw new Error("content is empty");
  if (text.length > NOTEBOOK_LIMITS.entry)
    throw new Error(
      `content is ${text.length} characters, over the ${NOTEBOOK_LIMITS.entry} limit`,
    );
  return text;
}

function matching<T extends Draft>(entries: readonly T[], oldText: string): T {
  if (oldText.length === 0) throw new Error("old_text is empty");
  const found = entries.filter((entry) => entry.body.includes(oldText));
  if (found.length !== 1)
    throw new Error(
      found.length === 0 ? "old_text matches no entry" : `old_text matches ${found.length} entries`,
    );
  if (found[0]!.id.startsWith(PENDING))
    throw new Error("old_text matches an entry added by this call");
  return found[0]!;
}

function duplicateOf(entries: readonly Draft[], body: string) {
  return entries.find((entry) => collapsed(entry.body) === collapsed(body));
}

function checkLimit(scope: NotebookScope, entries: readonly { body: string }[]): void {
  const size = sizeOf(entries);
  const limit = NOTEBOOK_LIMITS[scope.kind];
  if (size > limit)
    throw new Refusal(
      `the notebook would hold ${size} characters, over its ${limit} limit; remove or shorten entries in the same call`,
    );
}

function plan(current: readonly Draft[], operations: readonly NotebookOperation[]) {
  const entries: Draft[] = current.map((entry) => ({ id: entry.id, body: entry.body }));
  const writes: NotebookWrite[] = [];
  const applied: NotebookApplied[] = [];
  for (const [index, operation] of operations.entries()) {
    try {
      if (operation.action === "add") {
        const body = cleaned(operation.content);
        const existing = duplicateOf(entries, body);
        const entryId =
          existing?.id ?? `${PENDING}${writes.filter((w) => w.action === "add").length}`;
        applied.push({ action: "add", entryId, duplicate: existing !== undefined });
        if (existing) continue;
        entries.push({ id: entryId, body });
        writes.push({ action: "add", body });
        continue;
      }
      const entry = matching(entries, operation.old_text);
      applied.push({ action: operation.action, entryId: entry.id, duplicate: false });
      if (operation.action === "remove") {
        writes.push({ action: "remove", entryId: entry.id, before: entry.body });
        entries.splice(entries.indexOf(entry), 1);
        continue;
      }
      const body = cleaned(operation.content);
      writes.push({ action: "patch", entryId: entry.id, before: entry.body, body });
      entry.body = body;
    } catch (error) {
      throw new Refusal(`operation ${index + 1}: ${(error as Error).message}`, index);
    }
  }
  return { writes, applied, entries };
}

function* stateSteps(q: Q, scope: NotebookScope): Steps<Notebook> {
  const { revision, entries } = yield* notebookStateSteps(q, scope);
  return { revision, entries, size: sizeOf(entries), limit: NOTEBOOK_LIMITS[scope.kind] };
}

async function refusing<T>(
  db: Db,
  scope: NotebookScope,
  body: (q: Q) => Steps<T>,
): Promise<T | Refused> {
  try {
    return await db.transaction(body);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    const state = await db.run((q) => stateSteps(q, scope));
    return { ok: false, reason: error.reason, operation: error.operation, ...state };
  }
}

export function readNotebook(db: Db, scope: NotebookScope): Promise<Notebook> {
  return db.run((q) => stateSteps(q, scope));
}

export function notebookChanges(
  db: Db,
  scope: NotebookScope,
  limit = 50,
): Promise<NotebookChangeRow[]> {
  return db.run((q) => notebookChangesSteps(q, scope, { limit: Math.min(limit, 200) }));
}

export function editNotebook(
  db: Db,
  scope: NotebookScope,
  operations: readonly NotebookOperation[],
  actor: NotebookActor,
): Promise<NotebookEditResult> {
  return refusing(db, scope, function* (q) {
    if (operations.length < 1 || operations.length > OPERATIONS)
      throw new Refusal(`a call carries 1 to ${OPERATIONS} operations`);
    yield* lockNotebookSteps(q, scope, actor.now);
    const { writes, applied, entries } = plan(
      (yield* notebookStateSteps(q, scope)).entries,
      operations,
    );
    checkLimit(scope, entries);
    const changes =
      writes.length === 0 ? [] : yield* writeNotebookSteps(q, scope, { writes, ...actor });
    const added = changes
      .filter((change) => change.action === "add")
      .map((change) => change.entryId);
    for (const entry of applied)
      if (entry.entryId.startsWith(PENDING))
        entry.entryId = added[Number(entry.entryId.slice(PENDING.length))]!;
    return { ok: true as const, applied, changes, ...(yield* stateSteps(q, scope)) };
  });
}

export function undoNotebookChange(
  db: Db,
  scope: NotebookScope,
  changeId: string,
  actor: NotebookActor,
): Promise<NotebookUndoResult> {
  return refusing(db, scope, function* (q) {
    yield* lockNotebookSteps(q, scope, actor.now);
    const [change] = yield* notebookChangesSteps(q, scope, { id: changeId });
    if (!change) throw new Refusal("no such change in this notebook");
    const { entries } = yield* notebookStateSteps(q, scope);
    const entry = entries.find((candidate) => candidate.id === change.entryId);
    let write: NotebookWrite;
    if (change.action === "remove") {
      const body = change.before!;
      if (entry) throw new Refusal("the entry is already in the notebook");
      if (duplicateOf(entries, body)) throw new Refusal("the same text is in the notebook again");
      checkLimit(scope, [...entries, { body }]);
      write = { action: "add", entryId: change.entryId, body };
    } else {
      if (!entry) throw new Refusal("the entry is no longer in the notebook");
      if (entry.body !== change.after) throw new Refusal("the entry has changed since");
      const body = change.before;
      if (body === null) write = { action: "remove", entryId: entry.id, before: entry.body };
      else {
        checkLimit(
          scope,
          entries.map((candidate) => (candidate === entry ? { body } : candidate)),
        );
        write = { action: "patch", entryId: entry.id, before: entry.body, body };
      }
    }
    const changes = yield* writeNotebookSteps(q, scope, { writes: [write], ...actor });
    return { ok: true as const, changes, ...(yield* stateSteps(q, scope)) };
  });
}

export function renderNotebook(entries: readonly { body: string }[]): string {
  return entries.map((entry) => `- ${entry.body}`).join("\n");
}
