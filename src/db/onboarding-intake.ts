import type { Database } from "bun:sqlite";
import type { RepositoryBinding, TaskMode } from "../core";
import { bindWorkItemRepository, getWorkItemRepository } from "./repositories";
import { getTaskMode, saveTaskMode, taskRequiresRepository } from "./tasks";
import { immediate } from "./tx";

export type OnboardingAdmission = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  userId: string;
  linearUserId: string;
  issueId: string;
  issueFingerprint: string;
  revision: number;
  fingerprint: string;
  mode: TaskMode;
  repositoryContext: boolean;
  repository: RepositoryBinding | null;
  permission: "read" | "push" | null;
  runnerId: string;
  runnerFence: number;
};

export function readOnboardingItemBinding(
  db: Database,
  itemId: string,
): OnboardingAdmission | null {
  const row = db
    .query<{ snapshot: string }, [string]>(
      "SELECT snapshot FROM onboarding_item_binding WHERE item_id=?",
    )
    .get(itemId);
  return row ? (JSON.parse(row.snapshot) as OnboardingAdmission) : null;
}

export function bindOnboardingIntake(
  db: Database,
  admission: OnboardingAdmission,
  items: readonly { id: string; linearIssueId: string }[],
  assertAdmission: (value: OnboardingAdmission) => void,
) {
  return immediate(db, () => {
    assertAdmission(admission);
    if (items.length !== 1 || items[0]?.linearIssueId !== admission.issueId)
      throw new Error("Extra issues require their own onboarding answer.");
    const item = items[0];
    const stored = db
      .query<{ owner: string | null; actor: string | null; session: string | null }, [string]>(
        "SELECT owner_user_id AS owner,delegated_by AS actor,session_key AS session FROM work_item WHERE id=?",
      )
      .get(item.id);
    if (
      !stored ||
      stored.session !== admission.sessionId ||
      (stored.owner !== null && stored.owner !== admission.userId) ||
      (stored.actor !== null && stored.actor !== admission.linearUserId)
    )
      throw new Error("Canonical intake ownership conflicts with onboarding.");
    const existing = readOnboardingItemBinding(db, item.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(admission))
      throw new Error("The accepted onboarding binding is immutable.");
    const repository = getWorkItemRepository(db, item.id);
    if (repository && JSON.stringify(repository) !== JSON.stringify(admission.repository))
      throw new Error("Canonical repository conflicts with onboarding.");
    if (admission.repository) bindWorkItemRepository(db, item.id, admission.repository);
    const mode = getTaskMode(db, item.id);
    if (
      mode !== null &&
      (mode !== admission.mode ||
        taskRequiresRepository(db, item.id) !== admission.repositoryContext)
    )
      throw new Error("Canonical task mode conflicts with onboarding.");
    saveTaskMode(db, item.id, admission.mode, admission.generation, admission.repositoryContext);
    db.run("UPDATE work_item SET owner_user_id=?,delegated_by=? WHERE id=?", [
      admission.userId,
      admission.linearUserId,
      item.id,
    ]);
    db.run(
      "INSERT OR IGNORE INTO onboarding_item_binding(item_id,session_id,generation,readiness_revision,fingerprint,snapshot) VALUES(?,?,?,?,?,?)",
      [
        item.id,
        admission.sessionId,
        admission.generation,
        admission.revision,
        admission.fingerprint,
        JSON.stringify(admission),
      ],
    );
    assertAdmission(admission);
  });
}
