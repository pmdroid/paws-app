import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { Q, Steps } from "./db";

export type GitHubOAuthRow = {
  state_hash: string;
  workspace_id: string;
  user_id: string;
  session_hash: string;
  secret_id: string;
  expected_generation: number;
  intent: string;
  expires_at: number;
  status: string;
};

type Requester = { workspaceId: string; userId: string; sessionHash: string };

function oauthColumns(q: Q) {
  const o = q.t.workspaceGithubOauth;
  return {
    state_hash: o.stateHash,
    workspace_id: o.workspaceId,
    user_id: o.userId,
    session_hash: o.sessionHash,
    secret_id: o.secretId,
    expected_generation: o.expectedGeneration,
    intent: o.intent,
    expires_at: o.expiresAt,
    status: o.status,
  };
}

function intentKind(q: Q) {
  const intent = q.t.workspaceGithubOauth.intent;
  return q.dialect === "sqlite"
    ? sql`json_extract(${intent}, '$.kind')`
    : sql`(${intent}::jsonb ->> 'kind')`;
}

export function* githubOAuthStateExistsSteps(
  q: Q,
  stateHash: string,
  kind: string,
): Steps<boolean> {
  const o = q.t.workspaceGithubOauth;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(o)
      .where(and(eq(o.stateHash, stateHash), eq(intentKind(q), kind))),
  );
  return row !== undefined;
}

export function* githubConnectionSteps(q: Q, workspaceId: string) {
  const c = q.t.workspaceGithubConnection;
  return yield* q.one(
    q.orm
      .select({
        generation: c.generation,
        secret_id: c.secretId,
        installation_id: c.installationId,
        repositories: c.repositories,
      })
      .from(c)
      .where(eq(c.workspaceId, workspaceId)),
  );
}

export function* ensureGithubConnectionSteps(q: Q, workspaceId: string) {
  yield* q.exec(
    q.orm.insert(q.t.workspaceGithubConnection).values({ workspaceId }).onConflictDoNothing(),
  );
}

export function* advanceGithubConnectionSteps(
  q: Q,
  input: {
    workspaceId: string;
    expectedGeneration: number;
    secretId: string;
    actorId: string;
    installationId: string | null;
    repositories: readonly string[];
  },
): Steps<boolean> {
  const c = q.t.workspaceGithubConnection;
  const changed = yield* q.all(
    q.orm
      .update(c)
      .set({
        generation: sql`${c.generation} + 1`,
        secretId: input.secretId,
        actorId: input.actorId,
        installationId: input.installationId,
        repositories: JSON.stringify(input.repositories),
      })
      .where(and(eq(c.workspaceId, input.workspaceId), eq(c.generation, input.expectedGeneration)))
      .returning({ workspaceId: c.workspaceId }),
  );
  return changed.length === 1;
}

export function* latestCompleteGithubOAuthSteps(
  q: Q,
  requester: Requester,
  kind: string,
  now: number,
): Steps<GitHubOAuthRow | undefined> {
  const o = q.t.workspaceGithubOauth;
  return yield* q.one(
    q.orm
      .select(oauthColumns(q))
      .from(o)
      .where(
        and(
          eq(o.workspaceId, requester.workspaceId),
          eq(o.userId, requester.userId),
          eq(o.sessionHash, requester.sessionHash),
          eq(intentKind(q), kind),
          eq(o.status, "complete"),
          gt(o.expiresAt, now),
        ),
      )
      .orderBy(desc(o.expiresAt))
      .limit(1),
  );
}

export function* expiredGithubOAuthSteps(q: Q, workspaceId: string, kind: string, now: number) {
  const o = q.t.workspaceGithubOauth;
  return yield* q.all(
    q.orm
      .select({ state_hash: o.stateHash, secret_id: o.secretId })
      .from(o)
      .where(and(eq(o.workspaceId, workspaceId), eq(intentKind(q), kind), lte(o.expiresAt, now))),
  );
}

export function* deleteGithubOAuthSteps(q: Q, stateHash: string) {
  const o = q.t.workspaceGithubOauth;
  yield* q.exec(q.orm.delete(o).where(eq(o.stateHash, stateHash)));
}

export function* claimGithubOAuthSteps(
  q: Q,
  stateHash: string,
  requester: Requester,
  now: number,
): Steps<GitHubOAuthRow | undefined> {
  const o = q.t.workspaceGithubOauth;
  return yield* q.one(
    q.orm
      .update(o)
      .set({ status: "claimed" })
      .where(
        and(
          eq(o.stateHash, stateHash),
          eq(o.workspaceId, requester.workspaceId),
          eq(o.userId, requester.userId),
          eq(o.sessionHash, requester.sessionHash),
          eq(o.status, "pending"),
          gt(o.expiresAt, now),
        ),
      )
      .returning(oauthColumns(q)),
  );
}

export function* completeGithubOAuthSteps(
  q: Q,
  stateHash: string,
  secretId?: string,
): Steps<boolean> {
  const o = q.t.workspaceGithubOauth;
  const changed = yield* q.all(
    q.orm
      .update(o)
      .set({ status: "complete", ...(secretId === undefined ? {} : { secretId }) })
      .where(and(eq(o.stateHash, stateHash), eq(o.status, "claimed")))
      .returning({ stateHash: o.stateHash }),
  );
  return changed.length === 1;
}

export function* failGithubOAuthSteps(q: Q, stateHash: string, onlyClaimed: boolean) {
  const o = q.t.workspaceGithubOauth;
  yield* q.exec(
    q.orm
      .update(o)
      .set({ status: "failed" })
      .where(and(eq(o.stateHash, stateHash), onlyClaimed ? eq(o.status, "claimed") : undefined)),
  );
}

export function* insertGithubOAuthSteps(
  q: Q,
  row: Requester & {
    stateHash: string;
    secretId: string;
    expectedGeneration: number;
    intent: string;
    expiresAt: number;
  },
) {
  yield* q.exec(q.orm.insert(q.t.workspaceGithubOauth).values(row));
}

export function* updateGithubOAuthIntentSteps(
  q: Q,
  stateHash: string,
  expectedGeneration: number,
  intent: string,
) {
  const o = q.t.workspaceGithubOauth;
  yield* q.exec(
    q.orm.update(o).set({ expectedGeneration, intent }).where(eq(o.stateHash, stateHash)),
  );
}
