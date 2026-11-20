import {
  getRunSteps,
  getTaskModeSteps,
  getWorkItemRepositorySteps,
  getWorkItemSteps,
  repositoryDescriptionsSteps,
  type Db,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import type { GitHubSnapshotReader } from "../github";
import { memberRepositoriesSteps } from "../improvements";
import { journal, journalCaught } from "../journal";
import { delegatorSteps, type HostTools } from "./linear-tools";

export const REPOSITORY_PAGE = 100;

const lower = (name: string) => name.toLowerCase();

function* otherRepositoriesSteps(
  q: Q,
  item: WorkItemRecord,
): Steps<{ workspaceId: string; names: string[] } | null> {
  const mode = yield* getTaskModeSteps(q, item.id);
  if (mode !== null && mode !== "code") return null;
  const member = yield* delegatorSteps(q, item);
  if (!member) return null;
  const own = yield* getWorkItemRepositorySteps(q, item.id);
  const ownName = own ? lower(`${own.owner}/${own.repo}`) : null;
  const names = (yield* memberRepositoriesSteps(q, member.workspaceId, member.userId))
    .filter((name) => lower(name) !== ownName)
    .sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0));
  return { workspaceId: member.workspaceId, names };
}

async function repositoryPage(store: Db, item: WorkItemRecord, after?: string) {
  return store.run(function* (q) {
    const found = yield* otherRepositoriesSteps(q, item);
    if (!found) return null;
    const start = after ? found.names.findIndex((name) => lower(name) > lower(after)) : 0;
    const names = start < 0 ? [] : found.names.slice(start, start + REPOSITORY_PAGE);
    const described = new Map(
      (yield* repositoryDescriptionsSteps(q, found.workspaceId, names)).map((row) => [
        lower(row.repository),
        row.text,
      ]),
    );
    const lines = names.map((name) => {
      const text = described.get(lower(name));
      return text ? `${name}: ${text}` : name;
    });
    const more = start >= 0 && start + REPOSITORY_PAGE < found.names.length;
    return { lines, next: more ? names.at(-1)! : null };
  });
}

const nextLine = (next: string | null) =>
  next
    ? [`More: list_repositories with after: "${next}" returns the next ${REPOSITORY_PAGE}.`]
    : [];

export async function repositoryNote(store: Db, item: WorkItemRecord): Promise<string | null> {
  const page = await repositoryPage(store, item);
  if (!page?.lines.length) return null;
  return [
    "Other repositories you may read, from the person who delegated this issue:",
    ...page.lines,
    ...nextLine(page.next),
    "Add one with add_repository, at most 5 per run. They are read-only copies beside the checkout. A change to another repository needs its own issue.",
  ].join("\n");
}

export async function repositoryTools(
  store: Db,
  item: WorkItemRecord,
): Promise<HostTools | undefined> {
  const first = await repositoryPage(store, item);
  if (!first?.lines.length) return undefined;
  return {
    definitions: [
      {
        name: "list_repositories",
        description: `List the next ${REPOSITORY_PAGE} repositories you may add with add_repository, after the given name.`,
        inputSchema: {
          type: "object",
          properties: { after: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    async call(name, args) {
      if (name !== "list_repositories") return { text: `Unknown tool ${name}.`, isError: true };
      const after = typeof args["after"] === "string" ? args["after"] : undefined;
      const page = await repositoryPage(store, item, after).catch(() => null);
      if (!page) return { text: "Paws could not list repositories.", isError: true };
      return {
        text: [...page.lines, ...nextLine(page.next)].join("\n") || "No more repositories.",
      };
    },
  };
}

export function joinHostTools(...sets: (HostTools | undefined)[]): HostTools | undefined {
  const present = sets.filter((set): set is HostTools => !!set?.definitions.length);
  if (present.length < 2) return present[0];
  return {
    definitions: present.flatMap((set) => [...set.definitions]),
    async call(name, args) {
      const owner = present.find((set) => set.definitions.some((tool) => tool.name === name));
      return owner ? owner.call(name, args) : { text: `Unknown tool ${name}.`, isError: true };
    },
  };
}

export function repositoryGrant(options: {
  store: Db;
  reader: Pick<GitHubSnapshotReader, "resolve">;
  journal?: (line: string) => void;
}) {
  return async (runId: string, repository: string): Promise<{ commit: string } | null> => {
    try {
      const found = await options.store.run(function* (q) {
        const run = yield* getRunSteps(q, runId);
        const item = run && (yield* getWorkItemSteps(q, run.itemId));
        const listed = item && (yield* otherRepositoriesSteps(q, item));
        const name = listed?.names.find((entry) => lower(entry) === lower(repository));
        return item && name ? { itemId: item.id, name } : null;
      });
      if (!found) return null;
      const snapshot = await options.reader.resolve(found.name, null, AbortSignal.timeout(30_000));
      if (!snapshot) return null;
      (options.journal ?? journal)(
        `run repository-grant item=${found.itemId} run=${runId} repository=${found.name} commit=${snapshot.commit}`,
      );
      return { commit: snapshot.commit };
    } catch (error) {
      journalCaught(error, "loop.repositoryGrant", null, undefined, options.journal);
      return null;
    }
  };
}
