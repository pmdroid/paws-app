import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goExecError, parseGoJson, runTestCheck } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const M = "example.com/m";

const FILES: Record<string, string> = {
  "go.mod": "module example.com/m\n\ngo 1.22\n",
  "a/a.go": "package a\n\nfunc One() int { return 1 }\n",
  "a/a_test.go": "package a\n",
  "a/testdata/in.txt": "one\n",
  "b/b.go": 'package b\n\nimport "example.com/m/a"\n\nfunc Two() int { return a.One() * 2 }\n',
  "b/b_test.go": "package b\n",
  "c/c.go": 'package c\n\nimport "example.com/m/b"\n\nfunc Four() int { return b.Two() * 2 }\n',
  "c/c_test.go": "package c\n",
  "d/d.go": "package d\n",
  "d/d_test.go": "package d\n",
  "e/e.go": 'package main\n\nimport _ "example.com/m/a"\n',
  "e/sub/data.json": "{}\n",
  "e/sub/sub.go": "package sub\n",
  "e/sub/asm_amd64.s": "TEXT ·f(SB),0,$0\n",
};

function listing(): string {
  const pkg = (name: string, imports: string[]) => [
    {
      ImportPath: `${M}/${name}`,
      Name: name,
      Dir: `@DIR@/${name}`,
      GoFiles: [`${name}.go`],
      TestGoFiles: [`${name}_test.go`],
      Deps: imports,
    },
    {
      ImportPath: `${M}/${name} [${M}/${name}.test]`,
      Name: name,
      Dir: `@DIR@/${name}`,
      GoFiles: [`${name}.go`],
    },
    {
      ImportPath: `${M}/${name}.test`,
      Name: "main",
      Dir: `@DIR@/${name}`,
      Deps: [...imports, `${M}/${name} [${M}/${name}.test]`, "testing"],
    },
  ];
  const records = [
    { ImportPath: "testing", Name: "testing", Dir: "/usr/lib/go/src/testing", Standard: true },
    ...pkg("a", []),
    ...pkg("b", [`${M}/a`]),
    ...pkg("c", [`${M}/a`, `${M}/b`]),
    ...pkg("d", []),
    {
      ImportPath: `${M}/e`,
      Name: "main",
      Dir: "@DIR@/e",
      GoFiles: ["e.go"],
      EmbedFiles: ["sub/data.json"],
      Deps: [`${M}/a`],
    },
    {
      ImportPath: `${M}/e/sub`,
      Name: "sub",
      Dir: "@DIR@/e/sub",
      GoFiles: ["sub.go"],
      SFiles: ["asm_amd64.s"],
      EmbedFiles: ["data.json"],
    },
  ];
  return records.map((record) => `${JSON.stringify(record, null, "\t")}\n`).join("");
}

const FAKE_GO = `#!/bin/sh
verb=$1
printf '%s\\n' "$@" > "$FAKE/$verb-args"
if [ "$verb" = list ]; then sed "s#@DIR@#$PWD#g" "$FAKE/list.json"; exit 0; fi
cat "$FAKE/test.json"
exit "$(cat "$FAKE/test.code")"
`;

