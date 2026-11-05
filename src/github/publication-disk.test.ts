import { expect, test } from "bun:test";
import { isTransient } from "../core";
import { PUBLICATION_STAGING_FAILURE, publicationExec } from "./publication";
import { GitCommandError, type GitExec } from "./types";

function stagingFails(stderr: string): GitExec {
  return async (args) => {
    if (args.includes("bundle")) throw new GitCommandError(args, stderr);
    if (args.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
}

async function push(stderr: string): Promise<unknown> {
  const exec = publicationExec(stagingFails(stderr), undefined, null);
  return exec(["push", "/srv/remote.git", "HEAD:refs/heads/paws/item"], {
    cwd: "/srv/candidate",
    env: {},
  }).then(
    () => null,
    (error: unknown) => error,
  );
}

test.each([
  "fatal: sha1 file '<stdout>' write error. Out of diskspace error: pack-objects died",
  "fatal: unable to write file: No space left on device",
  "error: write failed: ENOSPC",
])("a full disk while staging is a transient HostDiskFullError: %s", async (stderr) => {
  const error = (await push(stderr)) as Error;
  expect(error.name).toBe("HostDiskFullError");
  expect(error.message).toStartWith("Paws's host is out of disk space (");
  expect(error.message).toContain(stderr);
  expect(isTransient(error)).toBe(true);
  expect(isTransient(new Error("push failed: wrapped", { cause: error }))).toBe(true);
});

test("another staging failure stays a PublicationStagingError and is not retried", async () => {
  const error = (await push("fatal: couldn't find remote ref HEAD")) as Error;
  expect(error.name).toBe("PublicationStagingError");
  expect(error).toBeInstanceOf(GitCommandError);
  expect((error as GitCommandError).stderr).toStartWith(PUBLICATION_STAGING_FAILURE);
  expect(isTransient(error)).toBe(false);
});
