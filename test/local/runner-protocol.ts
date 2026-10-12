import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { openDatabase } from "../../src/db";
import {
  signRunnerCommand,
  verifyRunnerCommand,
  type RunnerCommand,
  type RunnerCommandVerifier,
} from "../../src/runner-protocol";

export function probeRunnerProtocol(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  const keys = generateKeyPairSync("ed25519");
  const command: RunnerCommand = {
    id: "signed-command-1",
    type: "run",
    runnerId: "paired-runner-1",
    workspaceId: "workspace-1",
    issuedAt: 1000,
    expiresAt: 2000,
    runId: "run-1",
    itemId: "item-1",
    generation: 3,
    repository: {
      owner: "local",
      repo: "fixture",
      remoteUrl: "https://github.com/local/fixture.git",
      baseSha: "a".repeat(40),
    },
    profile: { agent: "claude", model: null },
    prompt: "Preserve every row.",
  };
  const envelope = signRunnerCommand({
    keyId: "control-plane-1",
    privateKey: keys.privateKey,
    command,
  });
  const path = join(root, "runner-command-replay.db");
  let db = openDatabase(path);
  db.run("CREATE TABLE command_receipt (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT");
  const context: RunnerCommandVerifier = {
    trustedKeys: new Map([[envelope.keyId, keys.publicKey]]),
    runnerId: command.runnerId,
    workspaceId: command.workspaceId,
    now: 1500,
    allowedRepositories: ["local/fixture"],
    claimCommand: (id, expiresAt) =>
      db.run("INSERT INTO command_receipt VALUES (?,?) ON CONFLICT DO NOTHING", [id, expiresAt])
        .changes === 1,
  };
  try {
    const accepted = verifyRunnerCommand(envelope, context);
    db.close();
    db = openDatabase(path);
    const replay = verifyRunnerCommand(envelope, context);
    observe(
      "signed runner command accepts once and its replay fence survives SQLite reopen",
      accepted.ok && !replay.ok && replay.reason === "replayed",
      {
        accepted: accepted.ok,
        commandId: accepted.ok ? accepted.command.id : null,
        replay,
        receipts: db.query("SELECT * FROM command_receipt").all(),
      },
    );
    const second = signRunnerCommand({
      keyId: envelope.keyId,
      privateKey: keys.privateKey,
      command: { ...command, id: "signed-command-2" },
    });
    const mismatch = verifyRunnerCommand(second, { ...context, runnerId: "different-runner" });
    const denied = verifyRunnerCommand(second, { ...context, allowedRepositories: [] });
    const expired = verifyRunnerCommand(second, { ...context, now: 2000 });
    const tampered = verifyRunnerCommand({ ...second, payload: envelope.payload }, context);
    const admitted = verifyRunnerCommand(second, context);
    observe(
      "runner signatures enforce identity, repository and expiry without consuming rejected commands",
      !mismatch.ok &&
        mismatch.reason === "identity_mismatch" &&
        !denied.ok &&
        denied.reason === "repository_denied" &&
        !expired.ok &&
        expired.reason === "expired" &&
        !tampered.ok &&
        tampered.reason === "invalid_signature" &&
        admitted.ok,
      { mismatch, denied, expired, tampered, admitted: admitted.ok },
    );
  } finally {
    db.close();
  }
}
