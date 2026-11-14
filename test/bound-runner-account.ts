import { and, eq } from "drizzle-orm";
import {
  runnerHostVersionSteps,
  commandAccountSteps,
  bindAgentAccount,
  createAgentAccount,
  listAgentBindings,
  recordRunnerAccountCapability,
  type Db,
} from "../src/db";
import { runnerReleaseAtLeast, type RunnerCodingAgent } from "../src/runner-protocol";
import { seed } from "./dialects";

export async function boundRunnerAccount(
  db: Db,
  workspaceId: string,
  runnerId: string,
  agent: RunnerCodingAgent,
  now: number,
) {
  const existing = (await listAgentBindings(db, workspaceId)).find(
    (b) => b.runnerId === runnerId && b.agent === agent && !b.legacy && b.removedAt === null,
  );
  const binding =
    existing ??
    (await bindAgentAccount(db, {
      workspaceId,
      runnerId,
      now,
      accountId: (
        await createAgentAccount(db, { workspaceId, agent, label: runnerId + "-" + agent, now })
      ).id,
    }));
  const previousVersion = await db.run((q) => runnerHostVersionSteps(q, runnerId));
  const runnerVersion = runnerReleaseAtLeast(previousVersion, [0, 1, 61])
    ? previousVersion!
    : "0.1.61";
  await seed(db, (q) =>
    q.orm
      .insert(q.t.runnerHostStatus)
      .values({ runnerId, runnerVersion, reportedAt: now })
      .onConflictDoUpdate({
        target: q.t.runnerHostStatus.runnerId,
        set: { runnerVersion },
      }),
  );
  const bindings = (await listAgentBindings(db, workspaceId)).filter(
    (b) => b.runnerId === runnerId && !b.legacy && b.removedAt === null,
  );
  await recordRunnerAccountCapability(
    db,
    runnerId,
    { protocol: 1, bindings: bindings.map((b) => ({ bindingId: b.id, agent: b.agent })) },
    now,
  );
  return binding;
}

export async function boundPlacementAccounts(db: Db) {
  const rows = await db.run((q) =>
    q.all(
      q.orm
        .select({
          workspaceId: q.t.runner.workspaceId,
          runnerId: q.t.runner.id,
          agent: q.t.runnerAgentPolicy.agent,
          now: q.t.runner.createdAt,
        })
        .from(q.t.runner)
        .innerJoin(q.t.runnerAgentPolicy, eq(q.t.runner.id, q.t.runnerAgentPolicy.runnerId))
        .where(eq(q.t.runnerAgentPolicy.ready, 1)),
    ),
  );
  for (const row of rows)
    await boundRunnerAccount(
      db,
      row.workspaceId,
      row.runnerId,
      row.agent as RunnerCodingAgent,
      row.now,
    );
}

export function* boundAccountSteps(q: import("../src/db").Q, runnerId: string) {
  const b = q.t.agentAccountBinding;
  const row = yield* q.one(
    q.orm
      .select()
      .from(b)
      .where(and(eq(b.runnerId, runnerId), eq(b.legacy, 0))),
  );
  if (!row) throw new Error("Missing fixture binding");
  return { accountId: row.accountId, bindingId: row.id, named: true };
}

export function boundHeartbeat(
  db: Db,
  work: ReturnType<typeof import("../src/runner-work").createRunnerWork>,
) {
  const heartbeat = work.heartbeat;
  work.heartbeat = async (...args) => {
    const bindings = await db.run((q) =>
      q.all(
        q.orm
          .select({ bindingId: q.t.agentAccountBinding.id, agent: q.t.agentAccountBinding.agent })
          .from(q.t.agentAccountBinding)
          .where(eq(q.t.agentAccountBinding.runnerId, args[0])),
      ),
    );
    args[11] = {
      protocol: 1,
      bindings: bindings
        .filter((b) => !b.bindingId.startsWith("legacy_"))
        .map((b) => ({ ...b, agent: b.agent as RunnerCodingAgent })),
    };
    return heartbeat(...args);
  };
}

export function boundResultSubmissions(
  db: Db,
  results: ReturnType<typeof import("../src/runner-results").createRunnerResults>,
  health: ReturnType<typeof import("../src/runner-health").createRunnerHealth>,
) {
  async function echo<T extends { commandId: string }>(result: T): Promise<T> {
    const account = await db.run((q) => commandAccountSteps(q, result.commandId));
    return account?.named
      ? { ...result, account: { accountId: account.accountId, bindingId: account.bindingId } }
      : result;
  }
  const submit = results.submit;
  results.submit = async (input) => submit({ ...input, result: await echo(input.result) });
  const probe = health.submit;
  health.submit = async (runnerId, result) => probe(runnerId, await echo(result));
}
