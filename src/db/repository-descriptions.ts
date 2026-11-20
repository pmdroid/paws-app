import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
import type { Q, Steps } from "./db";

export type RepositoryDescriptionSource = "paws" | "admin" | "github";

export type RepositoryDescription = {
  repository: string;
  text: string;
  source: RepositoryDescriptionSource;
  contentHash: string | null;
  updatedAt: number;
};

const MAX_DESCRIPTION_LENGTH = 300;

export function* repositoryDescriptionsSteps(
  q: Q,
  workspaceId: string,
  repositories: readonly string[],
): Steps<RepositoryDescription[]> {
  if (repositories.length === 0) return [];
  const t = q.t.repositoryDescription;
  const rows = yield* q.all(
    q.orm
      .select({
        repository: t.repository,
        text: t.text,
        source: t.source,
        contentHash: t.contentHash,
        updatedAt: t.updatedAt,
      })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, workspaceId),
          inArray(
            t.repository,
            repositories.map((repository) => repository.toLowerCase()),
          ),
        ),
      )
      .orderBy(t.repository),
  );
  return rows.map((row) => ({ ...row, source: row.source as RepositoryDescriptionSource }));
}

export function* writeRepositoryDescriptionSteps(
  q: Q,
  input: {
    workspaceId: string;
    repository: string;
    text: string;
    source: RepositoryDescriptionSource;
    contentHash: string | null;
    now: number;
  },
): Steps<boolean> {
  const text = input.text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (text.length === 0 || text.length > MAX_DESCRIPTION_LENGTH)
    throw new RangeError(
      `repository description must be 1 to ${MAX_DESCRIPTION_LENGTH} characters, got ${text.length}`,
    );
  const t = q.t.repositoryDescription;
  const written = {
    text,
    source: input.source,
    contentHash: input.contentHash,
    updatedAt: input.now,
  };
  const replaceable: Record<RepositoryDescriptionSource, SQL | undefined> = {
    admin: undefined,
    paws: ne(t.source, "admin"),
    github: eq(t.source, "github"),
  };
  const rows = yield* q.all(
    q.orm
      .insert(t)
      .values({
        workspaceId: input.workspaceId,
        repository: input.repository.toLowerCase(),
        ...written,
      })
      .onConflictDoUpdate({
        target: [t.workspaceId, t.repository],
        set: written,
        setWhere: replaceable[input.source],
      })
      .returning({ repository: t.repository }),
  );
  return rows.length > 0;
}

export function* clearRepositoryDescriptionSteps(
  q: Q,
  workspaceId: string,
  repository: string,
): Steps<void> {
  const t = q.t.repositoryDescription;
  yield* q.exec(
    q.orm
      .delete(t)
      .where(and(eq(t.workspaceId, workspaceId), eq(t.repository, repository.toLowerCase()))),
  );
}
