import {
  listSkills,
  recordRunnerCapacity,
  recordRunnerSkills,
  teamRepositoryAllowedSql,
} from "../db";
import type { KeyObject } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  getLinearSessionAccess,
  getLinearSession,
  getTaskMode,
  getTaskModeGeneration,
  getWorkItem,
  getWorkItemRepository,
  immediate,
  recordRunnerHostStatus,
  runnerHasCapacity,
  type RunnerHostSample,
  taskRequiresRepository,
  workspaceSessionIds,
} from "../db";
import {
  RunnerCommandSchema,
  RunnerEventSchema,
  type RunnerEvent,
  signRunnerCommand,
  type RunnerCommand,
  type RunnerInstalledSkill,
  type RunnerSkill,
  type SignedRunnerCommand,
} from "../runner-protocol";
import { workspaceSecret, workspaceTokenHash } from "../workspace";
import { findOpenQuestion } from "../questions";

export { RunnerEventSchema, type RunnerEvent } from "../runner-protocol";
type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "task" }>;
type Assignment = {
  runId: string;
  runnerId: string;
  workspaceId: string;
  generation: number;
  runnerFence: number;
  commandId: string;
  leaseUntil: number;
  lastSequence: number;
  endedAt: number | null;
};
const columns =
  "run_id AS runId,runner_id AS runnerId,workspace_id AS workspaceId,generation,runner_fence AS runnerFence,command_id AS commandId,lease_until AS leaseUntil,last_sequence AS lastSequence,ended_at AS endedAt";

export class RunnerWorkFencedError extends Error {
  override readonly name = "RunnerWorkFencedError";
}

