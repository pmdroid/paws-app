import {
  errorText,
  getWorkItemSteps,
  latestItemIssueVmSteps,
  latestSealedSnapshotSteps,
  markFailedIssueVmGoneSteps,
  setIssueVmWantSteps,
  undeletedFailedIssueVmsSteps,
  type Db,
  type IssueVm,
  type IssueVmProvider,
  type Steps,
} from "../db";
import { journal } from "../journal";
import { issueVmAdmissionSteps, type IssueVmAdmission } from "./admission";
import type { IssueVmDriver } from "./lifecycle";
import { recordIssueVmSteps } from "./records";

const ENDED_ITEM_STATES = ["completed", "merged", "cancelled", "failed"];

export type IssueVmSession = { runId: string; generation: number; sessionId: string };

export type IssueVmReplacement =
  | { failed: string; outcome: "replaced"; vm: string; session: IssueVmSession | null }
  | { failed: string; outcome: "waiting"; refusal: Exclude<IssueVmAdmission, { ok: true }> }
  | { failed: string; outcome: "not_needed" };

export type IssueVmReplacementResult = IssueVmReplacement & { oldDeleted: boolean };

export type IssueVmReplacer = { sweep(): Promise<IssueVmReplacementResult[]> };

export function createIssueVmReplacer(
  store: Db,
  options: { drivers: Partial<Record<IssueVmProvider, IssueVmDriver>>; now?: () => number },
): IssueVmReplacer {
  const now = options.now ?? Date.now;

  function replace(failed: IssueVm) {
    const at = now();
    return store.transaction(function* (q): Steps<IssueVmReplacement> {
      const item = yield* getWorkItemSteps(q, failed.itemId);
      const latest = yield* latestItemIssueVmSteps(q, failed.itemId);
      if (item === null || ENDED_ITEM_STATES.includes(item.state) || latest?.id !== failed.id)
        return { failed: failed.id, outcome: "not_needed" };
      const admission = yield* issueVmAdmissionSteps(q, { ...failed, at });
      if (!admission.ok) return { failed: failed.id, outcome: "waiting", refusal: admission };
      const { workspaceId, itemId, memberUserId, provider, hostRunnerId } = failed;
      const fields = { workspaceId, itemId, memberUserId, provider, hostRunnerId, now: at };
      const vm = yield* recordIssueVmSteps(q, fields);
      if (failed.want === "asleep") yield* setIssueVmWantSteps(q, { id: vm, want: "asleep" });
      const snapshot = item.currentRunId
        ? yield* latestSealedSnapshotSteps(q, item.currentRunId)
        : null;
      const session =
        snapshot === null
          ? null
          : {
              runId: item.currentRunId!,
              generation: snapshot.generation,
              sessionId: snapshot.sessionId,
            };
      return { failed: failed.id, outcome: "replaced", vm, session };
    });
  }

  async function removeOld(failed: IssueVm, driver: IssueVmDriver, keepRow: boolean) {
    const call = { generation: failed.generation, signal: new AbortController().signal };
    if ((await driver.reconcile(failed.id, call)) !== "missing")
      await driver.delete(failed.id, call);
    if (!keepRow)
      await store.run((q) => markFailedIssueVmGoneSteps(q, { id: failed.id, now: now() }));
  }

  async function handle(failed: IssueVm): Promise<IssueVmReplacementResult | null> {
    const driver = options.drivers[failed.provider];
    if (driver === undefined) return null;
    const replaced = await replace(failed);
    if (replaced.outcome === "waiting")
      journal(
        `issue_vm_replacement_waiting vm=${failed.id} item=${failed.itemId} reason=${replaced.refusal.reason}`,
      );
    if (replaced.outcome === "replaced")
      journal(
        `issue_vm_replaced vm=${failed.id} item=${failed.itemId} by=${replaced.vm} session=${replaced.session?.generation ?? "none"}`,
      );
    try {
      await removeOld(failed, driver, replaced.outcome === "waiting");
      return { ...replaced, oldDeleted: true };
    } catch (error) {
      journal(`issue_vm_delete_failed vm=${failed.id} error=${JSON.stringify(errorText(error))}`);
      return { ...replaced, oldDeleted: false };
    }
  }

  return {
    async sweep() {
      const failed = await store.run((q) => undeletedFailedIssueVmsSteps(q));
      const results = await Promise.all(
        failed.map((vm) =>
          handle(vm).catch((error: unknown) => {
            journal(
              `issue_vm_replacement_failed vm=${vm.id} error=${JSON.stringify(errorText(error))}`,
            );
            return null;
          }),
        ),
      );
      return results.filter((result) => result !== null);
    },
  };
}
