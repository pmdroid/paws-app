import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { journalCaught } from "../journal";
import {
  RUNNER_PROBE_BYTES,
  RunnerProbeEntrySchema,
  type RunnerProbeResult,
} from "../runner-protocol";

type Git = (args: string[]) => Promise<string>;

export async function checkoutProbeWorktree(
  bundle: string,
  worktree: string,
  git: Git,
): Promise<string> {
  await git([
    "-c",
    "core.hooksPath=/dev/null",
    "clone",
    "-q",
    "--no-checkout",
    "--",
    bundle,
    worktree,
  ]);
  const fetched = (
    await git(["-C", worktree, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"])
  ).trim();
  await git(["-C", worktree, "config", "core.hooksPath", "/dev/null"]);
  await git(["-C", worktree, "checkout", "-q", "--detach", fetched]);
  await git(["-C", worktree, "remote", "remove", "origin"]);
  await git(["-C", worktree, "update-ref", "refs/remotes/origin/main", fetched]);
  await verifyProbeCheckout(worktree, fetched, git);
  return fetched;
}

export async function verifyProbeCheckout(
  worktree: string,
  fetched: string,
  git: Git,
): Promise<void> {
  const head = (await git(["-C", worktree, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const main = (
    await git(["-C", worktree, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"])
  ).trim();
  if (head !== fetched || main !== fetched)
    throw new Error("The probe checkout's HEAD is not the fetched origin/main");
  if ((await git(["-C", worktree, "status", "--porcelain", "--untracked-files=all"])).trim())
    throw new Error("The probe checkout is not clean");
}

export async function probeOutcome(input: {
  worktree: string;
  fetched: string;
  path: string;
  text: string;
  git: Git;
}): Promise<RunnerProbeResult> {
  const { worktree, fetched, path, git } = input;
  const head = (await git(["-C", worktree, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (head !== fetched) throw new Error("The probe turn moved HEAD off origin/main");
  const changed = (
    await git(["-C", worktree, "status", "--porcelain", "-z", "--untracked-files=all"])
  )
    .split("\0")
    .filter(Boolean);
  if (changed.some((line) => line !== `?? ${path}` && line !== ` M ${path}`))
    throw new Error(`The probe turn changed files other than ${path}`);
  const file = openSync(
    join(worktree, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size === 0 || info.size > RUNNER_PROBE_BYTES)
      throw new Error(`The probe turn wrote no usable ${path}`);
    bytes = Buffer.alloc(info.size);
    if (readSync(file, bytes, 0, info.size, 0) !== info.size)
      throw new Error(`The probe turn wrote no usable ${path}`);
  } finally {
    closeSync(file);
  }
  const entry = RunnerProbeEntrySchema.safeParse(replyJson(input.text));
  if (!entry.success) throw new Error("The probe turn proposed no valid rules entry");
  return { path, content: bytes.toString("base64"), entry: entry.data };
}

function replyJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body);
  } catch (error) {
    journalCaught(error, "runner-worker.probe.replyJson", null);
    return undefined;
  }
}
