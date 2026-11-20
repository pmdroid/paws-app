import { expect, test } from "bun:test";
import { pushBranch } from "./pulls";
import { BranchMovedError, GitCommandError, type GitExec } from "./types";

const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const URL = "https://github.com/acme/widgets.git";
const BRANCH = "refs/heads/paws/ACME-7";

function recordingGit(remotes: Array<string | Error>): { calls: string[][]; gitExec: GitExec } {
  const calls: string[][] = [];
  const gitExec: GitExec = async (args) => {
    calls.push(args);
    if (args.includes("ls-remote")) {
      const next = remotes.shift() ?? "";
      if (next instanceof Error) throw next;
      return { stdout: next === "" ? "" : `${next}\t${BRANCH}\n`, stderr: "" };
    }
    if (args.includes("rev-parse")) return { stdout: `${HEAD}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { calls, gitExec };
}

function publish(gitExec: GitExec, expected: string | null = OLDER) {
  return pushBranch({
    expected,
    worktree: "/tmp/acme-widgets",
    issue: "ACME-7",
    owner: "acme",
    repo: "widgets",
    remoteUrl: URL,
    tokenProvider: { mode: "token", tokenFor: async () => "acme-token" },
    gitExec,
  });
}

const ran = (calls: string[][], command: string) => calls.some((args) => args.includes(command));
const fetchedBundle = (calls: string[][]) =>
  calls.some((args) => args.includes("fetch") && args.some((arg) => arg.endsWith(".bundle")));

test("a remote branch already at the head skips staging and the push", async () => {
  const { calls, gitExec } = recordingGit([HEAD]);
  expect(await publish(gitExec)).toEqual({ branch: "paws/ACME-7", head: HEAD });
  expect(calls.filter((args) => args.includes("ls-remote"))).toHaveLength(1);
  expect(ran(calls, "bundle")).toBe(false);
  expect(fetchedBundle(calls)).toBe(false);
  expect(ran(calls, "push")).toBe(false);
});

test("a remote branch at the expected head stages and pushes leased on it", async () => {
  const { calls, gitExec } = recordingGit([OLDER]);
  expect(await publish(gitExec)).toEqual({ branch: "paws/ACME-7", head: HEAD });
  expect(calls.filter((args) => args.includes("ls-remote"))).toHaveLength(1);
  expect(fetchedBundle(calls)).toBe(true);
  const push = calls.find((args) => args.includes("push"));
  expect(push).toContain(`--force-with-lease=${BRANCH}:${OLDER}`);
  expect(push).toContain(`HEAD:${BRANCH}`);
});

test("a remote branch at another head than expected fails without pushing", async () => {
  const theirs = "c".repeat(40);
  const { calls, gitExec } = recordingGit([theirs]);
  const error = await publish(gitExec).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BranchMovedError);
  expect((error as BranchMovedError).tip).toBe(theirs);
  expect(ran(calls, "push")).toBe(false);
});

test("a missing remote branch pushes leased on its absence", async () => {
  const { calls, gitExec } = recordingGit([""]);
  await publish(gitExec, null);
  expect(fetchedBundle(calls)).toBe(true);
  expect(calls.find((args) => args.includes("push"))).toContain(`--force-with-lease=${BRANCH}:`);
});

test("a failed remote read still pushes leased on the expected head", async () => {
  const failed = new GitCommandError(["ls-remote", URL], "fatal: Authentication failed");
  const { calls, gitExec } = recordingGit([failed]);
  expect(await publish(gitExec)).toEqual({ branch: "paws/ACME-7", head: HEAD });
  expect(calls.find((args) => args.includes("push"))).toContain(
    `--force-with-lease=${BRANCH}:${OLDER}`,
  );
});

test("a lease Git refuses as stale reads the tip and fails without a second push", async () => {
  const theirs = "c".repeat(40);
  const calls: string[][] = [];
  const remotes = [OLDER, theirs];
  const gitExec: GitExec = async (args) => {
    calls.push(args);
    if (args.includes("ls-remote"))
      return { stdout: `${remotes.shift()}\t${BRANCH}\n`, stderr: "" };
    if (args.includes("rev-parse")) return { stdout: `${HEAD}\n`, stderr: "" };
    if (args.includes("push") && args.some((arg) => arg.startsWith("--force-with-lease")))
      throw new GitCommandError(args, " ! [rejected] HEAD -> paws/ACME-7 (stale info)\n");
    return { stdout: "", stderr: "" };
  };
  const error = await publish(gitExec).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BranchMovedError);
  expect((error as BranchMovedError).tip).toBe(theirs);
  expect(calls.filter((args) => args.includes("push"))).toHaveLength(1);
});
