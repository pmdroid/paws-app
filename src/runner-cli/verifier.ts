import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { runnerVerifierFingerprint } from "../runner-verifier";

export function installedVerifierPublicKey(): string {
  const fd = openSync(
    "/var/lib/paws-check-verifier-public.pem",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.gid !== 0 ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== 0o644 ||
      info.size > 256
    )
      throw new Error("Verifier public identity must be a protected root-owned file");
    const bytes = Buffer.alloc(257);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 256) throw new Error("Verifier public identity exceeds its size limit");
    const pem = bytes.subarray(0, count).toString("utf8");
    runnerVerifierFingerprint(pem);
    return pem;
  } finally {
    closeSync(fd);
  }
}
