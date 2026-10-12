import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { openRunnerDaemon } from "../../src/runner-daemon";

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  root: string;
  controlPlaneUrl: string;
  runnerApiUrl: string;
  serverCa: string;
  signingKey: string;
};
let daemon: ReturnType<typeof openRunnerDaemon> | undefined;
try {
  daemon = openRunnerDaemon({
    ...config,
    trustedKeys: new Map([["coordinator", createPublicKey(config.signingKey)]]),
    allowedRepositories: ["local/fixture"],
  });
  let result: unknown;
  switch (process.argv[3]) {
    case "pair":
      result = await daemon.beginPairing("Local Linux runner");
      break;
    case "claim":
      result = await daemon.pollPairing();
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
