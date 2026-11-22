import { realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { anyPathMatches } from "../policy/paths";
import { git, spawnArgv } from "../run/exec";
import type { TestAdapter, TestContext, TestPlan } from "./types";

type CargoRunner = "cargo" | "nextest";

export type CargoMetadata = (
  cwd: string,
  args: string[],
  env: Record<string, string>,
  seconds: number,
) => Promise<string>;

type Crate = { name: string; dir: string; special?: string; dependents: Set<string> };

const VERBS: Record<CargoRunner, string[]> = {
  cargo: ["cargo", "test"],
  nextest: ["cargo", "nextest", "run"],
};
const PACKAGE = /^(-p|--package|--workspace|--all|--exclude)(=|$)|^-p./;
const PROFILE = /^(-P|--profile)(=|$)|^-P./;
const METADATA =
  /^(--features|-F|--all-features|--no-default-features|--manifest-path|--locked|--offline|--frozen)(=|$)|^-F./;
const PROFILE_NAME = "paws:closeout";
const METADATA_SECONDS = 120;
const HOOKS_OFF = ["-c", "core.hooksPath=/dev/null"];
const METADATA_BYTES = 256 * 1024 * 1024;

export function cargoExecError(runner: CargoRunner, exec: readonly string[]): string | undefined {
  const verb = VERBS[runner];
  const { flags } = split(exec, verb.length);
  const ok =
    verb.every((part, index) => exec[index] === part) &&
    flags.every(
      (flag) =>
        flag.startsWith("-") &&
        !PACKAGE.test(flag) &&
        !(runner === "nextest" && PROFILE.test(flag)),
    );
  if (ok) return undefined;
  const words = verb.map((part) => `"${part}"`).join(", ");
  const profile = runner === "nextest" ? ", --profile" : "";
  return `select runner ${runner} needs exec to start with ${words} and pass only flags before --, as --flag=value, without -p, --package, --workspace${profile}`;
}

export function cargoAdapter(
  runner: CargoRunner,
  metadata: CargoMetadata = cargoMetadata,
): TestAdapter {
  const full = (context: TestContext, reason: string) =>
    planFor(runner, context, undefined, [reason]);
  return {
    full: (context) => full(context, `the ${runner} runner ran every crate`),
    plan: async (context) => {
      const changes = await context.changes();
      const paths = changes.flatMap((change) =>
        change.oldPath === undefined ? [change.path] : [change.path, change.oldPath],
      );
      const config = paths.find(isCargoConfig);
      if (config !== undefined) return full(context, `${config} changed`);
      const fullOn = paths.find((path) =>
        anyPathMatches(context.item.select.full_on ?? [], [path]),
      );
      if (fullOn !== undefined) return full(context, `${fullOn} matches full_on`);
      const args = metadataArgs(context.item.exec);
      const head = await graph(context, context.cwd, args, metadata, "head");
      const base = await atBase(context, (cwd) => graph(context, cwd, args, metadata, "base"));
      const changed = new Set<string>();
      for (const path of paths) {
        const owners = [owner(head, path), owner(base, path)].filter(
          (crate) => crate !== undefined,
        );
        if (owners.length === 0) return full(context, `no workspace crate owns ${path}`);
        for (const crate of owners) {
          if (crate.special) return full(context, `${crate.name} ${crate.special}`);
          changed.add(crate.name);
        }
      }
      const selected = new Set<string>();
      const visit = (name: string) => {
        if (selected.has(name)) return;
        selected.add(name);
        for (const crates of [head, base]) {
          for (const dependent of crates.get(name)?.dependents ?? []) visit(dependent);
        }
      };
      for (const name of changed) visit(name);
      const targets = [...new Set([...selected, ...(context.item.select.always ?? [])])].sort();
      if (targets.length === 0) return full(context, "no workspace crate changed");
      const max = context.item.select.max_selected;
      if (max !== undefined && targets.length > max) {
        return full(context, `${targets.length} crates are more than max_selected ${max}`);
      }
      return planFor(runner, context, targets, [
        `changed crates ${[...changed].sort().join(", ") || "none"} and their dependents`,
      ]);
    },
  };
}

function planFor(
  runner: CargoRunner,
  context: TestContext,
  targets: string[] | undefined,
  reasons: string[],
): TestPlan {
  const { flags, rest } = split(context.item.exec, 0);
  const packages = targets ? targets.flatMap((name) => ["-p", name]) : ["--workspace"];
  const ran = targets ? `Ran crates ${targets.join(", ")}` : "Ran every crate";
  const selection = targets
    ? { mode: "selected" as const, targets, reasons }
    : { mode: "full" as const, reasons };
  if (runner === "cargo") {
    return {
      selection,
      invocations: [{ cwd: context.cwd, argv: [...flags, ...packages, ...rest] }],
      report: { kind: "none" },
      note: `${ran} (${reasons.join("; ")}). cargo test writes no test report; this result is its exit status.`,
    };
  }
  const junit = join(context.reportDir, "junit.xml");
  const config = join(context.reportDir, "nextest.toml");
  writeFileSync(config, `[profile."${PROFILE_NAME}".junit]\npath = ${JSON.stringify(junit)}\n`);
  const report = [`--tool-config-file=paws:${config}`, `--profile=${PROFILE_NAME}`];
  return {
    selection,
    invocations: [{ cwd: context.cwd, argv: [...flags, ...packages, ...report, ...rest] }],
    report: {
      kind: "junit",
      paths: [junit],
      missing:
        "cargo nextest wrote no JUnit report; it needs a nextest that accepts --tool-config-file and a tool profile",
    },
    note: `${ran} (${reasons.join("; ")}).`,
  };
}

function split(exec: readonly string[], from: number): { flags: string[]; rest: string[] } {
  const cut = exec.indexOf("--");
  const end = cut < 0 ? exec.length : cut;
  return { flags: exec.slice(from, end), rest: exec.slice(end) };
}

function isCargoConfig(path: string): boolean {
  const name = basename(path);
  return (
    ["Cargo.toml", "Cargo.lock", "build.rs"].includes(name) ||
    name.startsWith("rust-toolchain") ||
    /(^|\/)\.cargo\/config(\.toml)?$/.test(path)
  );
}

function metadataArgs(exec: readonly string[]): string[] {
  const args = ["metadata", "--format-version=1"];
  for (const flag of split(exec, 0).flags) {
    if (METADATA.test(flag)) args.push(flag);
    else if (/^--target=/.test(flag)) args.push(`--filter-platform=${flag.slice(9)}`);
  }
  return args;
}

async function atBase<T>(context: TestContext, read: (cwd: string) => Promise<T>): Promise<T> {
  const dir = join(context.reportDir, "base");
  const added = await git(
    context.cwd,
    [...HOOKS_OFF, "worktree", "add", "--detach", "--quiet", dir, context.base],
    context.env,
  );
  if (!added.ok) throw new Error(`git worktree add at base failed`);
  try {
    return await read(dir);
  } finally {
    await git(context.cwd, [...HOOKS_OFF, "worktree", "remove", "--force", dir], context.env);
  }
}

type Package = { id: string; name: string; manifest_path: string; targets: { kind: string[] }[] };
type Resolved = {
  packages: Package[];
  workspace_members: string[];
  resolve: { nodes: { id: string; deps: { pkg: string }[] }[] } | null;
};

async function graph(
  context: TestContext,
  cwd: string,
  args: string[],
  metadata: CargoMetadata,
  at: string,
): Promise<Map<string, Crate>> {
  const seconds = Math.min(METADATA_SECONDS, Math.floor((context.deadline - Date.now()) / 1000));
  if (seconds < 1) throw new Error(`no time left for cargo metadata at ${at}`);
  let parsed: Resolved;
  try {
    parsed = JSON.parse(await metadata(cwd, args, context.env, seconds)) as Resolved;
  } catch (error) {
    throw new Error(`cargo metadata at ${at} failed: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!parsed.resolve) throw new Error(`cargo metadata at ${at} has no resolve graph`);
  const root = realpathSync(cwd);
  const members = new Set(parsed.workspace_members);
  const byId = new Map<string, Crate>();
  for (const pkg of parsed.packages.filter((entry) => members.has(entry.id))) {
    const kinds = pkg.targets.flatMap((target) => target.kind);
    const special = kinds.includes("proc-macro")
      ? "is a proc-macro"
      : kinds.includes("custom-build")
        ? "has a build script"
        : undefined;
    const dir = relative(root, dirname(pkg.manifest_path)).split("\\").join("/");
    byId.set(pkg.id, {
      name: pkg.name,
      dir,
      dependents: new Set(),
      ...(special ? { special } : {}),
    });
  }
  const reverse = new Map<string, string[]>();
  for (const node of parsed.resolve.nodes) {
    for (const dep of node.deps) reverse.set(dep.pkg, [...(reverse.get(dep.pkg) ?? []), node.id]);
  }
  for (const [id, crate] of byId) {
    const seen = new Set([id]);
    const queue = [id];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const dependent of reverse.get(next) ?? []) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        queue.push(dependent);
        const member = byId.get(dependent);
        if (member) crate.dependents.add(member.name);
      }
    }
  }
  return new Map([...byId.values()].map((crate) => [crate.name, crate]));
}

function owner(crates: Map<string, Crate>, path: string): Crate | undefined {
  let found: Crate | undefined;
  for (const crate of crates.values()) {
    const owns = crate.dir === "" || path === crate.dir || path.startsWith(`${crate.dir}/`);
    if (owns && !crate.dir.startsWith("..") && crate.dir.length >= (found?.dir.length ?? -1)) {
      found = crate;
    }
  }
  return found;
}

const cargoMetadata: CargoMetadata = async (cwd, args, env, seconds) => {
  const ran = await spawnArgv(["cargo", ...args], cwd, env, seconds, undefined, METADATA_BYTES);
  if (ran.started && !ran.timedOut && !ran.truncated && ran.exitCode === 0) return ran.stdout;
  const why = ran.timedOut
    ? "timed out"
    : ran.truncated
      ? "output too large"
      : `exit ${ran.exitCode}`;
  const stderr = ran.stderr.trim().split("\n").at(-1) ?? "";
  throw new Error(`${why}${stderr ? `: ${stderr}` : ""}`);
};
