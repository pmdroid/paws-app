import { rmSync } from "node:fs";
import { join } from "node:path";
import { prepareRepositorySnapshot } from "../acp";
import { runGitHubGit } from "../github";
import { z } from "zod";
import { createHash } from "node:crypto";
import { RUNNER_ARTIFACT_CHUNK_BYTES } from "../runner-artifacts";
import { RUNNER_TRANSCRIPT_CHUNK_BYTES } from "../runner-transcripts";
import { RunnerRequestError, type RunnerDaemon, type RunnerGrant } from "../runner-daemon";
import {
  createDirectWorkerSupervisor,
  publishRunnerJob,
  readRunnerResultFile,
  type RunnerBrokerClient,
  type RunnerSkillInstaller,
  type RunnerSpool,
  type RunnerResults,
} from "../runner-execution";
import {
  publishRunnerAnswer,
  publishRunnerHandover,
  readRunnerHandover,
  runnerFollowUpRequestId,
} from "../runner-answers";
import { createRunnerRepositories } from "../runner-repositories";
import { RUNNER_LEASE_GRACE_MS, RunnerResultSchema, type RunnerResult } from "../runner-protocol";
import { openExecutionJournal, type Execution } from "../runner-journal";

class RemoteFailure extends Error {}
class GitHubFailure extends RemoteFailure {}
const GITHUB_UNAVAILABLE = "GitHub git operation failed";

const CANDIDATE_PUSH_RETRY_MS = [0, 60_000, 120_000, 240_000, 480_000];
/** A handover is published only if this much of its time is left for the transcript and result. */
const HANDOVER_SEAL_RESERVE_MS = 10_000;
const HANDOVER_RESULT = "handover.json";
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
  handoverExpiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
