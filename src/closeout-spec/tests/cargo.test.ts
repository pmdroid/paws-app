import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyParser } from "../policy/document";
import policySchema from "../schema/policy.schema.json" with { type: "json" };
import { cargoAdapter, runTestCheck, selectExecError, type CargoMetadata } from "./index";

const roots: string[] = [];
const budgets: number[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CRATES: Record<string, { deps: string[]; kind?: string; excluded?: true }> = {
  core: { deps: [] },
  app: { deps: ["core"] },
  cli: { deps: ["app"] },
  other: { deps: [] },
  macros: { deps: [], kind: "proc-macro" },
  sys: { deps: [], kind: "custom-build" },
  bridge: { deps: ["core"], excluded: true },
  tool: { deps: ["bridge"] },
};

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.com", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, path: string, text = "// x\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

function workspace(): { root: string; base: string; calls: string[][] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paws-cargo-select-")));
  roots.push(root);
  git(root, "init", "-b", "main");
  write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
  for (const name of Object.keys(CRATES)) {
    write(root, `crates/${name}/Cargo.toml`, `[package]\nname = "${name}"\n`);
    write(root, `crates/${name}/src/lib.rs`);
  }
  write(root, "crates/sys/build.rs");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD"), calls: [] };
}

function fakeMetadata(calls: string[][]): CargoMetadata {
  return async (cwd, args, _env, seconds) => {
    calls.push([realpathSync(cwd), ...args]);
    budgets.push(seconds);
    const id = (name: string) => `path+file://${name}#0.1.0`;
    const entries = Object.entries(CRATES);
    return JSON.stringify({
      workspace_members: entries.filter(([, crate]) => !crate.excluded).map(([name]) => id(name)),
      packages: entries.map(([name, crate]) => ({
        id: id(name),
        name,
        manifest_path: join(cwd, "crates", name, "Cargo.toml"),
        targets: [{ kind: ["lib"] }, ...(crate.kind ? [{ kind: [crate.kind] }] : [])],
      })),
      resolve: {
        nodes: entries.map(([name, crate]) => ({
          id: id(name),
          deps: crate.deps.map((dep) => ({ pkg: id(dep) })),
        })),
      },
    });
  };
}

async function check(
  runner: "cargo" | "nextest",
  changed: string[],
  run: (argv: string[]) => number = () => 0,
  max_selected?: number,
) {
  const { root, base, calls } = workspace();
  for (const path of changed) write(root, path, "// changed\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "head");
  const verb = runner === "cargo" ? ["cargo", "test"] : ["cargo", "nextest", "run"];
  const ran: string[][] = [];
  const result = await runTestCheck({
    item: {
      id: "test",
      kind: "command",
      gate: "beforePR",
      exec: [
        ...verb,
        "--locked",
        "--features=fast",
        "--target=x86_64-unknown-linux-gnu",
        "--",
        "-q",
      ],
      timeoutSeconds: 60,
      select: { runner, ...(max_selected ? { max_selected } : {}) },
    },
    cwd: root,
    base,
    head: git(root, "rev-parse", "HEAD"),
    env: { PATH: process.env.PATH ?? "" },
    reportRoot: root,
    adapter: cargoAdapter(runner, fakeMetadata(calls)),
    execute: async (invocation) => {
      ran.push(invocation.argv);
      return { code: run(invocation.argv), timedOut: false };
    },
  });
  return { result, ran, calls, root };
}

test("a library change selects it and every crate that depends on it, also through excluded packages", async () => {
  const { result, ran, calls, root } = await check("cargo", ["crates/core/src/parse.rs"]);
  expect(result.selection).toEqual({
    mode: "selected",
    targets: ["app", "cli", "core", "tool"],
    reasons: ["changed crates core and their dependents"],
  });
  expect(ran).toEqual([
    ["cargo", "test", "--locked", "--features=fast", "--target=x86_64-unknown-linux-gnu"].concat([
      "-p",
      "app",
      "-p",
      "cli",
      "-p",
      "core",
      "-p",
      "tool",
      "--",
      "-q",
    ]),
  ]);
  const args = ["metadata", "--format-version=1", "--locked", "--features=fast"];
  expect(calls.map((call) => call[0] === root)).toEqual([true, false]);
  expect(calls.map((call) => call.slice(1))).toEqual([
    [...args, "--filter-platform=x86_64-unknown-linux-gnu"],
    [...args, "--filter-platform=x86_64-unknown-linux-gnu"],
  ]);
  expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
  expect(budgets.slice(-2).every((seconds) => seconds >= 1 && seconds <= 60)).toBe(true);
});

test("build scripts, proc-macros, manifests, unowned files and max_selected force the full run", async () => {
  const reasons = async (changed: string[], max?: number) =>
    (await check("cargo", changed, () => 0, max)).result.selection;
  expect(await reasons(["crates/sys/build.rs"])).toEqual({
    mode: "full",
    reasons: ["crates/sys/build.rs changed"],
  });
  expect((await reasons(["crates/sys/src/lib.rs"])).reasons).toEqual(["sys has a build script"]);
  expect((await reasons(["crates/macros/src/lib.rs"])).reasons).toEqual(["macros is a proc-macro"]);
  expect((await reasons(["crates/other/Cargo.toml"])).reasons).toEqual([
    "crates/other/Cargo.toml changed",
  ]);
  expect((await reasons(["README.md"])).reasons).toEqual(["no workspace crate owns README.md"]);
  expect((await reasons(["crates/core/tests/it.rs"], 2)).reasons).toEqual([
    "4 crates are more than max_selected 2",
  ]);
  const full = await check("cargo", ["crates/sys/build.rs"]);
  expect(full.ran[0]).toEqual(
    ["cargo", "test", "--locked", "--features=fast"].concat([
      "--target=x86_64-unknown-linux-gnu",
      "--workspace",
      "--",
      "-q",
    ]),
  );
});

test("cargo reports its result from the exit status and says so", async () => {
  const passed = await check("cargo", ["crates/other/src/lib.rs"]);
  expect(passed.result).toMatchObject({ ok: true, failures: [] });
  expect(passed.result.note).toBe(
    "Ran crates other (changed crates other and their dependents). cargo test writes no test report; this result is its exit status.",
  );
  expect((await check("cargo", ["crates/other/src/lib.rs"], () => 101)).result.ok).toBe(false);
});

test("nextest writes JUnit through a tool profile and reports a failing test by crate and name", async () => {
  const failing = `<testsuites name="nextest-run"><testsuite name="other" tests="2" failures="1"><testcase name="tests::fine" classname="other"/><testcase name="tests::adds" classname="other"><failure type="test failure" message="thread 'tests::adds' panicked"/></testcase></testsuite></testsuites>`;
  const { result, ran } = await check("nextest", ["crates/other/benches/b.rs"], (argv) => {
    const config = argv.find((part) => part.startsWith("--tool-config-file=paws:"))!.slice(24);
    const path = JSON.parse(readFileSync(config, "utf8").split("path = ")[1]!) as string;
    writeFileSync(path, failing);
    return 100;
  });
  const config = ran[0]!.find((part) => part.startsWith("--tool-config-file="))!;
  expect(ran[0]).toEqual([
    ...["cargo", "nextest", "run", "--locked", "--features=fast"],
    ...["--target=x86_64-unknown-linux-gnu", "-p", "other", config, "--profile=paws:closeout"],
    ...["--", "-q"],
  ]);
  expect(result).toMatchObject({
    ok: false,
    failures: [
      { name: "other > tests::adds", message: "thread 'tests::adds' panicked", kind: "failed" },
    ],
  });
  const missing = await check("nextest", ["crates/other/src/lib.rs"], () => 2);
  expect(missing.result.problem).toEndWith(
    "is missing: cargo nextest wrote no JUnit report; it needs a nextest that accepts --tool-config-file and a tool profile",
  );
});

test("select refuses package selection and positional arguments in cargo and nextest exec", () => {
  expect(
    selectExecError("cargo", ["cargo", "test", "--release", "--", "--ignored"]),
  ).toBeUndefined();
  expect(selectExecError("nextest", ["cargo", "nextest", "run", "--no-fail-fast"])).toBeUndefined();
  for (const exec of [
    ["cargo", "test", "-p", "core"],
    ["cargo", "test", "--package=core"],
    ["cargo", "test", "-pcore"],
    ["cargo", "test", "--workspace"],
    ["cargo", "test", "parse"],
    ["cargo", "nextest", "run"],
  ]) {
    expect(selectExecError("cargo", exec)).toStartWith(
      'select runner cargo needs exec to start with "cargo", "test"',
    );
  }
  expect(selectExecError("nextest", ["cargo", "nextest", "run", "--profile=ci"])).toContain(
    "--profile",
  );
});

test("a runner parser from before select keeps a cargo policy and runs exec unselected", () => {
  const schema = structuredClone(policySchema);
  delete (schema.$defs.command.properties as Record<string, unknown>).select;
  const policy = `specVersion: "0.1"\nitems:\n  - id: test\n    kind: command\n    gate: beforePR\n    exec: ["cargo", "nextest", "run"]\n    timeoutSeconds: 60\n    select: { runner: nextest }\n`;
  const parsed = createPolicyParser(schema)(policy);
  expect(parsed).toMatchObject({ ok: true, unknownKeys: ["/items/0/select"] });
  if (parsed.ok) expect(parsed.document.items?.[0]).not.toHaveProperty("select");
});