export function createRunnerWork(options: {
  db: Database;
  keyId: string;
  privateKey: KeyObject;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  function assignment(runId: string) {
    return db
      .query<Assignment, [string]>(`SELECT ${columns} FROM runner_work WHERE run_id=?`)
      .get(runId);
  }
  function availableIdentity(id: string) {
    return db
      .query<{ workspaceId: string; userId: string; fence: number; status: string }, [string]>(
        `SELECT r.workspace_id AS workspaceId,r.owner_user_id AS userId,r.fence,r.status FROM runner r
      JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
      WHERE r.id=? AND r.revoked_at IS NULL AND r.status<>'revoked' AND m.active=1`,
      )
      .get(id);
  }
  /** Registered skills a runner should have installed. Removed ones are left out, so runners delete them. */
  function skillManifest(): RunnerSkill[] {
    return listSkills(db)
      .filter((skill) => skill.removedAt === null)
      .map(({ name, version, sha256, sizeBytes, agents }) => ({
        name,
        version,
        sha256,
        sizeBytes,
        agents,
      }));
  }
  function runner(id: string) {
    const row = availableIdentity(id);
    if (!row) throw new Error("Runner identity is unavailable.");
    return row;
  }
  function activeTask(runId: string, allowPendingQuestion = false) {
    const execution = db
      .query<{ itemId: string }, [string]>(
        "SELECT item_id AS itemId FROM run WHERE id=? AND status IN ('provisioning','active')",
      )
      .get(runId);
    const item = execution ? getWorkItem(db, execution.itemId) : null;
    if (
      !item ||
      item.currentRunId !== runId ||
      item.cancelRequested ||
      !["running", "verifying", "awaiting_input"].includes(item.state)
    )
      throw new Error("Run is no longer active.");
    const sessionId = item.sessionKey;
    if (!sessionId || getLinearSessionAccess(db, sessionId) !== "allowed")
      throw new Error("Linear task access is unavailable.");
    if (item.state === "awaiting_input" && !allowPendingQuestion) {
      const question = findOpenQuestion(db, sessionId);
      if (question?.itemId !== item.id || question.runId !== runId)
        throw new Error("Run has no matching open question.");
    }
    return { item, sessionId };
  }
  function task(runId: string, workspaceId: string, allowPendingQuestion = false) {
    const { item, sessionId } = activeTask(runId, allowPendingQuestion);
    const repository = getWorkItemRepository(db, item.id);
    if (!repository) throw new Error("Run repository is not bound.");
    const mapped = db
      .query(
        `SELECT 1 FROM workspace w JOIN linear_session s ON s.organization_id=w.linear_organization_id WHERE w.id=?1 AND s.session_id=?2 AND ${teamRepositoryAllowedSql("w.id", "s.team_id", "lower(?3)")}`,
      )
      .get(workspaceId, sessionId, `${repository.owner}/${repository.repo}`);
    if (!mapped) throw new Error("Run is outside the runner workspace repository access.");
    return { item, repository };
  }
  function responseTask(
    runId: string,
    workspaceId: string,
    allowPendingQuestion = false,
    userId?: string,
  ) {
    const { item, sessionId } = activeTask(runId, allowPendingQuestion);
    const session = getLinearSession(db, sessionId);
    const purpose = getTaskMode(db, item.id);
    const installation = db
      .query<{ clientId: string | null }, [string]>(
        "SELECT oauth_client_id AS clientId FROM linear_session WHERE session_id=?",
      )
      .get(sessionId);
    if (
      !session ||
      session.stoppedAt !== null ||
      !installation?.clientId ||
      (purpose !== "answer" && purpose !== "artifact") ||
      !db
        .query("SELECT 1 FROM workspace WHERE id=? AND linear_organization_id=?")
        .get(workspaceId, session.organizationId) ||
      (userId !== undefined &&
        !workspaceSessionIds(db, workspaceId, userId, installation.clientId).includes(sessionId))
    )
      throw new RunnerWorkFencedError("Linear response task authority changed");
    return {
      item,
      sessionId,
      sessionGeneration: session.generation,
      taskModeGeneration: getTaskModeGeneration(db, item.id),
      purpose,
      repository: taskRequiresRepository(db, item.id)
        ? task(runId, workspaceId, allowPendingQuestion).repository
        : undefined,
    };
  }
  function bindTask(
    command: Extract<WorkCommand, { type: "task" }>,
    current: ReturnType<typeof responseTask>,
  ) {
    if (
      command.itemId !== current.item.id ||
      command.sessionId !== current.sessionId ||
      command.sessionGeneration !== current.sessionGeneration ||
      command.taskModeGeneration !== current.taskModeGeneration ||
      command.purpose !== current.purpose ||
      (command.repository === undefined) !== (current.repository === undefined) ||
      (command.repository &&
        (!current.repository ||
          command.repository.owner !== current.repository.owner ||
          command.repository.repo !== current.repository.repo ||
          command.repository.remoteUrl !== current.repository.remoteUrl))
    )
      throw new RunnerWorkFencedError("Linear response task binding changed");
  }
  function live(
    runnerId: string,
    runId: string,
    generation: number,
    at: number,
    allowPendingQuestion = false,
  ): Assignment {
    const identity = runner(runnerId);
    const work = assignment(runId);
    if (
      !work ||
      work.runnerId !== runnerId ||
      work.workspaceId !== identity.workspaceId ||
      work.generation !== generation ||
      work.runnerFence !== identity.fence ||
      work.endedAt !== null ||
      work.leaseUntil <= at
    )
      throw new RunnerWorkFencedError("Runner work is fenced or its lease expired.");
    const command = workCommand(work);
    if (command.expiresAt <= at) throw new RunnerWorkFencedError("Runner command expired.");
    if (command.type === "task") {
      bindTask(
        command,
        responseTask(runId, work.workspaceId, allowPendingQuestion, identity.userId),
      );
      return work;
    }
    const current = task(runId, work.workspaceId, allowPendingQuestion);
    if (
      current.item.id !== command.itemId ||
      current.repository.owner !== command.repository.owner ||
      current.repository.repo !== command.repository.repo ||
      current.repository.remoteUrl !== command.repository.remoteUrl
    )
      throw new Error("Run repository binding changed.");
    return work;
  }
  function workCommand(work: Assignment): WorkCommand {
    const row = db
      .query<{ envelope: string }, [string]>("SELECT envelope FROM runner_command WHERE id=?")
      .get(work.commandId);
    if (!row) throw new Error("Run command is unavailable.");
    const envelope = JSON.parse(row.envelope) as { payload: string };
    const command = RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")),
    );
    if (
      (command.type !== "run" && command.type !== "review" && command.type !== "task") ||
      command.runId !== work.runId ||
      command.runnerId !== work.runnerId ||
      command.workspaceId !== work.workspaceId ||
      command.generation !== work.generation
    )
      throw new Error("Run command binding changed.");
    return command;
  }
  function authorized(
    input: {
      runnerId: string;
      runId: string;
      generation: number;
      token: string;
    },
    allowPendingQuestion = false,
  ): Assignment {
    const at = now();
    const work = live(input.runnerId, input.runId, input.generation, at, allowPendingQuestion);
    const grant = db
      .query(
        "SELECT 1 FROM runner_work_grant WHERE token_hash=? AND run_id=? AND generation=? AND expires_at>?",
      )
      .get(workspaceTokenHash(input.token), input.runId, input.generation, at);
    if (!grant) throw new Error("Run grant is invalid or expired.");
    return work;
  }
  function queue(command: RunnerCommand) {
    const envelope = signRunnerCommand({
      keyId: options.keyId,
      privateKey: options.privateKey,
      command,
    });
    db.run(
      "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at) VALUES(?,?,?,?,?,?,?)",
      [
        command.id,
        command.runnerId,
        "runId" in command ? command.runId : null,
        "generation" in command ? command.generation : null,
        command.type,
        JSON.stringify(envelope),
        command.expiresAt,
      ],
    );
    return envelope;
  }
  return {
    identity(runnerId: string) {
      return runner(runnerId);
    },
    scope(runId: string, workspaceId: string) {
      return task(runId, workspaceId);
    },
    scopeTask(runId: string, workspaceId: string, userId?: string) {
      return responseTask(runId, workspaceId, false, userId);
    },
    current(runId: string, generation: number) {
      const assigned = assignment(runId);
      if (!assigned) throw new RunnerWorkFencedError("Runner work is unavailable.");
      const current = live(assigned.runnerId, runId, generation, now());
      return { assignment: current, command: workCommand(current) };
    },
    assign(input: WorkCommand) {
      const command = RunnerCommandSchema.parse(input);
      if (command.type !== "run" && command.type !== "review" && command.type !== "task")
        throw new Error("Work command is required.");
      return immediate(db, () => {
        const at = now();
        const accepting = runner(command.runnerId);
        if (
          accepting.status !== "active" ||
          accepting.workspaceId !== command.workspaceId ||
          command.issuedAt > at ||
          command.expiresAt <= at
        )
          throw new Error("Runner is not accepting this assignment.");
        if (
          db
            .query(
              "SELECT 1 FROM runner_command c WHERE c.runner_id=? AND c.kind='cancel' AND c.acknowledged_at IS NULL AND NOT EXISTS(SELECT 1 FROM runner_command a WHERE a.runner_id=c.runner_id AND a.run_id=c.run_id AND a.generation=c.generation AND a.kind='cancel' AND a.ordinal>c.ordinal AND a.acknowledged_at IS NOT NULL)",
            )
            .get(command.runnerId)
        )
          throw new Error("Runner cancellation teardown is still pending.");
        if (!runnerHasCapacity(db, command.runnerId, at, command.runId))
          throw new Error("Runner is occupied by active work.");
        if (command.type === "task")
          bindTask(
            command,
            responseTask(command.runId, command.workspaceId, false, accepting.userId),
          );
        else {
          const { item, repository } = task(command.runId, command.workspaceId);
          if (
            item.id !== command.itemId ||
            repository.owner !== command.repository.owner ||
            repository.repo !== command.repository.repo ||
            repository.remoteUrl !== command.repository.remoteUrl
          )
            throw new Error("Run assignment repository or task changed.");
        }
        const previous = assignment(command.runId);
        if (
          command.generation !== (previous?.generation ?? 0) + 1 ||
          (previous?.endedAt === null &&
            previous.leaseUntil > at &&
            availableIdentity(previous.runnerId)?.fence === previous.runnerFence)
        )
          throw new Error("Run assignment generation conflicts.");
        const leaseUntil = Math.min(command.expiresAt, at + 60_000);
        const envelope = queue(command);
        db.run(
          `INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET runner_id=excluded.runner_id,workspace_id=excluded.workspace_id,generation=excluded.generation,runner_fence=excluded.runner_fence,command_id=excluded.command_id,lease_until=excluded.lease_until,last_sequence=0,consumed_sequence=0,ended_at=NULL`,
          [
            command.runId,
            command.runnerId,
            command.workspaceId,
            command.generation,
            accepting.fence,
            command.id,
            leaseUntil,
          ],
        );
        db.run("DELETE FROM runner_work_grant WHERE run_id=?", [command.runId]);
        return { envelope, leaseUntil };
      });
    },
    enqueue(input: RunnerCommand) {
      const command = RunnerCommandSchema.parse(input);
      if (command.type === "run" || command.type === "review" || command.type === "task")
        throw new Error("Use work assignment for run commands.");
      if (command.type === "helper") throw new Error("Use session assignment for helper commands.");
      return immediate(db, () => {
        const identity = runner(command.runnerId);
        if (
          identity.workspaceId !== command.workspaceId ||
          command.issuedAt > now() ||
          command.expiresAt <= now()
        )
          throw new Error("Command scope or lifetime is invalid.");
        if (command.type === "cancel") {
          const work = assignment(command.runId);
          if (!work || work.runnerId !== command.runnerId || work.generation !== command.generation)
            throw new Error("Cancellation assignment changed.");
          db.run("UPDATE runner_work SET ended_at=? WHERE run_id=? AND generation=?", [
            now(),
            work.runId,
            work.generation,
          ]);
          db.run("DELETE FROM runner_work_grant WHERE run_id=?", [work.runId]);
        }
        return queue(command);
      });
    },
    commands(runnerId: string): SignedRunnerCommand[] {
      runner(runnerId);
      const result: SignedRunnerCommand[] = [];
      let ordinal = 0;
      while (result.length < 16) {
        const rows = db
          .query<
            { ordinal: number; envelope: string; runId: string | null; generation: number | null },
            [string, number, number, number]
          >(
            `SELECT c.ordinal,c.envelope,c.run_id AS runId,c.generation FROM runner_command c
            LEFT JOIN runner_work w ON w.run_id=c.run_id
            WHERE c.runner_id=? AND c.acknowledged_at IS NULL AND c.expires_at>? AND c.ordinal>?
            AND (c.kind NOT IN ('run','review') OR
              (w.runner_id=c.runner_id AND w.generation=c.generation AND w.ended_at IS NULL AND w.lease_until>?))
            ORDER BY c.ordinal LIMIT 64`,
          )
          .all(runnerId, now(), ordinal, now());
        for (const row of rows) {
          ordinal = row.ordinal;
          const envelope = JSON.parse(row.envelope) as SignedRunnerCommand;
          const payload = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString("utf8"),
          ) as RunnerCommand;
          if (payload.type === "run" || payload.type === "review" || payload.type === "task") {
            try {
              live(runnerId, row.runId!, row.generation!, now());
            } catch {
              continue;
            }
          }
          result.push(envelope);
          if (result.length === 16) break;
        }
        if (rows.length < 64) break;
      }
      return result;
    },
    acknowledge(runnerId: string, commandId: string) {
      runner(runnerId);
      if (
        db.run(
          "UPDATE runner_command SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=? AND runner_id=?",
          [now(), commandId, runnerId],
        ).changes !== 1
      )
        throw new Error("Runner command is unknown.");
    },
    /**
     * `ceiling` comes from runners that apply the desired concurrency from the reply. `installed`
     * comes from runners that install skills; only they get the skill manifest back.
     */
    heartbeat(
      runnerId: string,
      capacity = 1,
      host: RunnerHostSample = {},
      ceiling?: number,
      installed?: readonly RunnerInstalledSkill[],
    ) {
      return immediate(db, () => {
        runner(runnerId);
        const concurrency = recordRunnerCapacity(db, runnerId, capacity, ceiling);
        const at = now();
        db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [at, runnerId]);
        if (Object.values(host).some((value) => value !== undefined))
          recordRunnerHostStatus(db, runnerId, host, at);
        const skills: RunnerSkill[] | undefined = installed && skillManifest();
        if (installed) recordRunnerSkills(db, runnerId, installed, at);
        const rows = db
          .query<Assignment, [string]>(
            `SELECT ${columns} FROM runner_work WHERE runner_id=? AND ended_at IS NULL`,
          )
          .all(runnerId);
        const leases: { runId: string; generation: number; expiresAt: number }[] = [];
        const fenced: { runId: string; generation: number }[] = [];
        for (const row of rows) {
          try {
            live(runnerId, row.runId, row.generation, at, true);
            const expiresAt = Math.min(workCommand(row).expiresAt, at + 60_000);
            db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [expiresAt, row.runId]);
            leases.push({ runId: row.runId, generation: row.generation, expiresAt });
          } catch {
            db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [at, row.runId]);
            db.run("DELETE FROM runner_work_grant WHERE run_id=?", [row.runId]);
            fenced.push({ runId: row.runId, generation: row.generation });
          }
        }
        return {
          leases,
          fenced,
          ...(concurrency === undefined ? {} : { concurrency }),
          ...(skills === undefined ? {} : { skills }),
        };
      });
    },
    /** The registered bundle a runner may download: only the current pin of a skill that is not removed. */
    skillBundle(runnerId: string, name: string, version: string): RunnerSkill {
      runner(runnerId);
      const skill = skillManifest().find((entry) => entry.name === name);
      if (!skill || skill.version !== version) throw new Error("Skill bundle is not registered.");
      return skill;
    },
    issueGrant(input: { runnerId: string; runId: string; commandId: string; generation: number }) {
      return immediate(db, () => {
        const work = live(input.runnerId, input.runId, input.generation, now());
        if (work.commandId !== input.commandId) throw new Error("Run command changed.");
        const token = workspaceSecret();
        const expiresAt = Math.min(work.leaseUntil, now() + 60_000);
        db.run("DELETE FROM runner_work_grant WHERE run_id=?", [input.runId]);
        db.run("INSERT INTO runner_work_grant VALUES(?,?,?,?)", [
          workspaceTokenHash(token),
          input.runId,
          input.generation,
          expiresAt,
        ]);
        return { token, expiresAt };
      });
    },
    event(input: {
      runnerId: string;
      runId: string;
      generation: number;
      sequence: number;
      token: string;
      event: RunnerEvent;
    }) {
      const event = JSON.stringify(RunnerEventSchema.parse(input.event));
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
        throw new Error("Event sequence is invalid.");
      return immediate(db, () => {
        const at = now();
        const saved = db
          .query<{ payload: string }, [string, number, number]>(
            "SELECT payload FROM runner_event WHERE run_id=? AND generation=? AND sequence=?",
          )
          .get(input.runId, input.generation, input.sequence);
        const work = authorized(input, saved !== null);
        const command = workCommand(work);
        if (
          command.type === "task" &&
          (input.event.type === "candidate" ||
            (command.purpose === "answer" && input.event.type === "artifact"))
        )
          throw new Error("Response task event is not authorized");
        if (saved) {
          if (saved.payload !== event) throw new Error("Event replay changed its payload.");
          return { duplicate: true };
        }
        if (input.sequence !== work.lastSequence + 1) throw new Error("Event sequence has a gap.");
        db.run("INSERT INTO runner_event VALUES(?,?,?,?,?)", [
          input.runId,
          input.generation,
          input.sequence,
          event,
          at,
        ]);
        db.run("UPDATE runner_work SET last_sequence=? WHERE run_id=?", [
          input.sequence,
          input.runId,
        ]);
        return { duplicate: false };
      });
    },
    authorize(input: { runnerId: string; runId: string; generation: number; token: string }) {
      const work = authorized(input);
      const command = workCommand(work);
      return {
        command,
        branch: command.type === "task" ? null : getWorkItem(db, command.itemId)!.branchName,
      };
    },
    finish(runId: string, generation: number) {
      immediate(db, () => {
        if (
          db.run(
            "UPDATE runner_work SET ended_at=? WHERE run_id=? AND generation=? AND ended_at IS NULL",
            [now(), runId, generation],
          ).changes !== 1
        )
          throw new Error("Run assignment changed.");
        db.run("DELETE FROM runner_work_grant WHERE run_id=?", [runId]);
      });
    },
  };
}
export type RunnerWork = ReturnType<typeof createRunnerWork>;
