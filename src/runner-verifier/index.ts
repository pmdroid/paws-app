import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  readRunnerCheckResult,
  RunnerCheckResultSchema,
  type RunnerCheckInput,
  type RunnerCheckPaths,
  type RunnerCheckResult,
} from "../runner-check";

function publicKey(value: string) {
  if (Buffer.byteLength(value) > 256) throw new Error("Invalid verifier public key");
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "pem", type: "spki" }) !== value)
    throw new Error("Invalid verifier public key");
  const der = Buffer.from(key.export({ format: "der", type: "spki" }));
  return { key, der };
}

export function runnerVerifierFingerprint(verifierPublicKeyPem: string): string {
  return createHash("sha256").update(publicKey(verifierPublicKeyPem).der).digest("hex");
}

export function runnerCheckResultSigningBytes(result: RunnerCheckResult): Buffer {
  const parsed = RunnerCheckResultSchema.parse(result);
  if (!Number.isSafeInteger(parsed.durationMs)) throw new Error("Invalid signed duration");
  for (const output of [parsed.stdout, parsed.stderr]) {
    if (Buffer.from(output, "utf8").toString("utf8") !== output)
      throw new Error("Invalid signed output");
  }
  const canonical = Object.fromEntries(
    Object.entries(parsed).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return Buffer.concat([
    Buffer.from("paws.runner-check-result.v1\0", "utf8"),
    Buffer.from(JSON.stringify(canonical), "utf8"),
  ]);
}

export function verifyRunnerCheckResult(
  result: RunnerCheckResult,
  signatureBase64: string,
  verifierPublicKeyPem: string,
): boolean {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) return false;
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.toString("base64") !== signatureBase64) return false;
    return verify(
      null,
      runnerCheckResultSigningBytes(result),
      publicKey(verifierPublicKeyPem).key,
      signature,
    );
  } catch {
    return false;
  }
}

export function readRunnerCheckSignature(
  paths: RunnerCheckPaths,
  input: RunnerCheckInput,
): string | null {
  if (!readRunnerCheckResult(paths, input)) return null;
  if (!paths.resultRoot.startsWith("/")) throw new Error("Invalid verifier result path");
  let directory = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  let file: number | undefined;
  try {
    for (const part of paths.resultRoot.split("/").filter(Boolean)) {
      if (part === "." || part === "..") throw new Error("Invalid verifier result path");
      const next = openSync(
        `/proc/self/fd/${directory}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(directory);
      directory = next;
    }
    for (const part of ["", input.executionId]) {
      if (part) {
        const next = openSync(
          `/proc/self/fd/${directory}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        closeSync(directory);
        directory = next;
      }
      const info = fstatSync(directory);
      if (info.uid !== 0 || info.gid !== paths.runnerGid || (info.mode & 0o7777) !== 0o750)
        throw new Error("Unsafe verifier result directory");
    }
    file = openSync(
      `/proc/self/fd/${directory}/verifier-signature`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.gid !== paths.runnerGid ||
      (info.mode & 0o7777) !== 0o640 ||
      info.nlink !== 1 ||
      info.size !== 88
    )
      throw new Error("Unsafe verifier result signature");
    const content = Buffer.alloc(89);
    const count = readSync(file, content, 0, content.length, 0);
    const signature = content.subarray(0, count).toString("utf8");
    if (
      count !== 88 ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
      Buffer.from(signature, "base64").toString("base64") !== signature
    )
      throw new Error("Invalid verifier result signature");
    return signature;
  } finally {
    if (file !== undefined) closeSync(file);
    closeSync(directory);
  }
}
