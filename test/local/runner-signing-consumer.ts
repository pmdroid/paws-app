import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  runnerCheckResultSigningBytes,
  runnerVerifierFingerprint,
  verifyRunnerCheckResult,
} from "../../src/runner-verifier";

const { result, signature, identity, canonical } = JSON.parse(
  readFileSync(process.argv[2]!, "utf8"),
);
assert.equal(runnerVerifierFingerprint(identity.verifierPublicKeyPem), identity.fingerprint);
assert.equal(runnerCheckResultSigningBytes(result).toString("base64"), canonical);
assert(verifyRunnerCheckResult(result, signature, identity.verifierPublicKeyPem));
assert.equal(
  readFileSync("/var/lib/paws-check-verifier-public.pem", "utf8"),
  identity.verifierPublicKeyPem,
);
assert.equal(
  verify(
    null,
    runnerCheckResultSigningBytes(result).subarray(
      Buffer.byteLength("paws.runner-check-result.v1\0"),
    ),
    createPublicKey(identity.verifierPublicKeyPem),
    Buffer.from(signature, "base64"),
  ),
  false,
);
assert(
  verifyRunnerCheckResult(
    Object.fromEntries(Object.entries(result).reverse()) as typeof result,
    signature,
    identity.verifierPublicKeyPem,
  ),
);
const mutations = [
  { executionId: "01K00000000000000000000003" },
  { verificationAttemptId: "01K00000000000000000000004" },
  { candidateSha: "c".repeat(40) },
  { inputSha256: "d".repeat(64) },
  { exitCode: 1 },
  { exitCode: null, signal: 15 },
  { timedOut: true },
  { stdout: result.stdout + "changed" },
  { stderr: "changed" },
  { stdoutTruncated: true },
  { stderrTruncated: true },
  { durationMs: 124 },
  { dirty: true },
  { headMoved: true },
];
for (const mutation of mutations)
  assert.equal(
    verifyRunnerCheckResult({ ...result, ...mutation }, signature, identity.verifierPublicKeyPem),
    false,
  );
const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
assert.equal(verifyRunnerCheckResult(result, signature, String(other)), false);
assert.equal(
  verifyRunnerCheckResult(result, signature.slice(0, -1), identity.verifierPublicKeyPem),
  false,
);
console.log(
  JSON.stringify({
    signatureVerified: true,
    canonicalBytesMatch: true,
    mutationsRejected: mutations.length,
    uid: process.getuid!(),
  }),
);
