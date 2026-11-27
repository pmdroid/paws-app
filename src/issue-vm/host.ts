import { setTimeout as delay } from "node:timers/promises";
import {
  closeIssueVmAwakeSteps,
  hostIssueVmUnitSteps,
  runnerStandingSteps,
  updateLiveIssueVmStateSteps,
  type Db,
  type HostIssueVmUnit,
} from "../db";
import type { IssueVmDriver, IssueVmFound } from "./lifecycle";

export type HostIssueVmDriverOptions = {
  store: Db;
  now?: () => number;
  pollMs?: number;
  staleMs?: number;
  deleteMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const GONE = ["deleting", "deleted", "failed"];

export function createHostIssueVmDriver(options: HostIssueVmDriverOptions): IssueVmDriver {
  const { store } = options;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 2_000;
  const staleMs = options.staleMs ?? 120_000;
  const deleteMs = options.deleteMs ?? 120_000;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));

  async function unit(id: string): Promise<HostIssueVmUnit & { hostRunnerId: string }> {
    const row = await store.run((q) => hostIssueVmUnitSteps(q, id));
    if (row === null) throw new Error(`There is no issue VM ${id}`);
    if (row.hostRunnerId === null) throw new Error(`Issue VM ${id} has no VM host`);
    return { ...row, hostRunnerId: row.hostRunnerId };
  }

  /**
   * Until the host reports the unit running (or stopped) after now. To create, also until the
   * VM's runner enrolled, once Paws gave its host a token for it: a host runner from before
   * bootstrap tokens never gets one, and its VMs count as created on a running unit alone.
   */
  async function until(
    id: string,
    signal: AbortSignal,
    running: boolean,
    { sleeping = false, enrolled = false } = {},
  ) {
    const since = now();
    for (;;) {
      signal.throwIfAborted();
      const row = await unit(id);
      if (
        row.unitSeenAt !== null &&
        row.unitSeenAt >= since &&
        row.unitRunning === running &&
        (!enrolled || row.tokenMintedAt === null || row.runnerId !== null)
      )
        return;
      if (sleeping && row.sleepRefusedAt !== null && row.sleepRefusedAt >= since)
        throw new Error(
          `Issue VM ${id} can't sleep yet: ${row.sleepRefusal ?? "the sign-in check failed"}`,
        );
      await wait(pollMs, signal);
    }
  }

  async function hostGone(hostRunnerId: string) {
    const standing = await store.run((q) => runnerStandingSteps(q, hostRunnerId));
    return standing === null || standing.revokedAt !== null;
  }

  return {
    create: (id, call) => until(id, call.signal, true, { enrolled: true }),
    wake: (id, call) => until(id, call.signal, true),
    sleep: (id, call) => until(id, call.signal, false, { sleeping: true }),
    async delete(id, call) {
      const { hostRunnerId } = await unit(id);
      const at = now();
      await store.transaction(function* (q) {
        yield* updateLiveIssueVmStateSteps(q, { id, state: "deleting", now: at });
        yield* closeIssueVmAwakeSteps(q, { issueVmId: id, now: at });
      });
      if (await hostGone(hostRunnerId)) return;
      await until(id, AbortSignal.any([call.signal, AbortSignal.timeout(deleteMs)]), false);
    },
    async reconcile(id): Promise<IssueVmFound> {
      const row = await store.run((q) => hostIssueVmUnitSteps(q, id));
      if (row === null || row.hostRunnerId === null) return "missing";
      if (await hostGone(row.hostRunnerId)) return "missing";
      if (row.unitSeenAt === null || now() - row.unitSeenAt > staleMs)
        throw new Error(`The VM host has not reported issue VM ${id} recently`);
      if (row.unitRunning) return "awake";
      return GONE.includes(row.state) ? "missing" : "asleep";
    },
  };
}