function run(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(root: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  run(root, ["add", "."]);
  run(root, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "change"]);
  return run(root, ["rev-parse", "HEAD"]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-go-select-"));
  roots.push(root);
  const repo = join(root, "repo");
  const fake = join(root, "fake");
  mkdirSync(repo);
  mkdirSync(join(fake, "bin"), { recursive: true });
  writeFileSync(join(fake, "bin", "go"), FAKE_GO);
  chmodSync(join(fake, "bin", "go"), 0o755);
  writeFileSync(join(fake, "list.json"), listing());
  run(repo, ["init", "-q", "-b", "main"]);
  commit(repo, FILES);
  const env = { PATH: `${join(fake, "bin")}:${process.env.PATH}`, FAKE: fake, HOME: root };
  return {
    repo,
    fake,
    async check(
      change: Record<string, string>,
      stream = "",
      code = 0,
      exec = ["go", "test", "-tags=x", "-count=1", "./..."],
    ) {
      const base = run(repo, ["rev-parse", "HEAD"]);
      const head = commit(repo, change);
      writeFileSync(join(fake, "test.json"), stream);
      writeFileSync(join(fake, "test.code"), String(code));
      return runTestCheck({
        item: {
          id: "test",
          kind: "command",
          gate: "beforePR",
          exec,
          timeoutSeconds: 60,
          select: { runner: "go" },
        },
        cwd: repo,
        base,
        head,
        env,
        reportRoot: root,
        execute: async ({ cwd, argv }) => {
          const ran = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf8" });
          return { code: ran.status ?? 1, timedOut: false, stdout: ran.stdout };
        },
      });
    },
    args: (verb: string) =>
      readFileSync(join(fake, `${verb}-args`), "utf8")
        .trim()
        .split("\n"),
  };
}

const event = (fields: Record<string, string>) => `${JSON.stringify(fields)}\n`;
const passing = (pkg: string) =>
  event({ Action: "run", Package: `${M}/${pkg}`, Test: "TestOk" }) +
  event({ Action: "pass", Package: `${M}/${pkg}`, Test: "TestOk" }) +
  event({ Action: "pass", Package: `${M}/${pkg}` });

test("a changed package selects it and every package that imports it, directly or not", async () => {
  const go = fixture();
  const result = await go.check(
    { "a/a.go": "package a\n\nfunc One() int { return 2 }\n" },
    passing("a"),
  );
  expect(result.selection).toEqual({
    mode: "selected",
    targets: [`${M}/a`, `${M}/b`, `${M}/c`, `${M}/e`],
    reasons: [`${M}/a changed`],
  });
  expect(result.ok).toBe(true);
  expect(result.results[0]?.stdout).toContain('"Action":"pass"');
  expect(go.args("test")).toEqual([
    "test",
    "-json",
    "-tags=x",
    "-count=1",
    `${M}/a`,
    `${M}/b`,
    `${M}/c`,
    `${M}/e`,
  ]);
  expect(go.args("list")).toEqual([
    "list",
    "-deps",
    "-test",
    expect.stringMatching(/^-json=ImportPath,/),
    "-tags=x",
    "./...",
  ]);
  expect(run(go.repo, ["worktree", "list"]).split("\n")).toHaveLength(1);
});

test("a testdata change selects its package and a go.mod or unowned change runs every package", async () => {
  const go = fixture();
  const data = await go.check({ "a/testdata/in.txt": "two\n" }, passing("a"));
  expect(data.selection.mode === "selected" && data.selection.targets).toContain(`${M}/a`);
  expect(data.selection.mode === "selected" && data.selection.targets).not.toContain(`${M}/d`);
  const mod = await go.check({ "go.mod": "module example.com/m\n\ngo 1.23\n" }, passing("a"));
  expect(mod.selection).toEqual({ mode: "full", reasons: ["go.mod changed"] });
  expect(go.args("test")).toEqual(["test", "-json", "-tags=x", "-count=1", "./..."]);
  const readme = await go.check({ "README.md": "hi\n" }, passing("a"));
  expect(readme.selection).toEqual({ mode: "full", reasons: ["no package owns README.md"] });
  const generated = await go.check(
    { "d/gen.go": "// Code generated by x. DO NOT EDIT.\n\npackage d\n" },
    passing("d"),
  );
  expect(generated.selection).toEqual({ mode: "full", reasons: ["d/gen.go is generated"] });
  const asm = await go.check(
    { "e/sub/asm_amd64.s": "// Code generated by asmgen. DO NOT EDIT.\nTEXT ·f(SB),0,$0\n" },
    passing("d"),
  );
  expect(asm.selection).toEqual({ mode: "full", reasons: ["e/sub/asm_amd64.s is generated"] });
  const shared = await go.check({ "e/sub/data.json": "[]\n" }, passing("d"));
  expect(shared.selection).toMatchObject({ mode: "selected", targets: [`${M}/e`, `${M}/e/sub`] });
  const big = await go.check({ "a/testdata/big.txt": "x".repeat(300 * 1024) }, passing("a"));
  expect(big.selection).toEqual({
    mode: "full",
    reasons: ["could not read a/testdata/big.txt at head"],
  });
  await go.check({ "d/d.go": "package d\n\nvar X = 1\n" }, passing("d"), 0, [
    "go",
    "test",
    "-compiler=gc",
    "./...",
  ]);
  expect(go.args("list").slice(-2)).toEqual(["-compiler=gc", "./..."]);
});

test("a failing test is reported by package and test name", async () => {
  const go = fixture();
  const stream =
    passing("c") +
    event({ Action: "run", Package: `${M}/b`, Test: "TestTwo" }) +
    event({ Action: "output", Package: `${M}/b`, Test: "TestTwo", Output: "=== RUN   TestTwo\n" }) +
    event({
      Action: "output",
      Package: `${M}/b`,
      Test: "TestTwo",
      Output: "    b_test.go:8: got 2, want 3\n",
    }) +
    event({
      Action: "output",
      Package: `${M}/b`,
      Test: "TestTwo",
      Output: "--- FAIL: TestTwo (0.00s)\n",
    }) +
    event({ Action: "fail", Package: `${M}/b`, Test: "TestTwo" }) +
    event({ Action: "fail", Package: `${M}/b` });
  const result = await go.check({ "b/b.go": "package b\n" }, stream, 1);
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual([
    { file: `${M}/b`, name: "TestTwo", message: "b_test.go:8: got 2, want 3", kind: "failed" },
  ]);
});

test("a build error fails the check even when go test exits 0", async () => {
  const go = fixture();
  const stream =
    event({
      ImportPath: `${M}/d [${M}/d.test]`,
      Action: "build-output",
      Output: "d/d.go:3:1: syntax error\n",
    }) +
    event({ ImportPath: `${M}/d [${M}/d.test]`, Action: "build-fail" }) +
    event({ Action: "start", Package: `${M}/d` }) +
    event({
      Action: "output",
      Package: `${M}/d`,
      Output: "FAIL\texample.com/m/d [build failed]\n",
    }) +
    event({ Action: "fail", Package: `${M}/d`, FailedBuild: `${M}/d [${M}/d.test]` });
  const result = await go.check({ "d/d.go": "package d\nfunc {\n" }, stream, 0);
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual([
    { file: `${M}/d`, message: "d/d.go:3:1: syntax error", kind: "error" },
  ]);
});

test("the go-json reader fails a package without a final action and a stream that ends early", () => {
  const started =
    event({ Action: "start", Package: "p" }) +
    event({ Action: "run", Package: "p", Test: "TestA" });
  expect(parseGoJson(started)).toMatchObject({
    ok: true,
    cases: 0,
    failures: [{ file: "p", kind: "skipped-crash" }],
  });
  expect(parseGoJson(`${started}{"Action":"pa`)).toEqual({ ok: false, message: "ends early" });
  const nested =
    event({ Action: "fail", Package: "p", Test: "TestA/sub" }) +
    event({ Action: "fail", Package: "p", Test: "TestA" }) +
    event({ Action: "fail", Package: "p" }) +
    event({ Action: "skip", Package: "q" });
  expect(parseGoJson(nested)).toEqual({
    ok: true,
    cases: 2,
    failures: [{ file: "p", name: "TestA/sub", message: "failed", kind: "failed" }],
  });
  expect(goExecError(["go", "test", "-race", "./..."])).toBeUndefined();
  for (const exec of [
    ["go", "test", "./pkg/..."],
    ["go", "test", "-run", "TestA", "./..."],
    ["go", "vet", "./..."],
    ["go", "test", "-args", "./..."],
  ]) {
    expect(goExecError(exec)).toContain("exactly one package pattern");
  }
});
