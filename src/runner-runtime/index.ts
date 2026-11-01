import { journalCaught, journalRejection } from "../journal";
import { closeSync, constants, fsyncSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prepareRepositorySnapshot } from "../acp";
import {
  isPushOutage,
  PUBLICATION_STAGING_FAILURE,
  pushOutageProbeDelayMs,
  runGitHubGit,
} from "../github";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { RUNNER_ARTIFACT_CHUNK_BYTES } from "../runner-artifacts";
import { RUNNER_TRANSCRIPT_CHUNK_BYTES } from "../runner-transcripts";
import {
  AGENT_SESSION_CHUNK_BYTES,
  AGENT_SESSION_MAX_BYTES,
  AgentSessionFinishSchema,
} from "../agent-sessions";
import { RunnerRequestError, type RunnerDaemon, type RunnerGrant } from "../runner-daemon";
import {
  createDirectWorkerSupervisor,
  publishRunnerJob,
  readRunnerResultFile,
  readRunnerResultRange,
  type RunnerBrokerClient,
  type RunnerSkillInstaller,
  type RunnerSpool,
  type RunnerResults,
} from "../runner-execution";
import {
  publishRunnerAnswer,
  runnerFollowUpRequestId,
  runnerHandoverRequestId,
  runnerCheckpointRequestId,
  runnerCheckpointPublishedId,
} from "../runner-answers";
import { CandidateRebaseConflict, createRunnerRepositories } from "../runner-repositories";
import {
  creditedLeaseUntil,
  PAWS_ALIVE_LEASE_SKEW_MS,
  RUNNER_LEASE_GRACE_MS,
  RunnerResultSchema,
  type RunnerResult,
} from "../runner-protocol";
import { openExecutionJournal, type Execution } from "../runner-journal";
import { openRunnerRuntimeInventory } from "./runtimes";
export {
  openRunnerAgents,
  RUNNER_AGENT_REQUESTS,
  RUNNER_AGENT_STATUS,
  RUNNER_AGENTS_BASE,
  type RunnerAgents,
} from "./agents";
import type { RunnerAgents } from "./agents";

export {
  openRunnerRuntimeInventory,
  RUNNER_RUNTIME_INVENTORY_LIMIT,
  type RunnerRuntimeInventory,
} from "./runtimes";

class RemoteFailure extends Error {}
class GitHubFailure extends RemoteFailure {}
const GITHUB_UNAVAILABLE = "GitHub git operation failed";

const CANDIDATE_PUSH_RETRY_MS = [0, 60_000, 120_000, 240_000, 480_000];
const PERMANENT_PUSH_REJECTION =
  /\[remote rejected\]|protected branch|\bGH0\d\d\b|Permission to \S+ denied|Repository not found|pre-receive hook declined/i;

