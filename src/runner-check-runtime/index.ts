import { chmodSync, rmSync, statSync } from "node:fs";
import { runGitHubGit } from "../github";
import { isAbsolute, join } from "node:path";
import { openDatabase, immediate } from "../db";
import { RunnerRequestError, type RunnerDaemon, type RunnerGrant } from "../runner-daemon";
import { createRunnerCheckBrokerClient, type RunnerCheckBrokerClient } from "../runner-execution";
import {
  deriveRunnerCheckInput,
  publishRunnerCheckAttempt,
  publishRunnerCheckCommand,
  readRunnerCheckResult,
  RunnerCheckResultSchema,
  type RunnerCheckInput,
  type RunnerCheckPaths,
} from "../runner-check";
import {
  readRunnerCheckSignature,
  runnerVerifierFingerprint,
  verifyRunnerCheckResult,
} from "../runner-verifier";
import { createRunnerRepositories } from "../runner-repositories";
import { RunnerCommandSchema, type RunnerCommand } from "../runner-protocol";

type Command = Extract<RunnerCommand, { type: "check" }>;
type Stored = {
  id: string;
  payload: string;
  phase: string;
  result: string | null;
  signature: string | null;
  grant: string | null;
};
type Active = {
  command: Command;
  input: RunnerCheckInput;
  phase: "preparing" | "running" | "publishing" | "interrupted";
  deadline: number;
  abort: AbortController;
  grant?: RunnerGrant;
  task?: Promise<void>;
  stopped?: Promise<void>;
  quiesced?: Promise<void>;
};
class RemoteFailure extends Error {}
async function remote<T>(operation: () => Promise<T>): Promise<T> {
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
    throw new RemoteFailure("Runner control plane is unavailable");
  }
}

