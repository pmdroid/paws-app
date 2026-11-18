import { and, eq, gt, sql } from "drizzle-orm";
import type { Q, Steps } from "./db";

export type SlackInstallationStatus = "none" | "active" | "disconnected" | "revoked";
export type SlackInstallation = {
  workspaceId: string;
  generation: number;
  status: SlackInstallationStatus;
  teamId: string | null;
  teamName: string | null;
  appId: string | null;
  botUserId: string | null;
  scope: string;
  source: "oauth" | "cli" | null;
  actorId: string | null;
  updatedAt: number;
};
export type SlackOAuthIntent = "install" | "reconnect" | "replace";
export type SlackOAuthRequest = {
  stateHash: string;
  workspaceId: string;
  userId: string;
  sessionHash: string;
  intent: SlackOAuthIntent;
  expectedGeneration: number;
  returnTeamId: string | null;
  returnChannelId: string | null;
  expiresAt: number;
};

export function* slackInstallationSteps(
  q: Q,
  workspaceId: string,
): Steps<SlackInstallation | undefined> {
  const s = q.t.workspaceSlackInstallation;
  return (yield* q.one(q.orm.select().from(s).where(eq(s.workspaceId, workspaceId)))) as
    | SlackInstallation
    | undefined;
}

export function* activeSlackTeamSteps(q: Q, teamId: string): Steps<SlackInstallation | undefined> {
  const s = q.t.workspaceSlackInstallation;
  return (yield* q.one(
    q.orm
      .select()
      .from(s)
      .where(and(eq(s.teamId, teamId), eq(s.status, "active"))),
  )) as SlackInstallation | undefined;
}

export function* ensureSlackInstallationSteps(q: Q, workspaceId: string, now: number) {
  yield* q.exec(
    q.orm
      .insert(q.t.workspaceSlackInstallation)
      .values({ workspaceId, updatedAt: now })
      .onConflictDoNothing(),
  );
}

export function* saveSlackInstallationSteps(
  q: Q,
  input: {
    workspaceId: string;
    expectedGeneration: number;
    status: SlackInstallationStatus;
    actorId: string | null;
    now: number;
    identity?: Pick<SlackInstallation, "teamId" | "teamName" | "appId" | "botUserId" | "scope"> & {
      source: "oauth" | "cli";
    };
  },
): Steps<boolean> {
  const s = q.t.workspaceSlackInstallation;
  const changed = yield* q.all(
    q.orm
      .update(s)
      .set({
        generation: sql`${s.generation} + 1`,
        status: input.status,
        actorId: input.actorId,
        updatedAt: input.now,
        ...input.identity,
      })
      .where(and(eq(s.workspaceId, input.workspaceId), eq(s.generation, input.expectedGeneration)))
      .returning({ workspaceId: s.workspaceId }),
  );
  return changed.length === 1;
}

export function* insertSlackOAuthSteps(q: Q, request: SlackOAuthRequest) {
  yield* q.exec(q.orm.insert(q.t.workspaceSlackOauth).values(request));
}

export function* claimSlackOAuthSteps(
  q: Q,
  stateHash: string,
  now: number,
): Steps<SlackOAuthRequest | undefined> {
  const o = q.t.workspaceSlackOauth;
  const rows = yield* q.all(
    q.orm
      .update(o)
      .set({ status: "claimed" })
      .where(and(eq(o.stateHash, stateHash), eq(o.status, "pending"), gt(o.expiresAt, now)))
      .returning(),
  );
  return rows[0] as SlackOAuthRequest | undefined;
}

export function* finishSlackOAuthSteps(q: Q, stateHash: string, status: "complete" | "failed") {
  const o = q.t.workspaceSlackOauth;
  yield* q.exec(q.orm.update(o).set({ status }).where(eq(o.stateHash, stateHash)));
}
