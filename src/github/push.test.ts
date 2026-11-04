import { expect, test } from "bun:test";
import { pushBranch } from "./pulls";
import { GitCommandError, type GitExec } from "./types";

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

function publish(gitExec: GitExec) {
  return pushBranch({
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

test("a remote branch at another head stages and pushes leased on it", async () => {
  const { calls, gitExec } = recordingGit([OLDER]);
  expect(await publish(gitExec)).toEqual({ branch: "paws/ACME-7", head: HEAD });
  expect(calls.filter((args) => args.includes("ls-remote"))).toHaveLength(1);
  expect(ran(calls, "bundle")).toBe(true);
  expect(fetchedBundle(calls)).toBe(true);
  const push = calls.find((args) => args.includes("push"));
  expect(push).toContain(`--force-with-lease=${BRANCH}:${OLDER}`);
  expect(push).toContain(`HEAD:${BRANCH}`);
});

test("a missing remote branch stages and pushes without a lease", async () => {
  const { calls, gitExec } = recordingGit([""]);
  await publish(gitExec);
  expect(fetchedBundle(calls)).toBe(true);
  const push = calls.find((args) => args.includes("push"));
  expect(push?.some((arg) => arg.startsWith("--force-with-lease"))).toBe(false);
});

test("a failed remote read pushes as before", async () => {
  const failed = new GitCommandError(["ls-remote", URL], "fatal: Authentication failed");
  const { calls, gitExec } = recordingGit([failed, OLDER]);
  expect(await publish(gitExec)).toEqual({ branch: "paws/ACME-7", head: HEAD });
  expect(ran(calls, "bundle")).toBe(true);
  expect(fetchedBundle(calls)).toBe(true);
  expect(calls.find((args) => args.includes("push"))).toContain(
    `--force-with-lease=${BRANCH}:${OLDER}`,
  );
});
