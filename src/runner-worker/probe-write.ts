import { journalCaught } from "../journal";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  RUNNER_PROBE_BYTES,
  RunnerProbeEntrySchema,
  type RunnerHelperResult,
} from "../runner-protocol";

const PROBES = ".agents/probes";

function probeTree(root: string, relative = "", tree = new Map<string, string>()) {
  for (const name of readdirSync(join(root, relative))) {
    const path = relative ? `${relative}/${name}` : name;
    const info = lstatSync(join(root, path), { bigint: true });
    if (path === PROBES) continue;
    if (path !== ".agents" || !info.isDirectory())
      tree.set(
        path,
        info.isDirectory() ? "dir" : `${info.mode}:${info.size}:${info.mtimeNs}:${info.ino}`,
      );
    if (info.isDirectory()) probeTree(root, path, tree);
  }
  return tree;
}

const gitEnv = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function gitOut(args: string[]): string {
  const run = spawnSync("git", args, { env: gitEnv, encoding: "utf8", timeout: 300_000 });
  if (run.status !== 0) throw new Error(`git ${args[0] === "-C" ? args[2] : args[0]} failed`);
  return run.stdout.trim();
}

export function checkoutProbe(mirror: { path: string; commit: string }, target: string) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  gitOut([
    "-c",
    `safe.directory=${mirror.path}`,
    "clone",
    "--quiet",
    "--no-hardlinks",
    "--",
    mirror.path,
    target,
  ]);
  const head = gitOut(["-C", target, "rev-parse", "--verify", "HEAD^{commit}"]);
  const main = gitOut(["-C", target, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  if (head !== main || main !== mirror.commit)
    throw new Error("The probe's checkout is not at the fetched origin/main commit");
  mkdirSync(join(target, PROBES), { recursive: true, mode: 0o700 });
  return target;
}

export function probeEntry(text: string) {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    journalCaught(error, "probe-write.probeEntry", null, "the reply may hold no JSON");
    return undefined;
  }
  const entry = RunnerProbeEntrySchema.safeParse(parsed);
  return entry.success ? entry.data : undefined;
}

export function probeSnapshot(root: string, path: string) {
  const info = lstatSync(join(root, path), { throwIfNoEntry: false });
  return {
    tree: probeTree(root),
    text: info?.isFile() ? readFileSync(join(root, path), "utf8") : "",
  };
}

export function collectProbe(
  root: string,
  path: string,
  { tree: before, text: previous }: ReturnType<typeof probeSnapshot>,
  reply: string,
): { probe?: NonNullable<RunnerHelperResult["probe"]>; error?: string } {
  const after = probeTree(root);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((entry) => before.get(entry) !== after.get(entry))
    .sort();
  if (changed.length)
    return {
      error: `The agent changed files outside ${PROBES}/: ${changed.slice(0, 10).join(", ")}`,
    };
  const file = join(root, path);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return { error: `The agent did not write ${path}` };
  if (!info.isFile() || realpathSync(dirname(file)) !== join(realpathSync(root), PROBES))
    return { error: `${path} is not a regular file in ${PROBES}` };
  if (info.size > RUNNER_PROBE_BYTES)
    return { error: `${path} is larger than ${RUNNER_PROBE_BYTES} bytes` };
  const text = readFileSync(file, "utf8");
  if (!text || text === previous) return { error: `The agent left ${path} empty or unchanged` };
  const entry = probeEntry(reply);
  if (!entry) return { error: "The agent did not propose a valid rules entry" };
  return { probe: { path, text, entry } };
}
