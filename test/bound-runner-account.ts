import * as database from "../src/db";
import { runnerHostVersionSteps } from "../src/db";
import type { RunnerCodingAgent } from "../src/runner-protocol";
import { bindFixtureAccounts, CURRENT_RUNNER_VERSION } from "./pglite-fixtures";
export async function boundPlacementAccounts(db: database.Db) {
  await bindFixtureAccounts(db);
  const rows = await db.run((q) => q.all(q.orm.select().from(q.t.runner)));
  for (const row of rows)
    if ((await db.run((q) => runnerHostVersionSteps(q, row.id))) === null)
      await database.recordRunnerHostStatus(
        db,
        row.id,
        { runnerVersion: CURRENT_RUNNER_VERSION },
        row.createdAt,
      );
}
export function* boundAccountSteps(q: database.Q, runnerId: string) {
  const runner = yield* database.getRunnerSteps(q, runnerId);
  const row =
    runner &&
    (yield* database.listAgentBindingsSteps(q, runner.workspaceId)).find(
      (binding) => binding.runnerId === runnerId && !binding.legacy,
    );
  if (!row) throw new Error("Missing fixture binding");
  return { accountId: row.accountId, bindingId: row.id, named: true };
}
export function boundHeartbeat(
  db: database.Db,
  work: ReturnType<typeof import("../src/runner-work").createRunnerWork>,
) {
  const heartbeat = work.heartbeat;
  work.heartbeat = async (...args) => {
    const runner = await db.run((q) => database.getRunnerSteps(q, args[0]));
    const bindings = runner ? await database.listAgentBindings(db, runner.workspaceId) : [];
    args[11] = {
      protocol: 1,
      bindings: bindings
        .filter((b) => b.runnerId === args[0] && !b.legacy)
        .map((b) => ({ bindingId: b.id, agent: b.agent as RunnerCodingAgent })),
    };
    return heartbeat(...args);
  };
}
export function boundResultSubmissions(
  db: database.Db,
  results: ReturnType<typeof import("../src/runner-results").createRunnerResults>,
  health: ReturnType<typeof import("../src/runner-health").createRunnerHealth>,
) {
  async function echo<T extends { commandId: string }>(result: T): Promise<T> {
    const account = await db.run((q) => database.commandAccountSteps(q, result.commandId));
    return account?.named
      ? { ...result, account: { accountId: account.accountId, bindingId: account.bindingId } }
      : result;
  }
  const submit = results.submit;
  results.submit = async (input) => submit({ ...input, result: await echo(input.result) });
  const probe = health.submit;
  health.submit = async (runnerId, result) => probe(runnerId, await echo(result));
}
