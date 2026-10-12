import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { RunnerCheckResult } from "../../src/runner-check";
import {
  runnerCheckResultSigningBytes,
  runnerVerifierFingerprint,
  verifyRunnerCheckResult,
} from "../../src/runner-verifier";

export function probeRunnerVerifier(
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  const keys = generateKeyPairSync("ed25519");
  const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const result: RunnerCheckResult = {
    format: 1,
    executionId: "01K00000000000000000000001",
    verificationAttemptId: "01K00000000000000000000000",
    candidateSha: "a".repeat(40),
    inputSha256: "b".repeat(64),
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "verified output\n犬\0",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 12,
    dirty: false,
    headMoved: false,
  };
  const signature = sign(null, runnerCheckResultSigningBytes(result), keys.privateKey).toString(
    "base64",
  );
  assert(verifyRunnerCheckResult(result, signature, pem));
  const reordered = Object.fromEntries(Object.entries(result).reverse()) as RunnerCheckResult;
  assert(verifyRunnerCheckResult(reordered, signature, pem));
  observe("signed runner evidence verifies independently of object insertion order", true, {
    bytes: Buffer.from(signature, "base64").length,
    reordered: true,
  });
  const mutations = [
    { executionId: "01K00000000000000000000002" },
    { verificationAttemptId: "01K00000000000000000000002" },
    { candidateSha: "c".repeat(40) },
    { inputSha256: "d".repeat(64) },
    { exitCode: 1 },
    { exitCode: null, signal: 15 },
    { timedOut: true },
    { stdout: "forged" },
    { stderr: "forged" },
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { durationMs: 13 },
    { dirty: true },
    { headMoved: true },
  ];
  for (const mutation of mutations)
    assert.equal(verifyRunnerCheckResult({ ...result, ...mutation }, signature, pem), false);
  observe(
    "runner evidence signatures bind candidates, attempts, status and every output field",
    true,
    {
      rejectedMutations: mutations.length,
    },
  );
  const other = generateKeyPairSync("ed25519");
  assert.equal(
    verifyRunnerCheckResult(
      result,
      signature,
      other.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ),
    false,
  );
  const wrongDomain = sign(null, Buffer.from(JSON.stringify(result)), keys.privateKey).toString(
    "base64",
  );
  assert.equal(verifyRunnerCheckResult(result, wrongDomain, pem), false);
  observe("unapproved witness keys and signatures from another domain are rejected", true, {
    wrongKeyRejected: true,
    missingDomainRejected: true,
  });
  for (const malformed of [signature.slice(0, -1), signature + "\n", "A".repeat(88), ""])
    assert.equal(verifyRunnerCheckResult(result, malformed, pem), false);
  for (const malformed of [
    { ...result, durationMs: 1.5 },
    { ...result, durationMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...result, stdout: "\ud800" },
    { ...result, stderr: "\udfff" },
    { ...result, unexpected: true },
  ]) {
    assert.throws(() => runnerCheckResultSigningBytes(malformed));
    assert.equal(verifyRunnerCheckResult(malformed, signature, pem), false);
  }
  observe("ambiguous evidence encodings fail before witness signatures are accepted", true, {
    malformedSignatures: 4,
    malformedResults: 5,
  });
  const expected = createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  assert.equal(runnerVerifierFingerprint(pem), expected);
  for (const invalid of [pem + "\n", pem.replace(/\n/g, "\r\n"), "x".repeat(257)])
    assert.throws(() => runnerVerifierFingerprint(invalid));
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecPem = ec.publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => runnerVerifierFingerprint(ecPem));
  assert.equal(verifyRunnerCheckResult(result, signature, ecPem), false);
  observe("witness fingerprints bind canonical Ed25519 public key bytes", true, {
    fingerprint: expected,
    nonCanonicalAndWrongAlgorithmRejected: true,
  });
}
