import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishRunnerCheckAttempt,
  publishRunnerCheckCommand,
  readRunnerCheckResult,
  deriveRunnerCheckInput,
  runnerCheckInputHash,
  type RunnerCheckPaths,
} from "../../src/runner-check";

const root = process.argv[3]!;
const paths: RunnerCheckPaths = {
  inputRoot: join(root, "inputs"),
  workRoot: "/var/lib/paws-check-attempts",
  resultRoot: join(root, "results"),
  runnerUid: 1001,
  runnerGid: 1001,
  inputGid: 1004,
  checkUid: 1005,
  checkGid: 1005,
};
const executionId = "01K00000000000000000000001";
const verificationAttemptId = "01K00000000000000000000000";
const input = deriveRunnerCheckInput({
  executionId,
  verificationAttemptId,
  candidateSha: "a".repeat(40),
  argv: ["/usr/bin/true"],
  cwd: ".",
  timeoutMs: 1000,
});
if (process.argv[2] === "publish") {
  const repositoryBundle = join(root, "daemon", "source.bundle");
  writeFileSync(repositoryBundle, "synthetic immutable bundle", { mode: 0o600 });
  publishRunnerCheckAttempt(
    paths,
    { verificationAttemptId, candidateSha: input.candidateSha },
    { repositoryBundle },
  );
  publishRunnerCheckCommand(paths, input);
  if (readRunnerCheckResult(paths, input) !== null) throw new Error("Unexpected result");
  console.log(JSON.stringify({ published: true }));
} else if (process.argv[2] === "read-binary") {
  const result = readRunnerCheckResult(paths, input);
  if (result?.stdout !== "\0".repeat(1_048_576) || result?.stderr !== "\0".repeat(1_048_576))
    throw new Error("Bounded binary output was rejected");
  console.log(JSON.stringify({ readBinary: true }));
} else if (process.argv[2] === "read") {
  const result = readRunnerCheckResult(paths, input);
  if (
    result?.stdout !== "trusted witness output" ||
    result?.exitCode !== 0 ||
    !result.timedOut ||
    result.inputSha256 !== runnerCheckInputHash(input)
  )
    throw new Error("Trusted result missing");
  let writeDenied = false;
  try {
    writeFileSync(join(paths.resultRoot, executionId, "result.json"), "forged");
  } catch {
    writeDenied = true;
  }
  if (!writeDenied) throw new Error("Daemon overwrote trusted result");
  console.log(JSON.stringify({ read: true, writeDenied }));
} else if (process.argv[2] === "reject") {
  let rejected = false;
  try {
    readRunnerCheckResult(paths, input);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Unsafe trusted result accepted");
  console.log(JSON.stringify({ rejected: true }));
} else if (process.argv[2] === "deny") {
  let inputDenied = false;
  let publishDenied = false;
  let resultDenied = false;
  try {
    readFileSync(join(paths.inputRoot, "commands", executionId, "job.json"));
  } catch {
    inputDenied = true;
  }
  try {
    publishRunnerCheckCommand(paths, input);
  } catch {
    publishDenied = true;
  }
  try {
    writeFileSync(join(paths.resultRoot, executionId, "result.json"), "forged");
  } catch {
    resultDenied = true;
  }
  if (!inputDenied || !publishDenied || !resultDenied) throw new Error("UID boundary failed");
  console.log(JSON.stringify({ inputDenied, publishDenied, resultDenied }));
} else throw new Error("Unknown proof mode");
