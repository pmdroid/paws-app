import { chmodSync, chownSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishRunnerJob,
  readRunnerJob,
  readRunnerResultFile,
  runnerResultDirectory,
  type RunnerJob,
} from "../../src/runner-execution";

const mode = process.argv[2];
const root = process.argv[3]!;
const executionId = "01K00000000000000000000000";
const spool = { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 };
const results = { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 };
const job: RunnerJob = {
  executionId,
  command: {
    id: "command",
    runnerId: "runner",
    workspaceId: "workspace",
    type: "probe",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 120_000,
    profile: { agent: "codex", model: null },
  },
};
if (mode === "publish") {
  publishRunnerJob(spool, job);
  console.log(JSON.stringify({ published: true }));
} else if (mode === "read") {
  const read = readRunnerJob(spool, executionId);
  let publishDenied = false;
  try {
    publishRunnerJob(spool, job);
  } catch {
    publishDenied = true;
  }
  if (read.executionId !== executionId || !publishDenied) throw new Error("UID boundary failed");
  console.log(JSON.stringify({ read: true, publishDenied }));
} else if (mode === "result") {
  const directory = runnerResultDirectory(results, executionId);
  const path = join(directory, "result.json");
  writeFileSync(path, "synthetic result");
  chownSync(path, 1002, 1003);
  chmodSync(path, 0o640);
  symlinkSync(path, join(directory, "candidate.bundle"));
  console.log(JSON.stringify({ written: true }));
} else if (mode === "verify") {
  const result = readRunnerResultFile(results, executionId, "result.json").toString();
  let symlinkDenied = false;
  try {
    readRunnerResultFile(results, executionId, "candidate.bundle");
  } catch {
    symlinkDenied = true;
  }
  if (!symlinkDenied) throw new Error("Result symlink accepted");
  console.log(JSON.stringify({ result, symlinkDenied }));
} else throw new Error("Unknown proof mode");