async function remote<T>(
  operation: () => Promise<T>,
  unavailable = "Runner control plane is unavailable",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof RunnerRequestError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 429].includes(error.status)
    )
      throw error;
    throw new (unavailable === GITHUB_UNAVAILABLE ? GitHubFailure : RemoteFailure)(
      `${unavailable}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const workerResult = z.object({
  executionId: z.string(),
  commandId: z.string(),
  run: RunnerResultSchema.omit({
    executionId: true,
    commandId: true,
    candidateSha: true,
    reviewText: true,
    pushFailure: true,
  }).strip(),
  candidateSha: RunnerResultSchema.shape.candidateSha,
  reviewText: RunnerResultSchema.shape.reviewText,
});
type AuthorizedRequest = <T>(operation: (token: string) => Promise<T>) => Promise<T>;
type PushFailure = NonNullable<RunnerResult["pushFailure"]>;
type Active = {
  execution: Execution;
  abort: AbortController;
  deadline: number;
  accountedAt: number;
  idleMs: number;
  workMs: number;
  workLimitMs: number;
  /** Monotonic time of the heartbeat that reported the server lease and alive mark. */
  agreedAt?: number;
  /** Wall time of that heartbeat. */
  agreedWallAt?: number;
  /** Paws alive mark from that heartbeat. Absent when Paws did not offer offline credit. */
  serverAliveAt?: number;
  /** Lease expiry Paws reported then, before offline credit. */
  serverLeaseUntil?: number;
  /** Budget from that heartbeat. */
  offlineBudgetMs?: number;
  grant?: RunnerGrant;
  /** When `grant` was issued, so it is renewed halfway through its lifetime. */
  grantedAt?: number;
  task?: Promise<void>;
  delivering?: Promise<void>;
  stopped?: Promise<void>;
  dispatching?: Promise<void>;
  teardownConfirmed?: boolean;
  quiesced?: Promise<void>;
  publicationBranch?: string;
  followUps?: number;
  restarts?: number;
  pushTries?: number;
  pushAt?: number;
  /** Candidate pushes GitHub refused in a push outage; they never count toward `pushTries`. */
  outageTries?: number;
  /** Set once the worker's runtime install report is in the inventory. */
  runtimesRecorded?: boolean;
  sessionTries?: number;
  /**
   * Handovers Paws asked for: the deadline of one the worker has not heard yet, and how many it
   * was sent. Each request goes to the worker on its own, so a timed-out one can be asked again.
   */
  handover?: { pending?: number; sent: number };
  /** Checkpoints Paws asked for before a stop, and how many the worker was sent. */
  checkpoints?: { asked: number; sent: number };
  /**
   * The last WIP commit this execution published to the item's branch. Later pushes replace it,
   * since a checkpoint with uncommitted changes is not an ancestor of the agent's next commits.
   */
  checkpointSha?: string;
  /** How many checkpoints this execution pushed, each acknowledged to the worker. */
  checkpointsPublished?: number;
};

/** The session description the worker writes next to its bundle. */
const SessionMetadataSchema = AgentSessionFinishSchema.omit({
  generation: true,
  agentVersion: true,
}).extend({ agent: z.enum(["claude", "codex", "grok"]) });
const SESSION_UPLOAD_TRIES = 5;
const LEASE_PASSED = "lease deadline passed";
const fencedRefusal = (error: unknown): error is RunnerRequestError =>
  error instanceof RunnerRequestError &&
  (error.status === 409 || (error.status === 403 && /\bfenced\b/i.test(error.reason ?? "")));

export async function openRunnerRuntime(options: {
  root: string;
  daemon: Pick<
    RunnerDaemon,
    | "status"
    | "heartbeat"
    | "pollCommands"
    | "pendingCommands"
    | "acknowledgeCommand"
    | "issueRunGrant"
    | "sendEvent"
    | "answers"
    | "postResult"
    | "repositoryCredential"
    | "renewCertificate"
    | "uploadArtifact"
    | "uploadTranscript"
    | "finishTranscript"
  > &
    Partial<
      Pick<
        RunnerDaemon,
        "readInputs" | "followUps" | "uploadSession" | "finishSession" | "readSession"
      >
    >;
  spool: RunnerSpool;
  results: RunnerResults;
  repositoryRoot: string;
  home: string;
  broker?: RunnerBrokerClient;
  /** Installs registered skills from the heartbeat manifest and reports what is installed. */
  skills?: RunnerSkillInstaller;
  /** Reports the coding agent versions and forwards the ones Paws asks for to the installer. */
  agents?: RunnerAgents;
  networkGit?: Parameters<typeof createRunnerRepositories>[0]["networkGit"];
  now?: () => number;
  monotonic?: () => number;
  onError?: (error: Error) => void;
  /** Read before admitting work, so a lowered value holds back new work without stopping any. */
  concurrency?: number | (() => number);
  stopWaitMs?: number;
  deliveryWaitMs?: number;
  /** The first wait before a session upload is retried during restart recovery; it doubles. */
  sessionRetryMs?: number;
  /** First delay between stored-result attempts, doubling up to one minute. */
  resultRetryMs?: number;
}) {
  if (options.daemon.status().phase !== "paired")
    throw new Error("Runner must be paired before execution");
  const journal = openExecutionJournal(options.root);
  let closed = false;
  const resultDeliveries = new Map<string, Promise<void>>();
  const resultRetries = new Map<string, { tries: number; at: number; message: string }>();
  const broker =
    options.broker ??
    createDirectWorkerSupervisor({
      stateRoot: join(options.root, "workers"),
      spool: options.spool,
      results: options.results,
      skills: options.skills,
    });
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const report = (error?: unknown) =>
    options.onError?.(
      error instanceof Error ? error : new Error("Runner runtime operation failed"),
    );
  const runtimes = openRunnerRuntimeInventory({ root: options.root, now, onError: report });
  /** Move the worker's runtime install report into the inventory once it exists. */
  function collectRuntimes(entry: Active) {
    if (entry.runtimesRecorded) return;
    let raw: Buffer;
    try {
      raw = readRunnerResultFile(options.results, entry.execution.id, "runtimes.json");
    } catch (error) {
      journalCaught(
        error,
        "runner-runtime.collectRuntimes.readRunnerResultFile",
        entry.execution.command.itemId,
        "optional file may be absent",
      );
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        entry.runtimesRecorded = true;
        report(error);
      }
      return;
    }
    entry.runtimesRecorded = true;
    try {
      runtimes.record(JSON.parse(raw.toString("utf8")));
    } catch (caughtError1) {
      journalCaught(
        caughtError1,
        "runner-runtime.collectRuntimes.record",
        entry.execution.command.itemId,
      );
      report(new Error("Runner worker reported an invalid runtime list."));
    }
  }
  const deniedReported = new Set<string>();
  const settle = (
    work: readonly (Promise<unknown> | undefined)[],
    waitMs = options.stopWaitMs ?? 5_000,
  ) =>
    Promise.race([
      Promise.allSettled(work),
      new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref?.()),
    ]);
  const resumed: Execution[] = [];
  const restored = journal.executions(true);
  const recovering = restored.filter((execution) => !journal.resultPending(execution.id));
  const historical = [
    ...restored.filter((execution) => journal.resultPending(execution.id)),
    ...journal.unconfirmedTerminations(),
  ];
  const concurrency = () =>
    z
      .number()
      .int()
      .min(1)
      .max(16)
      .parse(
        typeof options.concurrency === "function"
          ? options.concurrency()
          : (options.concurrency ?? 1),
      );
  concurrency();
  const active = new Map<string, Active>();
  let ticking: Promise<void> | undefined;
  let pulsing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const leases = new Map<string, number>();
  const serverExpiry = new Map<string, number>();
  let unreachable = false;
  let advertisedBudget: number | undefined;
  let advertisedAliveAt: number | undefined;
  let agreedPulseAt: number | undefined;
  let agreedWallAt: number | undefined;
  const key = (command: { runId: string; generation: number }) =>
    `${command.runId}:${command.generation}`;
  for (const execution of resumed) {
    report(
      new Error(
        `Runner resumes publishing the finished turn of execution ${execution.id} for run ${execution.command.runId} after a restart`,
      ),
    );
    active.set(key(execution.command), {
      execution,
      abort: new AbortController(),
      deadline: monotonic(),
      accountedAt: monotonic(),
      idleMs: 0,
      workMs: 0,
      workLimitMs: Math.max(0, execution.command.expiresAt - now()),
    });
  }
  /**
   * While Paws is unreachable, move the deadline with `creditedLeaseUntil` and the alive mark
   * from the last heartbeat. No credit leaves the clamped deadline from that heartbeat.
   */
  function accountWork(entry: Active) {
    const at = monotonic();
    const elapsed = Math.max(0, at - entry.accountedAt);
    entry.accountedAt = at;
    const working =
      entry.execution.phase === "running" &&
      !entry.abort.signal.aborted &&
      broker.alive?.(entry.execution.id) !== false &&
      !journal.waiting(entry.execution.id);
    if (working) entry.workMs += elapsed;
    else if (entry.offlineBudgetMs !== undefined) {
      entry.idleMs += elapsed;
      entry.deadline += elapsed;
    }
  }
  function holdOffline(entry: Active) {
    accountWork(entry);
    if (
      !unreachable ||
      entry.offlineBudgetMs === undefined ||
      entry.agreedAt === undefined ||
      entry.agreedWallAt === undefined ||
      entry.serverAliveAt === undefined ||
      entry.serverLeaseUntil === undefined
    )
      return;
    const elapsed = Math.max(0, monotonic() - entry.agreedAt - entry.idleMs);
    const credited = creditedLeaseUntil({
      leaseUntil: entry.serverLeaseUntil,
      expiresAt: entry.execution.command.expiresAt,
      aliveAt: entry.serverAliveAt,
      now: entry.agreedWallAt + elapsed,
      budgetMs: entry.offlineBudgetMs,
      skewMs: PAWS_ALIVE_LEASE_SKEW_MS,
    });
    const authorityUntil = creditedLeaseUntil({
      leaseUntil: entry.serverLeaseUntil,
      expiresAt: entry.execution.command.expiresAt,
      aliveAt: entry.serverAliveAt,
      now: entry.serverAliveAt + entry.offlineBudgetMs,
      budgetMs: entry.offlineBudgetMs,
      skewMs: PAWS_ALIVE_LEASE_SKEW_MS,
    });
    entry.deadline = Math.min(
      entry.agreedAt + entry.idleMs + Math.max(0, credited - entry.agreedWallAt),
      entry.agreedAt + Math.max(0, authorityUntil - entry.agreedWallAt),
      entry.agreedAt +
        Math.min(
          entry.offlineBudgetMs,
          Math.max(0, entry.execution.command.expiresAt - entry.agreedWallAt),
        ) -
        RUNNER_LEASE_GRACE_MS,
    );
  }
  async function grant(entry: Active) {
    check(entry);
    // Renewed halfway through its lifetime: a busy Paws can take many seconds to answer a
    // request, and a grant that expires while the request waits refuses it with 403.
    const at = now();
    if (
      !entry.grant ||
      entry.grant.expiresAt <= at + 5000 ||
      at >= (entry.grantedAt ?? at) + (entry.grant.expiresAt - (entry.grantedAt ?? at)) / 2
    ) {
      const value = await remote(() =>
        options.daemon.issueRunGrant(entry.execution.command.runId, {
          commandId: entry.execution.command.id,
          generation: entry.execution.command.generation,
        }),
      );
      check(entry);
      entry.grant = value;
      entry.grantedAt = at;
    }
    return entry.grant.token;
  }
  async function interrupt(
    entry: Active,
    reason: string,
    notify = false,
    pushFailure?: PushFailure,
  ) {
    const first = !entry.abort.signal.aborted;
    entry.abort.abort();
    if (first)
      report(
        new Error(
          `Runner interrupted execution ${entry.execution.id} for run ${entry.execution.command.runId}: ${reason}`,
        ),
      );
    journal.phase(entry.execution.id, "cleaning");
    entry.execution.phase = "cleaning";
    entry.stopped ??= (async () => {
      await quiesce(entry);
      const publication =
        !pushFailure && !journal.hasResult(entry.execution.id)
          ? journal.publication(entry.execution.id)
          : undefined;
      if (publication && closed) return;
      if (publication && (!notify || reason === LEASE_PASSED)) {
        journal.refusePublication(entry.execution.id, reason);
        report(
          new Error(
            `Runner kept the finished turn of execution ${entry.execution.id} for run ${entry.execution.command.runId} without delivering it: ${reason}`,
          ),
        );
      } else if (notify) await fail(entry.execution, reason, pushFailure);
      journal.phase(entry.execution.id, "interrupted");
      entry.execution.phase = "interrupted";
      entry.teardownConfirmed = true;
    })().catch((error) => {
      entry.stopped = undefined;
      throw error;
    });
    await entry.stopped;
  }
  async function fail(execution: Execution, reason: string, pushFailure?: PushFailure) {
    const { command } = execution;
    if (journal.hasResult(execution.id)) return deliverResult(execution);
    if (command.type !== "run" && command.type !== "review" && command.type !== "task") return;
    const tail = (broker.log?.(execution.id) ?? "")
      .replace(/gh[opsu]_[A-Za-z0-9]{10,}/g, "[redacted]")
      .replace(/:\/\/[^\s/@]+@/g, "://[redacted]@");
    journal.saveResult(
      execution.id,
      RunnerResultSchema.parse({
        executionId: execution.id,
        commandId: command.id,
        role: command.type === "review" ? "reviewer" : "implementer",
        stopReason: "error",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        errorMessage:
          `The runner stopped this run: ${reason}.${tail ? `\n\nLast worker output:\n${tail}` : ""}`.slice(
            0,
            16_384,
          ),
        ...(pushFailure ? { pushFailure } : {}),
      }),
      true,
    );
    await deliverResult(execution);
  }
  function readWorkerResult(execution: Execution) {
    const worker = workerResult.parse(
      JSON.parse(
        readRunnerResultFile(options.results, execution.id, "result.json").toString("utf8"),
      ),
    );
    if (
      worker.executionId !== execution.id ||
      worker.commandId !== execution.command.id ||
      worker.run.role !== (execution.command.type === "review" ? "reviewer" : "implementer") ||
      (execution.command.type === "task" &&
        (worker.candidateSha !== undefined || worker.reviewText !== undefined))
    )
      throw new Error("Runner result identity mismatch");
    return worker;
  }
  async function recoverInterrupted(execution: Execution) {
    let worker: z.infer<typeof workerResult> | undefined;
    try {
      worker = readWorkerResult(execution);
    } catch (error) {
      journalCaught(
        error,
        "runner-runtime.recoverInterrupted.readWorkerResult",
        execution.command.itemId,
        "optional file may be absent",
      );
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        report(error);
        await fail(execution, "the runner restarted and the worker result is invalid");
        journal.phase(execution.id, "interrupted");
        return;
      }
    }
    const { run } = worker ?? {};
    if (
      run &&
      (run.stopReason !== "end_turn" ||
        run.errorMessage !== undefined ||
        run.authRequired ||
        run.timedOut ||
        run.cancelled)
    ) {
      journal.saveResult(
        execution.id,
        RunnerResultSchema.parse({
          ...run,
          executionId: execution.id,
          commandId: execution.command.id,
        }),
        true,
      );
      return;
    }
    report(
      new Error(
        `Runner interrupted execution ${execution.id} for run ${execution.command.runId}: the runner restarted; Paws recovers the run from its branch`,
      ),
    );
    journal.phase(execution.id, "interrupted");
  }
  function deliverResult(execution: Execution): Promise<void> {
    if (closed) return Promise.resolve();
    if ((resultRetries.get(execution.id)?.at ?? 0) > monotonic()) return Promise.resolve();
    const current = resultDeliveries.get(execution.id);
    if (current) return current;
    const delivery = sendResult(execution).finally(() => resultDeliveries.delete(execution.id));
    resultDeliveries.set(execution.id, delivery);
    return delivery;
  }
  async function sendResult(execution: Execution) {
    const { command } = execution;
    const pending = journal.pendingResult(execution.id);
    if (!pending) return;
    let credential: RunnerGrant | undefined;
    let issuedAt = 0;
    let granting = false;
    let posting = false;
    const token = async () => {
      const at = now();
      if (
        !credential ||
        credential.expiresAt <= at + 5000 ||
        at >= issuedAt + (credential.expiresAt - issuedAt) / 2
      ) {
        granting = true;
        credential = await options.daemon.issueRunGrant(command.runId, {
          commandId: command.id,
          generation: command.generation,
        });
        granting = false;
        issuedAt = at;
      }
      return credential.token;
    };
    const request: AuthorizedRequest = async (operation) => {
      for (let attempt = 0; ; attempt++) {
        if (closed) throw new RemoteFailure("Runner stopping");
        const sent = await token();
        if (closed) throw new RemoteFailure("Runner stopping");
        try {
          const value = await operation(sent);
          if (closed) throw new RemoteFailure("Runner stopping");
          return value;
        } catch (error) {
          if (!(error instanceof RunnerRequestError) || error.status !== 403) throw error;
          const grantExpired =
            now() >= credential!.expiresAt || /grant.*(invalid|expired)/i.test(error.reason ?? "");
          credential = undefined;
          if (attempt) {
            if (grantExpired) throw new RemoteFailure("Delivery grant expired");
            throw error;
          }
        }
      }
    };
    try {
      if (pending.failure) await prepareFailure(execution, token, request);
      posting = true;
      await request((sent) =>
        options.daemon.postResult(command.runId, command.generation, pending.result, sent),
      );
      journal.resultAccepted(execution.id);
      journal.phase(execution.id, pending.failure ? "interrupted" : "complete");
      resultRetries.delete(execution.id);
    } catch (error) {
      if (closed) return;
      const refused = (granting || posting) && fencedRefusal(error);
      if (refused) {
        journal.resultRejected(execution.id);
        journal.phase(execution.id, "interrupted");
        resultRetries.delete(execution.id);
        report(
          new Error(
            `Paws refused the stored result for execution ${execution.id}: ${error.message}`,
          ),
        );
      } else {
        const previous = resultRetries.get(execution.id);
        const message =
          error instanceof RunnerRequestError
            ? `${error.status}:${error.method}:${error.path}`
            : String(error).replace(/after \d+ ms/g, "");
        const tries = (previous?.tries ?? 0) + 1;
        resultRetries.set(execution.id, {
          tries,
          message,
          at:
            monotonic() +
            Math.min(
              60_000,
              (options.resultRetryMs ?? options.sessionRetryMs ?? 1000) *
                2 ** Math.min(tries - 1, 6),
            ),
        });
        if (message !== previous?.message) report(error);
      }
    }
  }
  async function prepareFailure(
    execution: Execution,
    token: () => Promise<string>,
    request: AuthorizedRequest,
  ) {
    const { command } = execution;
    try {
      if (!journal.transcriptSealed(execution.id)) {
        let raw: Buffer = Buffer.alloc(0);
        try {
          raw = readRunnerResultFile(options.results, execution.id, "events.jsonl");
        } catch (caughtError2) {
          journalCaught(caughtError2, "runner-runtime.fail.readRunnerResultFile", command.itemId);
        }

        journal.ingest(execution.id, raw);
        let { offset, consumed } = journal.transcriptCursor(execution.id);
        while (offset < consumed) {
          const bytes = raw.subarray(
            offset,
            Math.min(offset + RUNNER_TRANSCRIPT_CHUNK_BYTES, consumed),
          );
          await request((sent) =>
            options.daemon.uploadTranscript(
              command.runId,
              {
                generation: command.generation,
                executionId: execution.id,
                offset,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                data: bytes.toString("base64"),
              },
              sent,
            ),
          );
          journal.transcriptUploaded(execution.id, offset, offset + bytes.length);
          offset += bytes.length;
        }
        await request((sent) =>
          options.daemon.finishTranscript(
            command.runId,
            {
              generation: command.generation,
              executionId: execution.id,
              offset: consumed,
              sizeBytes: consumed,
              sha256: createHash("sha256").update(raw.subarray(0, consumed)).digest("hex"),
            },
            sent,
          ),
        );
        journal.sealTranscript(execution.id);
      }
    } catch (error) {
      if (
        !(error instanceof RunnerRequestError) ||
        error.status >= 500 ||
        [408, 429].includes(error.status) ||
        /grant.*(invalid|expired)/i.test(error.reason ?? "")
      )
        throw error;
      // Artifact refusal is not result refusal. Paws still needs the run's failure result.
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await uploadSession(execution, token, undefined, request);
        break;
      } catch (error) {
        if (closed) throw error;
        if (!(error instanceof RemoteFailure) || attempt >= SESSION_UPLOAD_TRIES) {
          skipSession(execution, error);
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, (options.sessionRetryMs ?? 1000) * 2 ** (attempt - 1)),
        );
      }
    }
  }
  /**
   * Uploads the agent session the worker bundled at the end of a run's turn, from the offset the
   * journal holds, then seals it with the runner's installed agent version.
   */
  async function uploadSession(
    execution: Execution,
    token: () => Promise<string>,
    guard: () => void = () => undefined,
    request: AuthorizedRequest = async (operation) => operation(await token()),
  ) {
    const { command } = execution;
    if (command.type !== "run" || !options.daemon.uploadSession || !options.daemon.finishSession)
      return;
    const cursor = journal.sessionCursor(execution.id);
    if (cursor.state) return;
    let raw: Buffer;
    try {
      raw = readRunnerResultFile(options.results, execution.id, "session.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journal.sessionDone(execution.id, "skipped");
      return;
    }
    const session = SessionMetadataSchema.parse(JSON.parse(raw.toString("utf8")));
    const agentVersion = options.agents
      ?.installed()
      ?.find((agent) => agent.agent === session.agent && agent.status === "current")?.version;
    if (!agentVersion) throw new Error(`The runner has no current ${session.agent} version`);
    let offset = cursor.offset;
    while (offset < session.sizeBytes) {
      const bytes = readRunnerResultRange(
        options.results,
        execution.id,
        "session.ndjson.gz",
        offset,
        Math.min(AGENT_SESSION_CHUNK_BYTES, session.sizeBytes - offset),
        AGENT_SESSION_MAX_BYTES,
      );
      if (!bytes.length) throw new Error("The agent session bundle is shorter than recorded");
      await remote(() =>
        request((sent) =>
          options.daemon.uploadSession!(
            command.runId,
            {
              generation: command.generation,
              offset,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              data: bytes.toString("base64"),
            },
            sent,
          ),
        ),
      );
      guard();
      journal.sessionUploaded(execution.id, offset, offset + bytes.length);
      offset += bytes.length;
    }
    await remote(() =>
      request((sent) =>
        options.daemon.finishSession!(
          command.runId,
          { ...session, generation: command.generation, agentVersion },
          sent,
        ),
      ),
    );
    guard();
    journal.sessionDone(execution.id, "sealed");
  }
  function hasSessionSnapshot(executionId: string) {
    try {
      readRunnerResultFile(options.results, executionId, "session.json");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  }
  /** A snapshot that cannot be saved never holds back or fails the run. */
  function skipSession(execution: Execution, error: unknown) {
    journal.sessionDone(execution.id, "skipped");
    report(
      new Error(
        `Runner skipped the agent session snapshot of execution ${execution.id}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  function quiesce(entry: Active) {
    entry.quiesced ??= (async () => {
      await entry.dispatching;
      await broker.stop(entry.execution.id);
      journal.confirmTermination(entry.execution.command);
    })().catch((error) => {
      entry.quiesced = undefined;
      throw error;
    });
    return entry.quiesced;
  }
  function expired(entry: Active) {
    return (
      entry.workMs >= entry.workLimitMs || monotonic() >= entry.deadline + RUNNER_LEASE_GRACE_MS
    );
  }
  function check(entry: Active) {
    holdOffline(entry);
    if (closed || expired(entry)) {
      void interrupt(entry, closed ? "runner stopping" : LEASE_PASSED, !closed).catch(
        journalRejection("runner-runtime.check.interrupt", report, entry.execution.command.itemId),
      );
      throw new Error("Runner lease expired");
    }
    entry.abort.signal.throwIfAborted();
  }
  const repositories = createRunnerRepositories({
    root: options.repositoryRoot,
    home: options.home,
    networkGit: (input) =>
      remote(() => (options.networkGit ?? runGitHubGit)(input), GITHUB_UNAVAILABLE),
    async credential(command, access) {
      const entry = active.get(key(command));
      if (!entry || entry.execution.command.id !== command.id)
        throw new Error("Runner command is not active");
      check(entry);
      const token = await grant(entry);
      const credential = await remote(() =>
        options.daemon.repositoryCredential(command.runId, command.generation, access, token),
      );
      check(entry);
      if (access === "write" && credential.branch !== entry.publicationBranch)
        throw new Error("Runner publication branch changed");
      return credential.token;
    },
  });
  function pulse(): Promise<void> {
    if (pulsing) return pulsing;
    if (closed) return Promise.resolve();
    pulsing = (async () => {
      const started = monotonic();
      try {
        for (const entry of active.values()) collectRuntimes(entry);
        let agents: ReturnType<RunnerAgents["installed"]>;
        try {
          agents = options.agents?.installed();
        } catch (error) {
          journalCaught(error, "runner-runtime.pulse.installed", null);
          report(error);
        }
        // Paws renews only the work named here, so a restart that lost a command fences it.
        const response = await options.daemon.heartbeat(
          options.skills?.installed(),
          runtimes.installed(),
          agents,
          [
            ...new Map(
              [
                ...[...active.values()]
                  .filter((entry) => !entry.teardownConfirmed)
                  .map(({ execution }) => execution.command),
                ...journal.pendingResults(),
              ].map((command) => [
                key(command),
                { runId: command.runId, generation: command.generation },
              ]),
            ).values(),
          ],
          journal.pendingTerminations(),
        );
        if (closed) return;
        for (const entry of response.terminated ?? []) journal.terminationReported(entry);
        if (response.agents && options.agents)
          try {
            options.agents.apply(response.agents);
          } catch (error) {
            journalCaught(error, "runner-runtime.pulse.apply", null);
            report(error);
          }
        // Downloads can take longer than a heartbeat, so they run beside the lease renewal.
        if (response.skills && options.skills)
          void options.skills
            .sync(response.skills)
            .catch(journalRejection("runner-runtime.pulse.sync", report, null));
        const observed = monotonic();
        if (unreachable) for (const retry of resultRetries.values()) retry.at = 0;
        unreachable = false;
        advertisedBudget = response.offlineBudgetMs;
        advertisedAliveAt = response.aliveAt;
        agreedPulseAt = started;
        agreedWallAt = now();
        leases.clear();
        serverExpiry.clear();
        for (const lease of response.leases) {
          serverExpiry.set(`${lease.runId}:${lease.generation}`, lease.expiresAt);
          leases.set(
            `${lease.runId}:${lease.generation}`,
            Math.min(
              started + 60_000,
              observed + Math.max(0, Math.min(60_000, lease.expiresAt - now())),
            ),
          );
        }
        for (const entry of active.values()) {
          const deadline = leases.get(key(entry.execution.command));
          const fenced = response.fenced.some(
            (value) =>
              value.runId === entry.execution.command.runId &&
              value.generation === entry.execution.command.generation,
          );
          if (!deadline || fenced)
            void interrupt(
              entry,
              fenced ? "fenced by Paws" : "heartbeat did not renew the lease",
            ).catch(
              journalRejection(
                "runner-runtime.pulse.interrupt",
                report,
                entry.execution.command.itemId,
              ),
            );
          else if (!entry.abort.signal.aborted) {
            accountWork(entry);
            entry.idleMs = 0;
            entry.agreedAt = started;
            entry.agreedWallAt = now();
            entry.serverAliveAt = response.aliveAt;
            entry.serverLeaseUntil = serverExpiry.get(key(entry.execution.command));
            entry.offlineBudgetMs = response.offlineBudgetMs;
            entry.deadline = deadline;
          }
        }
      } catch (error) {
        unreachable = true;
        for (const entry of active.values()) holdOffline(entry);
        throw error;
      }
      const identity = options.daemon.status();
      if (identity.phase === "paired" && identity.expiresAt - now() < 60 * 60_000)
        await options.daemon.renewCertificate();
    })().finally(() => {
      pulsing = undefined;
    });
    return pulsing;
  }
  /**
   * Downloads the session snapshot a moved run restores, checked against the signed size and
   * sha256. Any failure leaves no file, and the worker starts a new session and says why.
   */
  async function downloadSession(entry: Active): Promise<string | undefined> {
    const command = entry.execution.command;
    if (command.type !== "run" || !command.restoreSession) return undefined;
    const restore = command.restoreSession;
    const path = join(options.repositoryRoot, `session-${entry.execution.id}-${randomUUID()}.gz`);
    let kept = false;
    try {
      if (!options.daemon.readSession) throw new Error("Runner session transport is unavailable");
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let received: Awaited<ReturnType<NonNullable<typeof options.daemon.readSession>>>;
      try {
        const token = await grant(entry);
        received = await options.daemon.readSession(
          command.runId,
          { generation: command.generation, snapshotGeneration: restore.generation },
          token,
          fd,
          restore.sizeBytes,
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      check(entry);
      if (
        received.sizeBytes !== restore.sizeBytes ||
        received.sha256 !== restore.sha256 ||
        received.sentSha256 !== restore.sha256
      )
        throw new Error("The agent session snapshot does not match its checksum");
      kept = true;
      return path;
    } catch (error) {
      if (entry.abort.signal.aborted) throw error;
      journalCaught(error, "runner-runtime.downloadSession", command.itemId);
      return undefined;
    } finally {
      if (!kept) rmSync(path, { force: true });
    }
  }
  async function launch(entry: Active) {
    let bundle: string | undefined;
    let sessionBundle: string | undefined;
    let snapshotWorkspace: string | undefined;
    try {
      await grant(entry);
      check(entry);
      if (entry.execution.command.expiresAt <= now())
        throw new Error("Runner command expired before dispatch");
      const command = entry.execution.command;
      let repositorySnapshot: string | undefined;
      if (command.type === "task") {
        if (command.repository) {
          const repository = command.repository;
          const env = {
            PATH: "/usr/bin:/bin",
            HOME: options.home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          };
          const token = await grant(entry);
          const credential = await remote(() =>
            options.daemon.repositoryCredential(command.runId, command.generation, "read", token),
          );
          check(entry);
          snapshotWorkspace = join(options.repositoryRoot, `task-${entry.execution.id}`);
          const prepared = await prepareRepositorySnapshot({
            ...repository,
            workspace: snapshotWorkspace,
            commit: repository.baseSha,
            maxArchiveBytes: 536_870_912,
            signal: entry.abort.signal,
            env,
            async networkGit(args) {
              await remote(
                () =>
                  (options.networkGit ?? runGitHubGit)({
                    operation: "clone",
                    remoteUrl: repository.remoteUrl,
                    token: credential.token,
                    cwd: options.repositoryRoot,
                    dest: args.at(-1)!,
                    env,
                    signal: entry.abort.signal,
                  }),
                GITHUB_UNAVAILABLE,
              );
              return "";
            },
          });
          repositorySnapshot = prepared.path;
        }
      } else {
        const prepared = await repositories.prepare(command, entry.abort.signal);
        bundle = prepared.bundle;
      }
      check(entry);
      if (entry.execution.command.expiresAt <= now())
        throw new Error("Runner command expired before dispatch");
      const needsInputs = Boolean(command.inputFiles?.length || command.promptContext);
      if (needsInputs && !options.daemon.readInputs)
        throw new Error("Runner input transport is unavailable");
      const inputs = needsInputs
        ? await remote(() =>
            options.daemon.readInputs!(command, () => grant(entry), entry.abort.signal),
          )
        : undefined;
      check(entry);
      sessionBundle = await downloadSession(entry);
      check(entry);
      if (command.expiresAt <= now()) throw new Error("Runner command expired before dispatch");
      publishRunnerJob(
        options.spool,
        { executionId: entry.execution.id, command: entry.execution.command },
        { repositoryBundle: bundle, repositorySnapshot, sessionBundle, ...inputs },
      );
      check(entry);
      if (entry.execution.command.expiresAt <= now())
        throw new Error("Runner command expired before dispatch");
      const starting = broker.start(entry.execution.id);
      entry.dispatching = starting.then(
        () => undefined,
        () => undefined,
      );
      const receipt = await starting;
      if (receipt.alreadyAdmitted)
        throw new Error("Runner execution identity was already consumed");
      check(entry);
      if (entry.execution.command.expiresAt <= now())
        throw new Error("Runner command expired before dispatch");
      journal.phase(entry.execution.id, "running");
      entry.execution.phase = "running";
    } catch (error) {
      journalCaught(error, "runner-runtime.launch.grant", entry.execution.command.itemId);
      if (!(error instanceof RemoteFailure))
        void interrupt(
          entry,
          error instanceof Error ? error.message : "preparation failed",
          true,
        ).catch(
          journalRejection(
            "runner-runtime.launch.interrupt",
            report,
            entry.execution.command.itemId,
          ),
        );
      report(error);
    } finally {
      if (bundle) rmSync(bundle, { force: true });
      if (sessionBundle) rmSync(sessionBundle, { force: true });
      if (snapshotWorkspace) {
        rmSync(snapshotWorkspace, { recursive: true, force: true });
        rmSync(`${snapshotWorkspace}.repository.json`, { force: true });
      }
    }
  }
  function prepare(entry: Active) {
    entry.task = launch(entry)
      .catch(
        journalRejection("runner-runtime.prepare.launch", report, entry.execution.command.itemId),
      )
      .finally(() => {
        entry.task = undefined;
      });
  }
  async function drainTranscript(entry: Active, final: boolean) {
    check(entry);
    let raw: Buffer;
    try {
      raw = readRunnerResultFile(options.results, entry.execution.id, "events.jsonl");
    } catch (error) {
      if (!final && (error as NodeJS.ErrnoException).code === "ENOENT") {
        journalCaught(
          error,
          "runner-runtime.drainTranscript.readRunnerResultFile",
          null,
          "optional file may be absent",
        );
        return;
      }
      throw error;
    }
    journal.ingest(entry.execution.id, raw);
    let { offset, consumed } = journal.transcriptCursor(entry.execution.id);
    if (offset > consumed || (final && consumed !== raw.length))
      throw new Error("Runner transcript is incomplete");
    const end = final
      ? raw.length
      : Math.floor(consumed / RUNNER_TRANSCRIPT_CHUNK_BYTES) * RUNNER_TRANSCRIPT_CHUNK_BYTES;
    while (offset < end) {
      const previous = offset;
      const bytes = raw.subarray(offset, Math.min(offset + RUNNER_TRANSCRIPT_CHUNK_BYTES, end));
      const token = await grant(entry);
      await remote(() =>
        options.daemon.uploadTranscript(
          entry.execution.command.runId,
          {
            generation: entry.execution.command.generation,
            executionId: entry.execution.id,
            offset,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            data: bytes.toString("base64"),
          },
          token,
        ),
      );
      check(entry);
      offset += bytes.length;
      journal.transcriptUploaded(entry.execution.id, previous, offset);
    }
    if (final && !journal.transcriptSealed(entry.execution.id)) {
      const token = await grant(entry);
      await remote(() =>
        options.daemon.finishTranscript(
          entry.execution.command.runId,
          {
            generation: entry.execution.command.generation,
            executionId: entry.execution.id,
            offset: raw.length,
            sizeBytes: raw.length,
            sha256: createHash("sha256").update(raw).digest("hex"),
          },
          token,
        ),
      );
      journal.sealTranscript(entry.execution.id);
      check(entry);
    }
  }
  async function deliver(entry: Active) {
    await drainTranscript(entry, entry.execution.phase === "publishing");
    for (let delivery of journal.pending(entry.execution.id)) {
      const token = await grant(entry);
      if (delivery.event.type === "artifact" && delivery.event.dropped === undefined) {
        const artifact = delivery.event.artifact;
        const bytes = readRunnerResultFile(
          options.results,
          entry.execution.id,
          `artifact-${artifact.id}.bytes`,
        );
        if (
          bytes.length !== artifact.sizeBytes ||
          createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
        )
          throw new Error("Runner artifact output changed");
        const count = Math.max(1, Math.ceil(bytes.length / RUNNER_ARTIFACT_CHUNK_BYTES));
        try {
          for (let index = 0; index < count; index++) {
            check(entry);
            const chunk = {
              generation: entry.execution.command.generation,
              artifact,
              index,
              data: bytes
                .subarray(
                  index * RUNNER_ARTIFACT_CHUNK_BYTES,
                  (index + 1) * RUNNER_ARTIFACT_CHUNK_BYTES,
                )
                .toString("base64"),
            };
            await remote(() =>
              options.daemon.uploadArtifact(entry.execution.command.runId, chunk, token),
            );
          }
        } catch (error) {
          // 422 is Paws refusing this artifact, such as one past the count limit. The event goes
          // out marked dropped so the agent gets a tool error; auth and fencing stay fatal.
          if (!(error instanceof RunnerRequestError) || error.status !== 422) throw error;
          journalCaught(
            error,
            "runner-runtime.deliver.uploadArtifact",
            entry.execution.command.itemId,
            `dropped artifact ${artifact.path}`,
          );
          delivery = {
            ...delivery,
            event: journal.dropArtifact(
              entry.execution.id,
              delivery.sequence,
              error.reason ?? "Paws refused the artifact",
            ),
          };
        }
      }
      if (
        delivery.event.type === "checkpoint" &&
        delivery.event.sha &&
        delivery.event.dropped === undefined
      ) {
        try {
          await publishCheckpoint(entry, delivery.event.sha);
        } catch (error) {
          // A control-plane outage retries the delivery; a refused push only goes unrecorded.
          if (
            entry.abort.signal.aborted ||
            (error instanceof RemoteFailure && !(error instanceof GitHubFailure))
          )
            throw error;
          journalCaught(
            error,
            "runner-runtime.deliver.publishCheckpoint",
            entry.execution.command.itemId,
          );
          delivery = {
            ...delivery,
            event: journal.dropCheckpoint(
              entry.execution.id,
              delivery.sequence,
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
      }
      await remote(() =>
        options.daemon.sendEvent(
          {
            runId: entry.execution.command.runId,
            generation: entry.execution.command.generation,
            ...delivery,
          },
          token,
        ),
      );
      check(entry);
      journal.sent(entry.execution.id, delivery.sequence);
    }
    const token = await grant(entry);
    const answers = await remote(() =>
      options.daemon.answers(
        entry.execution.command.runId,
        entry.execution.command.generation,
        journal.answerCursor(entry.execution.id),
        token,
      ),
    );
    for (const answer of answers.answers) {
      check(entry);
      const requestId = journal.requestId(entry.execution.id, answer.sequence);
      if (!requestId) throw new Error("Runner answer does not match a question");
      publishRunnerAnswer(options.spool, entry.execution.id, { requestId, answer: answer.answer });
      journal.answered(entry.execution.id, answer.sequence);
    }
    if (entry.execution.command.type !== "run" || !options.daemon.followUps) return;
    const followUps = await remote(() =>
      options.daemon.followUps!(
        entry.execution.command.runId,
        entry.execution.command.generation,
        entry.followUps ?? 0,
        token,
      ),
    );
    for (const followUp of followUps.followUps) {
      check(entry);
      publishRunnerAnswer(options.spool, entry.execution.id, {
        requestId: runnerFollowUpRequestId(followUp.sequence),
        answer: followUp.body,
      });
      entry.followUps = followUp.sequence;
    }
  }
  /** Pushes a WIP commit the worker bundled to the item's branch, replacing the one before. */
  async function publishCheckpoint(entry: Active, sha: string) {
    const command = entry.execution.command;
    if (command.type !== "run") throw new Error("Only a run can publish a checkpoint");
    const token = await grant(entry);
    const credential = await remote(() =>
      options.daemon.repositoryCredential(command.runId, command.generation, "write", token),
    );
    check(entry);
    if (!credential.branch) throw new Error("Runner publication branch is missing");
    entry.publicationBranch = credential.branch;
    await repositories.publish(
      command,
      {
        bundle: readRunnerResultFile(
          options.results,
          entry.execution.id,
          `checkpoint-${sha}.bundle`,
        ),
        sha,
        branch: credential.branch,
      },
      entry.abort.signal,
      entry.checkpointSha,
    );
    check(entry);
    entry.checkpointSha = sha;
    // The worker skips an unchanged worktree only once its checkpoint reached the branch.
    entry.checkpointsPublished = (entry.checkpointsPublished ?? 0) + 1;
    publishRunnerAnswer(options.spool, entry.execution.id, {
      requestId: runnerCheckpointPublishedId(entry.checkpointsPublished),
      answer: sha,
    });
  }
  async function resumeIfCrashed(entry: Active): Promise<boolean> {
    const id = entry.execution.id;
    if (
      entry.execution.phase !== "running" ||
      entry.abort.signal.aborted ||
      !broker.alive ||
      !broker.resume ||
      broker.alive(id) ||
      (entry.restarts ?? 0) >= 2
    )
      return false;
    try {
      readRunnerResultFile(options.results, id, "result.json");
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalCaught(
        error,
        "runner-runtime.resumeIfCrashed.readRunnerResultFile",
        entry.execution.command.itemId,
        "optional file may be absent",
      );
    }
    check(entry);
    entry.restarts = (entry.restarts ?? 0) + 1;
    await broker.resume(id);
    return true;
  }
  async function workerFinished(entry: Active): Promise<boolean> {
    let raw: Buffer;
    try {
      raw = readRunnerResultFile(options.results, entry.execution.id, "result.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalCaught(
        error,
        "runner-runtime.complete.readRunnerResultFile",
        entry.execution.command.itemId,
        "optional file may be absent",
      );
      if (broker.alive?.(entry.execution.id) !== false) return false;
      try {
        raw = readRunnerResultFile(options.results, entry.execution.id, "result.json");
      } catch {
        throw new Error("worker exited without a result");
      }
    }
    try {
      JSON.parse(raw.toString("utf8"));
    } catch (caughtError3) {
      journalCaught(caughtError3, "runner-runtime.complete.parse", entry.execution.command.itemId);
      return false;
    }
    return true;
  }
  function workerOutcome(execution: Execution): RunnerResult {
    const worker = readWorkerResult(execution);
    return RunnerResultSchema.parse({
      ...worker.run,
      executionId: worker.executionId,
      commandId: worker.commandId,
      ...(worker.candidateSha ? { candidateSha: worker.candidateSha } : {}),
      ...(worker.reviewText !== undefined ? { reviewText: worker.reviewText } : {}),
    });
  }
  async function complete(entry: Active) {
    if (!journal.publication(entry.execution.id) && !(await workerFinished(entry))) return;
    await quiesce(entry);
    collectRuntimes(entry);
    check(entry);
    await deliver(entry);
    const publication =
      journal.publication(entry.execution.id) ??
      journal.beginPublication(
        entry.execution.id,
        workerOutcome(entry.execution),
        entry.checkpointSha,
      );
    entry.execution.phase = "publishing";
    const result: RunnerResult = { ...publication.result };
    try {
      await uploadSession(
        entry.execution,
        () => grant(entry),
        () => check(entry),
      );
    } catch (error) {
      if (entry.abort.signal.aborted) throw error;
      // An outage retries on the next tick from the stored offset, a few times at most.
      entry.sessionTries = (entry.sessionTries ?? 0) + 1;
      if (error instanceof RemoteFailure && entry.sessionTries < SESSION_UPLOAD_TRIES) throw error;
      skipSession(entry.execution, error);
    }
    // A handover whose session could not be published is no handover: the run stays here, and
    // its next turn loads the session on this runner. Checked on every pass, as delivery repeats.
    if (
      result.handedOver &&
      journal.sessionCursor(entry.execution.id).state !== "sealed" &&
      hasSessionSnapshot(entry.execution.id)
    ) {
      delete result.handedOver;
      result.handoverFailure = "publication";
    }
    if (publication.publishedSha) result.candidateSha = publication.publishedSha;
    else if (
      result.candidateSha &&
      entry.execution.command.type !== "task" &&
      result.candidateSha !== entry.execution.command.repository.baseSha
    ) {
      if (entry.execution.command.type !== "run" || result.cancelled || !result.agentExited)
        throw new Error("Unsafe runner candidate result");
      if ((entry.pushAt ?? 0) > monotonic()) return;
      const token = await grant(entry);
      const credential = await remote(() =>
        options.daemon.repositoryCredential(
          entry.execution.command.runId,
          entry.execution.command.generation,
          "write",
          token,
        ),
      );
      check(entry);
      if (!credential.branch) throw new Error("Runner publication branch is missing");
      entry.publicationBranch = credential.branch;
      try {
        // A push refused because the branch moved is rebased onto it here, not sent back (PAS-886).
        result.candidateSha = await repositories.publish(
          entry.execution.command,
          {
            bundle: readRunnerResultFile(options.results, entry.execution.id, "candidate.bundle"),
            sha: result.candidateSha,
            branch: credential.branch,
            rebase: true,
          },
          entry.abort.signal,
          publication.lease,
        );
        journal.published(entry.execution.id, result.candidateSha);
      } catch (error) {
        if (error instanceof CandidateRebaseConflict) {
          journalCaught(error, "runner-runtime.complete.rebase", entry.execution.command.itemId);
          const reason = `${credential.branch} moved on GitHub, and rebasing the candidate onto it conflicted${error.files.length ? ` in ${error.files.join(", ")}` : ""}`;
          await interrupt(entry, reason, true, {
            branch: credential.branch,
            error: reason.slice(0, 4096),
            conflicts: error.files.slice(0, 100).map((file) => file.slice(0, 4096)),
          });
          return;
        }
        if (!(error instanceof GitHubFailure)) throw error;
        journalCaught(error, "runner-runtime.complete.publish", entry.execution.command.itemId);
        // A push outage keeps the finished turn's candidate here and retries the push until
        // GitHub takes it, so Paws never sees a candidate GitHub doesn't have (PAS-867).
        if (isPushOutage(error.message)) {
          const waited = entry.outageTries ?? 0;
          entry.outageTries = waited + 1;
          entry.pushAt = monotonic() + pushOutageProbeDelayMs(waited);
          throw error;
        }
        const tries = (entry.pushTries ?? 0) + 1;
        entry.pushTries = tries;
        // Staging fails on the runner before any push, so a retry fails the same way.
        const staging = error.message.indexOf(PUBLICATION_STAGING_FAILURE);
        const permanent = staging >= 0 || PERMANENT_PUSH_REJECTION.test(error.message);
        if (!permanent && tries <= CANDIDATE_PUSH_RETRY_MS.length) {
          entry.pushAt = monotonic() + CANDIDATE_PUSH_RETRY_MS[tries - 1]!;
          throw error;
        }
        const failure = {
          branch: credential.branch,
          error: (staging >= 0 ? error.message.slice(staging) : error.message).slice(0, 4096),
        };
        await interrupt(
          entry,
          staging >= 0
            ? `the candidate for ${failure.branch} could not be staged for the push: ${failure.error}`
            : permanent
              ? `GitHub rejected the candidate push to ${failure.branch}: ${failure.error}`
              : `the candidate push to ${failure.branch} failed ${tries} times: ${failure.error}`,
          true,
          failure,
        );
        return;
      }
      check(entry);
    }
    await drainTranscript(entry, true);
    journal.saveResult(entry.execution.id, result);
    active.delete(key(entry.execution.command));
    await deliverResult(entry.execution);
  }
  async function step() {
    await pulse().catch(journalRejection("runner-runtime.step.pulse", report, null));
    if (closed) return;
    for (const pending of journal.pendingResults()) {
      const execution = journal.execution(pending.id);
      if (execution) void deliverResult(execution);
    }
    const polled = await options.daemon.pollCommands().catch((error) => {
      report(error);
      return { commands: [], rejected: [], deniedRepositories: [] };
    });
    for (const repository of polled.deniedRepositories) {
      if (deniedReported.has(repository)) continue;
      deniedReported.add(repository);
      report(
        new Error(
          `Runner refused a run for ${repository}. Add it to allowedRepositories in the runner config.`,
        ),
      );
    }
    if (closed) return;
    const commands = options.daemon.pendingCommands();
    for (const command of commands) {
      if (command.type !== "cancel" && command.type !== "handover" && command.type !== "checkpoint")
        continue;
      const entry = active.get(`${command.runId}:${command.generation}`);
      if (command.type === "cancel" && entry)
        void interrupt(entry, "cancelled by Paws").catch(
          journalRejection(
            "runner-runtime.cancel.interrupt",
            report,
            entry.execution.command.itemId,
          ),
        );
      if (
        command.type === "cancel" &&
        !entry &&
        !journal.terminationPending(command.runId, command.generation)
      ) {
        // No admitted execution or in-flight preparation can start this generation.
        // Persist proof before acknowledging receipt, including across a lost heartbeat.
        journal.confirmTermination(command);
      }
      if (command.type === "handover") {
        if (entry?.execution.command.type === "run" && !entry.abort.signal.aborted) {
          entry.handover ??= { sent: 0 };
          entry.handover.pending = command.expiresAt;
        } else
          report(new Error(`Runner has no running session of run ${command.runId} to hand over`));
      }
      // A run that already ended has its work in its candidate; nothing is left to checkpoint.
      if (
        command.type === "checkpoint" &&
        entry?.execution.command.type === "run" &&
        !entry.abort.signal.aborted
      ) {
        entry.checkpoints ??= { asked: 0, sent: 0 };
        entry.checkpoints.asked++;
      }
      await options.daemon.acknowledgeCommand(command.id);
    }
    await settle(
      [...active.values()]
        .filter((entry) => entry.abort.signal.aborted)
        .flatMap((entry) => [entry.stopped, entry.task]),
    );
    for (const entry of active.values()) {
      if (entry.abort.signal.aborted) {
        if (entry.teardownConfirmed && !entry.task) active.delete(key(entry.execution.command));
        else if (!entry.stopped)
          void interrupt(entry, "cleanup pending").catch(
            journalRejection(
              "runner-runtime.cleanup.interrupt",
              report,
              entry.execution.command.itemId,
            ),
          );
      } else if (entry.execution.phase === "preparing") {
        if (!entry.task) prepare(entry);
      }
    }
    if (!unreachable && active.size < concurrency()) {
      for (const command of commands) {
        if (command.type !== "run" && command.type !== "review" && command.type !== "task")
          continue;
        if (active.has(key(command))) continue;
        if (command.expiresAt <= now()) {
          await options.daemon.acknowledgeCommand(command.id);
          continue;
        }
        const deadline = leases.get(key(command));
        if (!deadline || deadline <= monotonic()) continue;
        if (closed) return;
        const execution = journal.admit(command, now());
        if (!execution) {
          await options.daemon.acknowledgeCommand(command.id);
          continue;
        }
        const entry: Active = {
          execution,
          abort: new AbortController(),
          deadline,
          accountedAt: monotonic(),
          idleMs: 0,
          workMs: 0,
          workLimitMs: Math.max(0, command.expiresAt - now()),
          ...(advertisedBudget === undefined ||
          advertisedAliveAt === undefined ||
          agreedPulseAt === undefined ||
          agreedWallAt === undefined ||
          serverExpiry.get(key(command)) === undefined
            ? {}
            : {
                agreedAt: agreedPulseAt,
                agreedWallAt,
                serverAliveAt: advertisedAliveAt,
                serverLeaseUntil: serverExpiry.get(key(command)),
                offlineBudgetMs: advertisedBudget,
              }),
        };
        active.set(key(command), entry);
        prepare(entry);
        await options.daemon
          .acknowledgeCommand(command.id)
          .catch(
            journalRejection("runner-runtime.step.acknowledgeCommand", report, command.itemId),
          );
        if (active.size >= concurrency()) break;
      }
    }
    for (const entry of active.values()) {
      if (entry.execution.phase !== "running" && entry.execution.phase !== "publishing") continue;
      if (entry.handover?.pending !== undefined && entry.execution.phase === "running") {
        publishRunnerAnswer(options.spool, entry.execution.id, {
          requestId: runnerHandoverRequestId(entry.handover.sent + 1),
          answer: String(entry.handover.pending),
        });
        entry.handover = { sent: entry.handover.sent + 1 };
      }
      while (
        entry.checkpoints &&
        entry.checkpoints.sent < entry.checkpoints.asked &&
        entry.execution.phase === "running"
      ) {
        publishRunnerAnswer(options.spool, entry.execution.id, {
          requestId: runnerCheckpointRequestId(entry.checkpoints.sent + 1),
          answer: "stop",
        });
        entry.checkpoints.sent++;
      }
      entry.delivering ??= advance(entry).finally(() => {
        entry.delivering = undefined;
      });
    }
    await settle(
      [...active.values()].map((entry) => entry.delivering),
      options.deliveryWaitMs ?? 1_000,
    );
  }
  async function advance(entry: Active) {
    try {
      if (journal.hasResult(entry.execution.id)) {
        active.delete(key(entry.execution.command));
        await deliverResult(entry.execution);
        return;
      }
      await deliver(entry);
      if (!(await resumeIfCrashed(entry))) await complete(entry);
    } catch (error) {
      journalCaught(error, "runner-runtime.advance.deliver", entry.execution.command.itemId);
      if (error instanceof RemoteFailure) return report(error);
      const refused = journal.publication(entry.execution.id) !== undefined && fencedRefusal(error);
      await interrupt(
        entry,
        error instanceof Error ? error.message : "runner error",
        !refused,
      ).catch(
        journalRejection(
          "runner-runtime.advance.interrupt",
          report,
          entry.execution.command.itemId,
        ),
      );
    }
  }
  for (const execution of recovering) {
    const entry: Active = {
      execution,
      abort: new AbortController(),
      deadline: 0,
      accountedAt: monotonic(),
      idleMs: 0,
      workMs: 0,
      workLimitMs: 0,
    };
    active.set(key(execution.command), entry);
    void interrupt(entry, "the runner restarted while it was running", true).catch(
      journalRejection("runner-runtime.recover.interrupt", report, execution.command.itemId),
    );
  }
  const sweep = async () => {
    const leftover = (await broker.sweep?.()) ?? 0;
    if (leftover)
      report(new Error(`Runner stopped ${leftover} processes left by earlier executions`));
  };
  if (recovering.length)
    void Promise.allSettled([...active.values()].map((entry) => entry.stopped))
      .then(sweep)
      .catch(journalRejection("runner-runtime.recover.sweep", report, null));
  else await sweep();
  const reconciling = (async () => {
    for (const execution of historical) {
      for (let confirmed = false; !confirmed;) {
        if (closed) return;
        try {
          await broker.stop(execution.id);
          journal.confirmTermination(execution.command);
          confirmed = true;
        } catch (error) {
          journalCaught(error, "runner-runtime.reconcile.stop", execution.command.itemId);
          await new Promise<void>((resolve) => setTimeout(resolve, 15_000).unref?.());
        }
      }
    }
  })();
  const heartbeat = setInterval(() => {
    void pulse().catch(journalRejection("runner-runtime.openRunnerRuntime.pulse", report, null));
  }, 15_000);
  const watchdog = setInterval(() => {
    for (const entry of active.values()) {
      holdOffline(entry);
      if (expired(entry))
        void interrupt(entry, LEASE_PASSED, true).catch(
          journalRejection(
            "runner-runtime.openRunnerRuntime.interrupt",
            report,
            entry.execution.command.itemId,
          ),
        );
      else if (entry.execution.phase === "preparing" && entry.execution.command.expiresAt <= now())
        void interrupt(entry, "command expired before the worker started", true).catch(
          journalRejection(
            "runner-runtime.openRunnerRuntime.interrupt",
            report,
            entry.execution.command.itemId,
          ),
        );
    }
  }, 250);
  return {
    status: () => {
      const entry = active.values().next().value;
      return {
        active: entry
          ? {
              executionId: entry.execution.id,
              commandId: entry.execution.command.id,
              phase: entry.execution.phase,
            }
          : null,
      };
    },
    tick() {
      if (closed) return Promise.reject(new Error("Runner runtime is closed"));
      ticking ??= step().finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
    stop() {
      stopping ??= (async () => {
        closed = true;
        clearInterval(heartbeat);
        clearInterval(watchdog);
        const cleanup = Promise.allSettled(
          [...active.values()].map((entry) => interrupt(entry, "runner stopping")),
        );
        const draining = Promise.allSettled([
          cleanup,
          reconciling,
          ticking,
          pulsing,
          ...resultDeliveries.values(),
          ...[...active.values()].flatMap((entry) => [entry.task, entry.delivering]),
        ]);
        // Return after a bounded shutdown without erasing unresolved cleanup. Keep
        // the journal open until callbacks settle; a new process restores the same rows.
        void draining.then(() => journal.close());
        await settle([draining]);
      })();
      return stopping;
    },
  };
}
