import type { Database } from "bun:sqlite";

export type OnboardingVmScope = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  userId: string;
};

export function listOnboardingRunners(db: Database, scope: OnboardingVmScope, now: number) {
  return db
    .query<{ id: string; name: string; fence: number }, [string, string, number, number]>(
      `SELECT r.id,r.name,r.fence FROM runner r
      JOIN runner_certificate c ON c.runner_id=r.id
      WHERE r.workspace_id=? AND r.owner_user_id=? AND r.status='active' AND r.revoked_at IS NULL
      AND c.rowid=(SELECT MAX(latest.rowid) FROM runner_certificate latest WHERE latest.runner_id=r.id)
      AND c.revoked_at IS NULL AND c.not_before<=? AND c.accepted_until>?
      AND NOT EXISTS (SELECT 1 FROM runner_pairing p WHERE p.runner_id=r.id AND p.claimed_at IS NULL)
      ORDER BY r.created_at,r.id`,
    )
    .all(scope.workspaceId, scope.userId, now, now);
}

export function readOnboardingVm(db: Database, scope: OnboardingVmScope) {
  return db
    .query<{ runnerId: string; fence: number }, [string, number]>(
      "SELECT runner_id AS runnerId,runner_fence AS fence FROM onboarding_vm WHERE session_id=? AND generation=?",
    )
    .get(scope.sessionId, scope.generation);
}

export function saveOnboardingVm(
  db: Database,
  scope: OnboardingVmScope,
  runner: { id: string; fence: number },
  now: number,
) {
  db.run(
    `INSERT INTO onboarding_vm(session_id,generation,runner_id,runner_fence,selected_at) VALUES(?,?,?,?,?)
    ON CONFLICT(session_id,generation) DO UPDATE SET runner_id=excluded.runner_id,
    runner_fence=excluded.runner_fence,selected_at=excluded.selected_at`,
    [scope.sessionId, scope.generation, runner.id, runner.fence, now],
  );
}
