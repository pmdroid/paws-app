import { generateKeyPairSync, sign } from "node:crypto";
import { chownSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishRunnerCheckAttempt,
  publishRunnerCheckCommand,
  readRunnerCheckResult,
  deriveRunnerCheckInput,
  runnerCheckInputHash,
  type RunnerCheckPaths,
} from "../../src/runner-check";
import {
  readRunnerCheckSignature,
  runnerCheckResultSigningBytes,
  verifyRunnerCheckResult,
} from "../../src/runner-verifier";

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
if (process.argv[2] === "sign-witness") {
  const result = readRunnerCheckResult(paths, input);
  if (result === null) throw new Error("Missing witness result");
  const keys = generateKeyPairSync("ed25519");
  writeFileSync(join(root, "witness.pem"), keys.publicKey.export({ type: "spki", format: "pem" }), {
    mode: 0o644,
  });
  const file = join(paths.resultRoot, executionId, "verifier-signature");
  writeFileSync(
    file,
    sign(null, runnerCheckResultSigningBytes(result), keys.privateKey).toString("base64"),
    {
      mode: 0o640,
    },
  );
  chownSync(file, 0, paths.runnerGid);
  console.log(JSON.stringify({ signed: true }));
} else if (process.argv[2] === "read-signature") {
  const result = readRunnerCheckResult(paths, input);
  const signature = readRunnerCheckSignature(paths, input);
  const pem = readFileSync(join(root, "witness.pem"), "utf8");
  if (result === null || signature === null || !verifyRunnerCheckResult(result, signature, pem))
    throw new Error("Trusted witness signature missing");
  let writeDenied = false;
  try {
    writeFileSync(join(paths.resultRoot, executionId, "verifier-signature"), "forged");
  } catch {
    writeDenied = true;
  }
  if (!writeDenied) throw new Error("Daemon overwrote witness signature");
  console.log(JSON.stringify({ signatureVerified: true, writeDenied }));
} else if (process.argv[2] === "reject-signature") {
  let rejected = false;
  try {
    const result = readRunnerCheckResult(paths, input);
    const signature = readRunnerCheckSignature(paths, input);
    rejected =
      result === null ||
      signature === null ||
      !verifyRunnerCheckResult(result, signature, readFileSync(join(root, "witness.pem"), "utf8"));
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Unsafe witness signature accepted");
  console.log(JSON.stringify({ rejectedSignature: true }));
} else if (process.argv[2] === "publish") {
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