export async function openRunnerCheckRuntime(options: {
  root: string;
  daemon: Pick<
    RunnerDaemon,
    | "status"
    | "heartbeat"
    | "pollCommands"
    | "pendingCommands"
    | "acknowledgeCommand"
    | "issueRunGrant"
    | "repositoryCredential"
    | "postCheckResult"
  >;
  paths: RunnerCheckPaths;
  repositoryRoot: string;
  home: string;
  verifierPublicKeyPem: string;
  broker?: RunnerCheckBrokerClient;
  networkGit?: Parameters<typeof createRunnerRepositories>[0]["networkGit"];
  now?: () => number;
  monotonic?: () => number;
  onError?: (error: Error) => void;
}) {
  const identity = options.daemon.status();
  if (
    identity.phase !== "paired" ||
    identity.verifierFingerprint !== runnerVerifierFingerprint(options.verifierPublicKeyPem)
  )
    throw new Error("Runner verifier must match its approved pairing");
  if (!isAbsolute(options.root)) throw new Error("Runner check root must be absolute");
  const info = statSync(options.root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Runner check root must be private");
  const path = join(options.root, "checks.db");
  const db = openDatabase(path);
  chmodSync(path, 0o600);
  db.run(
    "CREATE TABLE IF NOT EXISTS check_execution(id TEXT PRIMARY KEY,command_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL,result TEXT,signature TEXT,grant TEXT) STRICT",
  );
  const broker = options.broker ?? createRunnerCheckBrokerClient();
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const report = () => options.onError?.(new Error("Runner check operation failed"));
  const rows = () =>
    db
      .query<Stored, []>(
        "SELECT id,payload,phase,result,signature,grant FROM check_execution WHERE phase NOT IN ('complete','interrupted') ORDER BY rowid",
      )
      .all();
  try {
    for (const row of rows()) {
      await broker.stopCheck(row.id);
      if (row.phase !== "publishing")
        db.run("UPDATE check_execution SET phase='interrupted' WHERE id=?", [row.id]);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let active: Active | undefined;
  let closed = false;
  let ticking: Promise<void> | undefined;
  let pulsing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const leases = new Map<string, number>();
  const key = (command: Command) => `${command.runId}:${command.generation}`;
  function input(command: Command) {
    return deriveRunnerCheckInput({
      executionId: command.executionId,
      verificationAttemptId: command.verificationAttemptId,
      candidateSha: command.candidateSha,
      checkoutExclusions: command.repository.checkoutExclusions,
      argv: command.argv,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
    });
  }
  function quiesce(entry: Active) {
    entry.quiesced ??= broker.stopCheck(entry.command.executionId);
    return entry.quiesced;
  }
  async function interrupt(entry: Active) {
    entry.abort.abort();
    entry.stopped ??= (async () => {
      await quiesce(entry);
      db.run("UPDATE check_execution SET phase='interrupted' WHERE id=?", [
        entry.command.executionId,
      ]);
      entry.phase = "interrupted";
    })();
    await entry.stopped;
  }
  function check(entry: Active) {
    const current = options.daemon.status();
    if (
      closed ||
      current.phase !== "paired" ||
      current.runnerId !== entry.command.runnerId ||
      current.workspaceId !== entry.command.workspaceId ||
      (entry.phase !== "publishing" &&
        (monotonic() >= entry.deadline || now() >= entry.command.expiresAt))
    )
      throw new Error("Runner check is fenced or its lease expired");
    entry.abort.signal.throwIfAborted();
  }
  async function grant(entry: Active) {
    check(entry);
    if (!entry.grant || entry.grant.expiresAt <= now() + 5000) {
      const value = await remote(() =>
        options.daemon.issueRunGrant(entry.command.runId, {
          commandId: entry.command.id,
          generation: entry.command.generation,
        }),
      );
      check(entry);
      entry.grant = value;
    }
    return entry.grant.token;
  }
  const repositories = createRunnerRepositories({
    root: options.repositoryRoot,
    home: options.home,
    networkGit: (request) => remote(() => (options.networkGit ?? runGitHubGit)(request)),
    async credential(command, access) {
      const entry = active;
      if (!entry || command.id !== entry.command.id || access !== "read")
        throw new Error("Runner check requires an active read-only repository grant");
      const token = await grant(entry);
      const result = await remote(() =>
        options.daemon.repositoryCredential(command.runId, command.generation, "read", token),
      );
      check(entry);
      return result.token;
    },
  });
  function pulse(): Promise<void> {
    if (pulsing) return pulsing;
    if (closed || active?.phase === "publishing") return Promise.resolve();
    pulsing = (async () => {
      const started = monotonic();
      const response = await options.daemon.heartbeat();
      if (closed) return;
      leases.clear();
      for (const lease of response.leases)
        leases.set(
          `${lease.runId}:${lease.generation}`,
          Math.min(
            started + 60_000,
            monotonic() + Math.max(0, Math.min(60_000, lease.expiresAt - now())),
          ),
        );
      const entry = active;
      if (entry && entry.phase !== "publishing") {
        const deadline = leases.get(key(entry.command));
        if (
          !deadline ||
          response.fenced.some(
            (value) => key(entry.command) === `${value.runId}:${value.generation}`,
          )
        )
          await interrupt(entry);
        else if (!entry.abort.signal.aborted) entry.deadline = deadline;
      }
    })().finally(() => {
      pulsing = undefined;
    });
    return pulsing;
  }
  async function launch(entry: Active) {
    let bundle: string | undefined;
    try {
      await grant(entry);
      check(entry);
      try {
        publishRunnerCheckCommand(options.paths, entry.input);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const snapshot = await repositories.prepare(entry.command, entry.abort.signal);
        bundle = snapshot.bundle;
        check(entry);
        publishRunnerCheckAttempt(
          options.paths,
          {
            verificationAttemptId: entry.command.verificationAttemptId,
            candidateSha: entry.command.candidateSha,
            checkoutExclusions: entry.command.repository.checkoutExclusions,
          },
          { repositoryBundle: bundle },
        );
        publishRunnerCheckCommand(options.paths, entry.input);
      }
      check(entry);
      const receipt = await broker.startCheck(entry.command.executionId);
      check(entry);
      if (receipt.alreadyAdmitted) throw new Error("Runner check execution was already consumed");
      db.run("UPDATE check_execution SET phase='running' WHERE id=?", [entry.command.executionId]);
      entry.phase = "running";
    } catch (error) {
      if (!(error instanceof RemoteFailure)) await interrupt(entry);
      throw error;
    } finally {
      if (bundle) rmSync(bundle, { force: true });
    }
  }
  function prepare(entry: Active) {
    entry.task = launch(entry)
      .catch(report)
      .finally(() => {
        entry.task = undefined;
      });
  }
  function attestation(entry: Active) {
    const result = readRunnerCheckResult(options.paths, entry.input);
    if (!result) return null;
    const signature = readRunnerCheckSignature(options.paths, entry.input);
    if (!signature || !verifyRunnerCheckResult(result, signature, options.verifierPublicKeyPem))
      throw new Error("Runner check attestation is invalid");
    return { result, signature };
  }
  async function complete(entry: Active) {
    if (entry.phase === "running") {
      check(entry);
      if (!attestation(entry)) return;
      await quiesce(entry);
      check(entry);
      const final = attestation(entry);
      if (!final) throw new Error("Runner check result disappeared");
      const token = await grant(entry);
      immediate(db, () =>
        db.run(
          "UPDATE check_execution SET phase='publishing',result=?,signature=?,grant=? WHERE id=?",
          [JSON.stringify(final.result), final.signature, token, entry.command.executionId],
        ),
      );
      entry.phase = "publishing";
    }
    check(entry);
    const row = db
      .query<Stored, [string]>(
        "SELECT id,payload,phase,result,signature,grant FROM check_execution WHERE id=?",
      )
      .get(entry.command.executionId)!;
    const result = RunnerCheckResultSchema.parse(JSON.parse(row.result!));
    if (
      !row.signature ||
      !verifyRunnerCheckResult(result, row.signature, options.verifierPublicKeyPem)
    )
      throw new Error("Stored runner check attestation is invalid");
    if (!row.grant) throw new Error("Stored runner check grant is missing");
    const token = row.grant;
    await remote(() =>
      options.daemon.postCheckResult(
        entry.command.runId,
        entry.command.generation,
        result,
        row.signature!,
        token,
      ),
    );
    db.run("UPDATE check_execution SET phase='complete' WHERE id=?", [entry.command.executionId]);
    if (active === entry) active = undefined;
  }
  async function step(admit: boolean) {
    if (!active) {
      const pending = rows().find((row) => row.phase === "publishing");
      if (pending) {
        const command = RunnerCommandSchema.parse(JSON.parse(pending.payload));
        if (command.type !== "check" || command.executionId !== pending.id)
          throw new Error("Stored runner check command is invalid");
        if (closed) return;
        active = {
          command,
          input: input(command),
          phase: "publishing",
          deadline: 0,
          abort: new AbortController(),
          quiesced: Promise.resolve(),
        };
      }
    }
    if (active?.phase === "publishing") {
      try {
        await complete(active);
      } catch (error) {
        if (closed || error instanceof RemoteFailure) {
          report();
          return;
        }
        await interrupt(active);
        report();
      }
      return;
    }
    await pulse().catch(report);
    if (closed) return;
    await options.daemon.pollCommands();
    if (closed) return;
    const commands = options.daemon.pendingCommands();
    for (const command of commands) {
      if (command.type !== "cancel") continue;
      if (
        active &&
        active.command.runId === command.runId &&
        active.command.generation === command.generation
      )
        await interrupt(active);
      await options.daemon.acknowledgeCommand(command.id);
    }
    if (active?.abort.signal.aborted) {
      const entry = active;
      await entry.stopped;
      await entry.task;
      if (active === entry) active = undefined;
    }
    if (active?.phase === "preparing") {
      if (!active.task) prepare(active);
      return;
    }
    if (!active && admit) {
      for (const command of commands) {
        if (command.type !== "check") continue;
        if (command.expiresAt <= now()) {
          await options.daemon.acknowledgeCommand(command.id);
          continue;
        }
        const deadline = leases.get(key(command));
        if (!deadline || deadline <= monotonic()) continue;
        if (closed) return;
        const payload = JSON.stringify(command);
        const existing = db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM check_execution WHERE command_id=?",
          )
          .get(command.id);
        if (existing) {
          if (existing.payload !== payload) throw new Error("Stored runner check command changed");
          await options.daemon.acknowledgeCommand(command.id);
          continue;
        }
        const entry: Active = {
          command,
          input: input(command),
          phase: "preparing",
          deadline,
          abort: new AbortController(),
        };
        db.run(
          "INSERT INTO check_execution(id,command_id,payload,phase) VALUES(?,?,?,'preparing')",
          [command.executionId, command.id, payload],
        );
        active = entry;
        prepare(entry);
        await options.daemon.acknowledgeCommand(command.id).catch(report);
        return;
      }
    }
    if (active?.phase === "running") {
      const entry = active;
      try {
        await complete(entry);
      } catch (error) {
        if (closed || error instanceof RemoteFailure) {
          report();
          return;
        }
        await interrupt(entry);
        report();
      }
    }
  }
  const heartbeat = setInterval(() => {
    void pulse().catch(report);
  }, 15_000);
  const watchdog = setInterval(() => {
    if (
      active &&
      active.phase !== "publishing" &&
      !active.abort.signal.aborted &&
      (monotonic() >= active.deadline || now() >= active.command.expiresAt)
    )
      void interrupt(active).catch(report);
  }, 250);
  return {
    status: () => ({
      active: active
        ? {
            executionId: active.command.executionId,
            commandId: active.command.id,
            phase: active.phase,
          }
        : null,
    }),
    tick(admit = true) {
      if (closed) return Promise.reject(new Error("Runner check runtime is closed"));
      ticking ??= step(admit).finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
    stop() {
      stopping ??= (async () => {
        closed = true;
        clearInterval(heartbeat);
        clearInterval(watchdog);
        if (active) {
          if (active.phase === "publishing") await quiesce(active);
          else await interrupt(active);
        }
        await Promise.allSettled([ticking, pulsing, active?.task]);
        db.close();
      })();
      return stopping;
    },
  };
}
