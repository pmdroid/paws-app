import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import type { RunnerResult } from "../../src/runner-protocol";

const workResult = {
  executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  commandId: "command-one",
  role: "implementer",
  stopReason: "end_turn",
  timedOut: false,
  cancelled: false,
  authRequired: false,
  agentExited: true,
  candidateSha: "b".repeat(40),
} satisfies RunnerResult;

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  root: string;
  controlPlaneUrl: string;
  runnerApiUrl: string;
  serverCa: string;
  signingKey: string;
  pinned?: boolean;
};
let daemon: ReturnType<typeof openRunnerDaemon> | undefined;
try {
  daemon = openRunnerDaemon({
    ...config,
    trustedKeys: config.pinned
      ? new Map([["coordinator", createPublicKey(config.signingKey)]])
      : undefined,
    allowedRepositories: ["local/fixture"],
  });
  let result: unknown;
  switch (process.argv[3]) {
    case "enroll":
      result = await daemon.enroll("Local Linux runner", "t".repeat(43));
      break;
    case "commands": {
      const polled = await daemon.pollCommands();
      result = { ids: polled.commands.map((command) => command.id), rejected: polled.rejected };
      break;
    }
    case "ack":
      await daemon.acknowledgeCommand(process.argv[4]!);
      result = { ids: daemon.pendingCommands().map((command) => command.id) };
      break;
    case "heartbeat":
      await daemon.heartbeat();
      result = daemon.status();
      break;
    case "leases":
      result = await daemon.heartbeat();
      break;
    case "events": {
      const grant = await daemon.issueRunGrant("run-one", {
        commandId: "command-one",
        generation: 1,
      });
      const delivery = {
        runId: "run-one",
        generation: 1,
        sequence: 1,
        event: { type: "progress" as const, text: "Remote work started." },
      };
      result = {
        first: await daemon.sendEvent(delivery, grant.token),
        replay: await daemon.sendEvent(delivery, grant.token),
      };
      break;
    }
    case "repository":
    case "repository-read":
    case "repository-write": {
      const grant = await daemon.issueRunGrant("run-one", {
        commandId: "command-one",
        generation: 1,
      });
      const modes =
        process.argv[3] === "repository" ? ["read", "write"] : [process.argv[3]!.slice(11)];
      const credentials = [];
      for (const access of modes) {
        if (access !== "read" && access !== "write") throw new Error("Invalid fixture access");
        const credential = await daemon.repositoryCredential("run-one", 1, access, grant.token);
        credentials.push({ remoteUrl: credential.remoteUrl, branch: credential.branch });
      }
      result = credentials;
      break;
    }
    case "results":
    case "answers":
    case "fenced-result": {
      const grant = await daemon.issueRunGrant("run-one", {
        commandId: "command-one",
        generation: 1,
      });
      if (process.argv[3] === "answers") {
        const first = await daemon.answers("run-one", 1, 0, grant.token);
        result = { first, next: await daemon.answers("run-one", 1, 5, grant.token) };
      } else if (process.argv[3] === "fenced-result") {
        try {
          await daemon.postResult("run-one", 1, workResult, grant.token);
          throw new Error("Fenced result unexpectedly accepted");
        } catch (error) {
          if (!(error instanceof RunnerRequestError)) throw error;
          result = { status: error.status };
        }
      } else {
        result = {
          first: await daemon.postResult("run-one", 1, workResult, grant.token),
          replay: await daemon.postResult("run-one", 1, workResult, grant.token),
        };
      }
      break;
    }
    case "invalid-results": {
      const current = daemon;
      const rawResult = { ...workResult, rawOutput: "forbidden" };
      const pathResult = { ...workResult, worktree: "/tmp/forbidden" };
      let rejected = 0;
      for (const operation of [
        () => current.postResult("../other", 1, workResult, "a".repeat(43)),
        () => current.postResult("run-one", 0, workResult, "a".repeat(43)),
        () => current.postResult("run-one", 1, rawResult, "a".repeat(43)),
        () => current.postResult("run-one", 1, pathResult, "a".repeat(43)),
        () => current.answers("run-one", 1, -1, "a".repeat(43)),
        () => current.answers("run-one", 1, 0, "invalid"),
      ]) {
        try {
          await operation();
        } catch {
          rejected++;
        }
      }
      result = { rejected };
      break;
    }
    case "invalid-work": {
      let rejected = 0;
      const current = daemon;
      const credentialedRequest = { commandId: "command-one", generation: 1, token: "forbidden" };
      const credentialedEvent = {
        runId: "run-one",
        generation: 1,
        sequence: 1,
        event: { type: "completed" as const },
        token: "forbidden",
      };
      for (const operation of [
        () => current.issueRunGrant("../other", { commandId: "command-one", generation: 1 }),
        () => current.issueRunGrant("run-one", { commandId: "command-one", generation: 0 }),
        () => current.issueRunGrant("run-one", credentialedRequest),
        () => current.sendEvent(credentialedEvent, "a".repeat(43)),
        () => current.repositoryCredential("unknown-run", 1, "read", "a".repeat(43)),
        () => current.repositoryCredential("run-one", 2, "read", "a".repeat(43)),
        () => current.repositoryCredential("run-review", 1, "write", "a".repeat(43)),
        () =>
          current.sendEvent(
            {
              runId: "run-one",
              generation: 1,
              sequence: 1,
              event: { type: "completed" },
            },
            "invalid-token",
          ),
        () =>
          current.sendEvent(
            {
              runId: "run-one",
              generation: 1,
              sequence: 0,
              event: { type: "completed" },
            },
            "a".repeat(43),
          ),
      ]) {
        try {
          await operation();
        } catch {
          rejected++;
        }
      }
      result = { rejected };
      break;
    }
    case "renew":
      result = await daemon.renewCertificate();
      break;
    default:
      throw new Error("Unknown fixture action");
  }
  process.stdout.write(JSON.stringify({ pid: process.pid, result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      error: error instanceof Error ? error.message : "Runner fixture failed",
    }),
  );
  process.exitCode = 1;
} finally {
  daemon?.close();
}