type PushFailure = NonNullable<RunnerResult["pushFailure"]>;
type Active = {
  execution: Execution;
  abort: AbortController;
  deadline: number;
  grant?: RunnerGrant;
  task?: Promise<void>;
  delivering?: Promise<void>;
  stopped?: Promise<void>;
  quiesced?: Promise<void>;
  publicationBranch?: string;
  followUps?: number;
  transcriptSealed?: boolean;
  /**
   * The runtime asked Paws to seal a handed-over transcript. From here on the handover only
   * finishes: Paws decides by sealing or refusing, and the worker never restarts on a sealed one.
   */
  handoverCommitted?: boolean;
  restarts?: number;
  pushTries?: number;
  pushAt?: number;
};

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
    Partial<Pick<RunnerDaemon, "readInputs" | "followUps">>;
  spool: RunnerSpool;
  results: RunnerResults;
  repositoryRoot: string;
  home: string;
  broker?: RunnerBrokerClient;
  /** Installs registered skills from the heartbeat manifest and reports what is installed. */
  skills?: RunnerSkillInstaller;
  networkGit?: Parameters<typeof createRunnerRepositories>[0]["networkGit"];
  now?: () => number;
  monotonic?: () => number;
  onError?: (error: Error) => void;
  /** Read before admitting work, so a lowered value holds back new work without stopping any. */
  concurrency?: number | (() => number);
  stopWaitMs?: number;
  deliveryWaitMs?: number;
}) {
  if (options.daemon.status().phase !== "paired")
    throw new Error("Runner must be paired before execution");
  const journal = openExecutionJournal(options.root);
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
  const deniedReported = new Set<string>();
  const settle = (
    work: readonly (Promise<unknown> | undefined)[],
    waitMs = options.stopWaitMs ?? 5_000,
  ) =>
    Promise.race([
      Promise.allSettled(work),
      new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref?.()),
    ]);
  // Committed handovers left by a restart: their seal and result are finished, not failed.
  const recovering: Execution[] = [];
  try {
    for (const previous of journal.executions(true)) {
      await broker.stop(previous.id);
      if (previous.phase === "handover") {
        recovering.push(previous);
        continue;
      }
      report(
        new Error(
          `Runner interrupted execution ${previous.id} for run ${previous.command.runId}: runner restarted`,
        ),
      );
      await fail(previous, "the runner restarted while it was running");
      journal.phase(previous.id, "interrupted");
    }
    const leftover = (await broker.sweep?.()) ?? 0;
    if (leftover)
      report(new Error(`Runner stopped ${leftover} processes left by earlier executions`));
  } catch (error) {
    journal.close();
    throw error;
  }
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
  let closed = false;
  let ticking: Promise<void> | undefined;
  let pulsing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const leases = new Map<string, number>();
  const key = (command: { runId: string; generation: number }) =>
    `${command.runId}:${command.generation}`;
  async function grant(entry: Active) {
    check(entry);
    if (!entry.grant || entry.grant.expiresAt <= now() + 5000) {
      const value = await remote(() =>
        options.daemon.issueRunGrant(entry.execution.command.runId, {
          commandId: entry.execution.command.id,
          generation: entry.execution.command.generation,
        }),
      );
      check(entry);
      entry.grant = value;
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
    entry.stopped ??= (async () => {
      await quiesce(entry);
      if (notify) await fail(entry.execution, reason, entry.transcriptSealed, pushFailure);
      // A committed handover that stops quietly, as on shutdown, is finished after the restart.
      if (!entry.handoverCommitted || notify) journal.phase(entry.execution.id, "interrupted");
      entry.execution.phase = "interrupted";
    })();
    await entry.stopped;
  }
  async function fail(
    execution: Execution,
    reason: string,
    sealed = false,
    pushFailure?: PushFailure,
  ) {
    const { command } = execution;
    if (command.type !== "run" && command.type !== "review" && command.type !== "task") return;
    try {
      const { token } = await options.daemon.issueRunGrant(command.runId, {
        commandId: command.id,
        generation: command.generation,
      });
      if (!sealed) {
        let raw: Buffer = Buffer.alloc(0);
        try {
          raw = transcriptSource(execution.id);
        } catch {}
        journal.ingest(execution.id, raw);
        let { offset, consumed } = journal.transcriptCursor(execution.id);
        while (offset < consumed) {
          const bytes = raw.subarray(
            offset,
            Math.min(offset + RUNNER_TRANSCRIPT_CHUNK_BYTES, consumed),
          );
          await options.daemon.uploadTranscript(
            command.runId,
            {
              generation: command.generation,
              executionId: execution.id,
              offset,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              data: bytes.toString("base64"),
            },
            token,
          );
          journal.transcriptUploaded(execution.id, offset, offset + bytes.length);
          offset += bytes.length;
        }
        await options.daemon.finishTranscript(
          command.runId,
          {
            generation: command.generation,
            executionId: execution.id,
            offset: consumed,
            sizeBytes: consumed,
            sha256: createHash("sha256").update(raw.subarray(0, consumed)).digest("hex"),
          },
          token,
        );
      }
      const tail = (broker.log?.(execution.id) ?? "")
        .replace(/gh[opsu]_[A-Za-z0-9]{10,}/g, "[redacted]")
        .replace(/:\/\/[^\s/@]+@/g, "://[redacted]@");
      await options.daemon.postResult(
        command.runId,
        command.generation,
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
        token,
      );
    } catch (error) {
      report(error);
    }
  }
  /**
   * The run's transcript as the runner uploads and seals it: the worker's event journal, which
   * carries the agent's ACP events next to its questions and progress. Every path that uploads
   * or seals a transcript reads it here, so a repeated seal covers the same bytes.
   */
  function transcriptSource(executionId: string): Buffer {
    return readRunnerResultFile(options.results, executionId, "events.jsonl");
  }
  /**
   * Finishes a committed handover after a runner restart: seals the transcript as a handover,
   * which Paws repeats when it is already sealed, and posts the handed-over result. Returns
   * false when Paws refuses the seal, so the execution is reported as failed instead.
   */
  async function recoverHandover(execution: Execution): Promise<boolean> {
    const { command } = execution;
    if (command.type !== "run") return false;
    const worker = workerResult.parse(
      JSON.parse(
        readRunnerResultFile(options.results, execution.id, HANDOVER_RESULT).toString("utf8"),
      ),
    );
    if (worker.executionId !== execution.id || worker.commandId !== command.id)
      throw new Error("Runner result identity mismatch");
    const result = RunnerResultSchema.parse({
      ...worker.run,
      executionId: worker.executionId,
      commandId: worker.commandId,
      ...(worker.candidateSha ? { candidateSha: worker.candidateSha } : {}),
    });
    if (!result.handedOver) throw new Error("Invalid runner handover result");
    const { token } = await remote(() =>
      options.daemon.issueRunGrant(command.runId, {
        commandId: command.id,
        generation: command.generation,
      }),
    );
    // The same bytes drainTranscript sealed: the worker exited, so they no longer change.
    const raw = transcriptSource(execution.id);
    journal.ingest(execution.id, raw);
    let { offset, consumed } = journal.transcriptCursor(execution.id);
    if (offset > consumed || consumed !== raw.length)
      throw new Error("Runner transcript is incomplete");
    try {
      while (offset < raw.length) {
        const bytes = raw.subarray(
          offset,
          Math.min(offset + RUNNER_TRANSCRIPT_CHUNK_BYTES, raw.length),
        );
        await remote(() =>
          options.daemon.uploadTranscript(
            command.runId,
            {
              generation: command.generation,
              executionId: execution.id,
              offset,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              data: bytes.toString("base64"),
            },
            token,
          ),
        );
        journal.transcriptUploaded(execution.id, offset, offset + bytes.length);
        offset += bytes.length;
      }
      await remote(() =>
        options.daemon.finishTranscript(
          command.runId,
          {
            generation: command.generation,
            executionId: execution.id,
            offset: raw.length,
            sizeBytes: raw.length,
            sha256: createHash("sha256").update(raw).digest("hex"),
            handedOver: true,
          },
          token,
        ),
      );
    } catch (error) {
      if (error instanceof RemoteFailure) throw error;
      report(error);
      return false;
    }
    await remote(() => options.daemon.postResult(command.runId, command.generation, result, token));
    return true;
  }
  async function recoverHandovers() {
    for (const execution of [...recovering]) {
      try {
        if (await recoverHandover(execution)) journal.phase(execution.id, "complete");
        else {
          await fail(execution, "the runner restarted before the handover finished");
          journal.phase(execution.id, "interrupted");
        }
        recovering.splice(recovering.indexOf(execution), 1);
      } catch (error) {
        // Paws is unreachable; the next tick tries again.
        report(error);
      }
    }
  }
  function quiesce(entry: Active) {
    entry.quiesced ??= (async () => {
      await broker.stop(entry.execution.id);
    })();
    return entry.quiesced;
  }
  function check(entry: Active) {
    if (closed || monotonic() >= entry.deadline + RUNNER_LEASE_GRACE_MS) {
      void interrupt(entry, closed ? "runner stopping" : "lease deadline passed", !closed).catch(
        report,
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
      const response = await options.daemon.heartbeat(options.skills?.installed());
      if (closed) return;
      // Downloads can take longer than a heartbeat, so they run beside the lease renewal.
      if (response.skills && options.skills)
        void options.skills.sync(response.skills).catch(report);
      const observed = monotonic();
      leases.clear();
      for (const lease of response.leases)
        leases.set(
          `${lease.runId}:${lease.generation}`,
          Math.min(
            started + 60_000,
            observed + Math.max(0, Math.min(60_000, lease.expiresAt - now())),
          ),
        );
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
          ).catch(report);
        else if (!entry.abort.signal.aborted) entry.deadline = deadline;
      }
      const identity = options.daemon.status();
      if (identity.phase === "paired" && identity.expiresAt - now() < 60 * 60_000)
        await options.daemon.renewCertificate();
    })().finally(() => {
      pulsing = undefined;
    });
    return pulsing;
  }
  async function launch(entry: Active) {
    let bundle: string | undefined;
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
      if (command.expiresAt <= now()) throw new Error("Runner command expired before dispatch");
      publishRunnerJob(
        options.spool,
        { executionId: entry.execution.id, command: entry.execution.command },
        { repositoryBundle: bundle, repositorySnapshot, ...inputs },
      );
      check(entry);
      if (entry.execution.command.expiresAt <= now())
        throw new Error("Runner command expired before dispatch");
      const receipt = await broker.start(entry.execution.id);
      if (receipt.alreadyAdmitted)
        throw new Error("Runner execution identity was already consumed");
      check(entry);
      if (entry.execution.command.expiresAt <= now())
        throw new Error("Runner command expired before dispatch");
      journal.phase(entry.execution.id, "running");
      entry.execution.phase = "running";
    } catch (error) {
      if (!(error instanceof RemoteFailure))
        await interrupt(entry, error instanceof Error ? error.message : "preparation failed", true);
      report(error);
    } finally {
      if (bundle) rmSync(bundle, { force: true });
      if (snapshotWorkspace) {
        rmSync(snapshotWorkspace, { recursive: true, force: true });
        rmSync(`${snapshotWorkspace}.repository.json`, { force: true });
      }
    }
  }
  function prepare(entry: Active) {
    entry.task = launch(entry)
      .catch(report)
      .finally(() => {
        entry.task = undefined;
      });
  }
  async function drainTranscript(entry: Active, final: boolean, handedOver = false) {
    check(entry);
    let raw: Buffer;
    try {
      raw = transcriptSource(entry.execution.id);
    } catch (error) {
      if (!final && (error as NodeJS.ErrnoException).code === "ENOENT") return;
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
    if (final && !entry.transcriptSealed) {
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
            ...(handedOver ? { handedOver: true as const } : {}),
          },
          token,
        ),
      );
      check(entry);
      entry.transcriptSealed = true;
    }
  }
  async function deliver(entry: Active) {
    // A handover's transcript is sealed by complete(), where Paws may refuse the seal.
    await drainTranscript(
      entry,
      entry.execution.phase === "publishing" && !entry.handoverCommitted,
    );
    for (const delivery of journal.pending(entry.execution.id)) {
      const token = await grant(entry);
      if (delivery.event.type === "artifact") {
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
      workerResultFile(id);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    check(entry);
    entry.restarts = (entry.restarts ?? 0) + 1;
    await broker.resume(id);
    return true;
  }
  /** The worker's final result, or a handed-over result that waits for publication. */
  function workerResultFile(id: string): { name: "result.json" | "handover.json"; raw: Buffer } {
    try {
      return { name: "result.json", raw: readRunnerResultFile(options.results, id, "result.json") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        name: HANDOVER_RESULT,
        raw: readRunnerResultFile(options.results, id, HANDOVER_RESULT),
      };
    }
  }
  /**
   * A handover that cannot be published before its deadline is not published: the worker
   * restarts on its own session, so the session stays on this runner, as Paws reports.
   */
  async function continueSession(entry: Active) {
    if (!broker.resume) throw new Error("the runner could not hand over the session in time");
    check(entry);
    journal.phase(entry.execution.id, "running");
    entry.execution.phase = "running";
    entry.quiesced = undefined;
    entry.pushAt = undefined;
    entry.pushTries = undefined;
    await broker.resume(entry.execution.id);
  }
  async function complete(entry: Active) {
    let file: ReturnType<typeof workerResultFile>;
    try {
      file = workerResultFile(entry.execution.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (broker.alive?.(entry.execution.id) !== false) return;
      try {
        file = workerResultFile(entry.execution.id);
      } catch {
        throw new Error("worker exited without a result");
      }
    }
    // A worker that restarted after a missed handover removes the file itself.
    if (file.name === HANDOVER_RESULT && broker.alive?.(entry.execution.id) === true) return;
    try {
      JSON.parse(file.raw.toString("utf8"));
    } catch {
      return;
    }
    await quiesce(entry);
    check(entry);
    await deliver(entry);
    const worker = workerResult.parse(
      JSON.parse(
        readRunnerResultFile(options.results, entry.execution.id, file.name).toString("utf8"),
      ),
    );
    if (
      worker.executionId !== entry.execution.id ||
      worker.commandId !== entry.execution.command.id ||
      worker.run.role !==
        (entry.execution.command.type === "review" ? "reviewer" : "implementer") ||
      (entry.execution.command.type === "task" &&
        (worker.candidateSha !== undefined || worker.reviewText !== undefined))
    )
      throw new Error("Runner result identity mismatch");
    const result: RunnerResult = RunnerResultSchema.parse({
      ...worker.run,
      executionId: worker.executionId,
      commandId: worker.commandId,
      ...(worker.candidateSha ? { candidateSha: worker.candidateSha } : {}),
      ...(worker.reviewText !== undefined ? { reviewText: worker.reviewText } : {}),
    });
    const handoverBy = file.name === HANDOVER_RESULT ? worker.handoverExpiresAt : undefined;
    if (file.name === HANDOVER_RESULT && (!result.handedOver || handoverBy === undefined))
      throw new Error("Invalid runner handover result");
    // Once the runtime asks Paws to seal the transcript, the handover is only finished.
    const handoverLate = () =>
      handoverBy !== undefined &&
      !entry.handoverCommitted &&
      !entry.transcriptSealed &&
      now() >= handoverBy - HANDOVER_SEAL_RESERVE_MS;
    if (handoverLate()) return continueSession(entry);
    journal.phase(entry.execution.id, "publishing");
    entry.execution.phase = "publishing";
    if (
      result.candidateSha &&
      entry.execution.command.type !== "task" &&
      result.candidateSha !== entry.execution.command.repository.baseSha
    ) {
      if (
        entry.execution.command.type !== "run" ||
        (result.cancelled && !result.handedOver) ||
        !result.agentExited
      )
        throw new Error("Unsafe runner candidate result");
      if ((entry.pushAt ?? 0) > monotonic()) return;
      if (handoverBy !== undefined && entry.handoverCommitted) {
        // The push finished before the seal was asked for; a retry only completes the seal.
      } else if (handoverBy !== undefined) {
        // A handover gets one push, bounded by its deadline.
        const signal = AbortSignal.any([
          entry.abort.signal,
          AbortSignal.timeout(Math.max(1, handoverBy - HANDOVER_SEAL_RESERVE_MS - now())),
        ]);
        try {
          const token = await grant(entry);
          const credential = await remote(() =>
            options.daemon.repositoryCredential(
              entry.execution.command.runId,
              entry.execution.command.generation,
              "write",
              token,
            ),
          );
          if (!credential.branch) throw new Error("Runner publication branch is missing");
          signal.throwIfAborted();
          entry.publicationBranch = credential.branch;
          await repositories.publish(
            entry.execution.command,
            {
              bundle: readRunnerResultFile(options.results, entry.execution.id, "candidate.bundle"),
              sha: result.candidateSha,
              branch: credential.branch,
            },
            signal,
          );
        } catch (error) {
          entry.abort.signal.throwIfAborted();
          report(error instanceof Error ? error : new Error(String(error)));
          return continueSession(entry);
        }
        check(entry);
        if (handoverLate()) return continueSession(entry);
      } else {
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
          await repositories.publish(
            entry.execution.command,
            {
              bundle: readRunnerResultFile(options.results, entry.execution.id, "candidate.bundle"),
              sha: result.candidateSha,
              branch: credential.branch,
            },
            entry.abort.signal,
          );
        } catch (error) {
          if (!(error instanceof GitHubFailure)) throw error;
          const tries = (entry.pushTries ?? 0) + 1;
          entry.pushTries = tries;
          const permanent = PERMANENT_PUSH_REJECTION.test(error.message);
          if (!permanent && tries <= CANDIDATE_PUSH_RETRY_MS.length) {
            entry.pushAt = monotonic() + CANDIDATE_PUSH_RETRY_MS[tries - 1]!;
            throw error;
          }
          const failure = { branch: credential.branch, error: error.message.slice(0, 4096) };
          await interrupt(
            entry,
            permanent
              ? `GitHub rejected the candidate push to ${failure.branch}: ${failure.error}`
              : `the candidate push to ${failure.branch} failed ${tries} times: ${failure.error}`,
            true,
            failure,
          );
          return;
        }
        check(entry);
      }
    }
    if (handoverLate()) return continueSession(entry);
    if (handoverBy !== undefined) {
      entry.handoverCommitted = true;
      journal.phase(entry.execution.id, "handover");
      try {
        await drainTranscript(entry, true, true);
      } catch (error) {
        // Paws refused the seal, so the transcript is open and the session stays here.
        if (
          error instanceof RunnerRequestError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status) &&
          !entry.transcriptSealed
        ) {
          entry.handoverCommitted = false;
          report(error);
          return continueSession(entry);
        }
        throw error;
      }
    } else await drainTranscript(entry, true);
    const token = await grant(entry);
    await remote(() =>
      options.daemon.postResult(
        entry.execution.command.runId,
        entry.execution.command.generation,
        result,
        token,
      ),
    );
    check(entry);
    journal.phase(entry.execution.id, "complete");
    active.delete(key(entry.execution.command));
  }
  async function step() {
    await pulse().catch(report);
    if (closed) return;
    if (recovering.length) await recoverHandovers();
    const polled = await options.daemon.pollCommands();
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
      if (command.type !== "cancel") continue;
      const entry = active.get(`${command.runId}:${command.generation}`);
      if (entry) await interrupt(entry, "cancelled by Paws");
      await options.daemon.acknowledgeCommand(command.id);
    }
    for (const command of commands) {
      if (command.type !== "handover") continue;
      const entry = active.get(`${command.runId}:${command.generation}`);
      // Only a running worker can hand over. Paws reports a handover that gets no result.
      if (
        entry?.execution.phase === "running" &&
        entry.execution.command.type === "run" &&
        !entry.abort.signal.aborted &&
        command.expiresAt > now()
      )
        try {
          let sequence = 1;
          while (readRunnerHandover(options.spool, entry.execution.id, sequence)) sequence++;
          publishRunnerHandover(options.spool, entry.execution.id, sequence, command.expiresAt);
        } catch (error) {
          report(error instanceof Error ? error : new Error(String(error)));
        }
      await options.daemon.acknowledgeCommand(command.id);
    }
    for (const entry of active.values()) {
      if (entry.abort.signal.aborted) {
        await settle([entry.stopped, entry.task]);
        active.delete(key(entry.execution.command));
      } else if (entry.execution.phase === "preparing") {
        if (!entry.task) prepare(entry);
      }
    }
    if (active.size < concurrency()) {
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
        const entry: Active = { execution, abort: new AbortController(), deadline };
        active.set(key(command), entry);
        prepare(entry);
        await options.daemon.acknowledgeCommand(command.id).catch(report);
        if (active.size >= concurrency()) break;
      }
    }
    for (const entry of active.values()) {
      if (entry.execution.phase !== "running" && entry.execution.phase !== "publishing") continue;
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
      await deliver(entry);
      if (!(await resumeIfCrashed(entry))) await complete(entry);
    } catch (error) {
      if (error instanceof RemoteFailure) return report(error);
      await interrupt(entry, error instanceof Error ? error.message : "runner error", true).catch(
        report,
      );
    }
  }
  const heartbeat = setInterval(() => {
    void pulse().catch(report);
  }, 15_000);
  const watchdog = setInterval(() => {
    for (const entry of active.values())
      if (monotonic() >= entry.deadline + RUNNER_LEASE_GRACE_MS)
        void interrupt(entry, "lease deadline passed", true).catch(report);
      else if (entry.execution.phase === "preparing" && entry.execution.command.expiresAt <= now())
        void interrupt(entry, "command expired before the worker started", true).catch(report);
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
        await Promise.all([...active.values()].map((entry) => interrupt(entry, "runner stopping")));
        await Promise.allSettled([
          ticking,
          pulsing,
          ...[...active.values()].flatMap((entry) => [entry.task, entry.delivering]),
        ]);
        journal.close();
      })();
      return stopping;
    },
  };
}
