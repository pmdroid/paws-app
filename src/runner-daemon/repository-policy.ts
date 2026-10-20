import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, parse } from "node:path";
import { z } from "zod";

export const REPOSITORY_POLICY_PATH = "/etc/paws-runner/repository-policy.json";

const schema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  fence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  repositories: z
    .array(
      z
        .string()
        .max(256)
        .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    )
    .max(256),
});

export function readRepositoryPolicy(path: string, runnerGid: number) {
  if (!isAbsolute(path)) throw new Error("Repository policy requires an absolute path.");
  let parent = dirname(path);
  while (true) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error("Repository policy parents must be protected root directories.");
    if (parent === parse(parent).root) break;
    parent = dirname(parent);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== 0 ||
      info.gid !== runnerGid ||
      (info.mode & 0o7777) !== 0o640 ||
      info.size > 65536
    )
      throw new Error("Repository policy must be a protected root-owned file.");
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > 65536) throw new Error("Repository policy exceeds its size limit.");
    return schema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

export function createRepositoryPolicyReader(path: string, runnerGid: number) {
  let accepted: ReturnType<typeof readRepositoryPolicy> | undefined;
  return () => {
    const policy = readRepositoryPolicy(path, runnerGid);
    if (
      accepted &&
      (policy.fence < accepted.fence ||
        policy.revision < accepted.revision ||
        (policy.fence === accepted.fence && JSON.stringify(policy) !== JSON.stringify(accepted)))
    )
      throw new Error("Repository policy revision regressed.");
    accepted = policy;
    return policy.repositories;
  };
}
