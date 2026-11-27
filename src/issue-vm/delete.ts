import { configFromSections, issueVmSettings } from "../config";
import {
  closeIssueVmAwakeSteps,
  deletingIssueVmsSteps,
  errorText,
  issueVmsToDeleteSteps,
  moveIssueVmSteps,
  readSettingSectionsSteps,
  type Db,
  type IssueVm,
  type IssueVmMove,
} from "../db";
import { journal } from "../journal";
import type { IssueVmDrivers } from "./dispatch";
import { revokeIssueVmRunnerSteps } from "./records";

const ISSUE_VM_DELETE_MS = 5 * 60_000;
export const ISSUE_VM_DELETE_RETRY_MS = 60_000;
const DAY = 86_400_000;
const MAX_FAILURE = 500;

type IssueVmDeleter = { claim(): Promise<string[]>; sweep(): Promise<void> };

export function createIssueVmDeleter(
  store: Db,
  options: { drivers: IssueVmDrivers; now?: () => number; deleteMs?: number; retryMs?: number },
): IssueVmDeleter {
  const now = options.now ?? Date.now;
  const deleteMs = options.deleteMs ?? ISSUE_VM_DELETE_MS;
  const retryMs = options.retryMs ?? ISSUE_VM_DELETE_RETRY_MS;

  const move = (vm: IssueVm, set: IssueVmMove, at: number) =>
    store.transaction(function* (q) {
      if (!(yield* moveIssueVmSteps(q, { id: vm.id, generation: vm.generation, set, now: at })))
        return false;
      if (set.state === "deleted") yield* revokeIssueVmRunnerSteps(q, vm, at);
      return true;
    });

  async function attempt(vm: IssueVm) {
    const driver = options.drivers[vm.provider];
    if (driver === undefined) return;
    if (!(await move(vm, { deadlineAt: now() + deleteMs + retryMs }, now()))) return;
    const begun = { ...vm, generation: vm.generation + 1 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deleteMs);
    const running = driver.delete(vm.id, {
      generation: begun.generation,
      signal: controller.signal,
    });
    running.catch(() => undefined);
    try {
      await Promise.race([
        running,
        new Promise((_, reject) =>
          controller.signal.addEventListener("abort", () =>
            reject(new Error("The VM was not deleted before its deadline")),
          ),
        ),
      ]);
    } catch (error) {
      const failure = errorText(error).slice(0, MAX_FAILURE);
      const at = now();
      if (await move(begun, { failure, deadlineAt: at + retryMs }, at))
        journal(`issue_vm_delete_failed vm=${vm.id} error=${JSON.stringify(failure)}`);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (await move(begun, { state: "deleted", failure: null, deadlineAt: null }, now()))
      journal(`issue_vm_deleted vm=${vm.id} item=${vm.itemId}`);
  }

  return {
    async claim() {
      const at = now();
      const claimed = await store.transaction(function* (q) {
        const sections = yield* readSettingSectionsSteps(q, ["issue_vm"]);
        const days = issueVmSettings(configFromSections(sections).issueVm).deleteAfterDays;
        const found = yield* issueVmsToDeleteSteps(q, { asleepBefore: at - days * DAY });
        const moved: IssueVm[] = [];
        for (const vm of found) {
          if (options.drivers[vm.provider] === undefined) continue;
          const set = {
            state: "deleting",
            operation: null,
            deadlineAt: null,
            failure: null,
          } as const;
          if (!(yield* moveIssueVmSteps(q, { id: vm.id, generation: vm.generation, set, now: at })))
            continue;
          yield* closeIssueVmAwakeSteps(q, { issueVmId: vm.id, now: at });
          moved.push(vm);
        }
        return moved;
      });
      for (const vm of claimed)
        journal(`issue_vm_deleting vm=${vm.id} item=${vm.itemId} from=${vm.state}`);
      return claimed.map((vm) => vm.id);
    },
    async sweep() {
      const at = now();
      const due = (await store.run((q) => deletingIssueVmsSteps(q))).filter(
        (vm) => vm.deadlineAt === null || vm.deadlineAt <= at,
      );
      await Promise.all(
        due.map((vm) =>
          attempt(vm).catch((error: unknown) => {
            journal(`issue_vm_delete_failed vm=${vm.id} error=${JSON.stringify(errorText(error))}`);
          }),
        ),
      );
    },
  };
}
