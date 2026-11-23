import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyParser } from "../policy/document";
import policySchema from "../schema/policy.schema.json" with { type: "json" };
import type { TestSelect } from "../types";
import { snapshotAt, testChanges } from "./git";
import { pytestTestAdapter } from "./pytest";
import type { TestPlan } from "./types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  "pyproject.toml": '[project]\nname = "app"\n',
  "src/app/__init__.py": "",
  "src/app/core.py": "def add(a, b):\n    return a + b\n",
  "src/app/util.py": "from .core import add\n\ndef twice(a):\n    return add(a, a)\n",
  "src/app/other.py": "import json\n\nVALUE = json.dumps(1)\n",
  "src/app/shapes/__init__.py": "from . import square\n",
  "src/app/shapes/square.py": "SIDES = 4\n",
  "tests/conftest.py": "import pytest\n",
  "tests/helpers.py": "from app.other import VALUE\n",
  "tests/test_core.py":
    "import pytest\nfrom app.core import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
  "tests/test_util.py": "import app.util\n\ndef test_twice():\n    assert app.util.twice(2) == 4\n",
  "tests/test_other.py": "from helpers import VALUE\n",
  "tests/test_shapes.py": "from app.shapes import square\n",
  "tests/unit/plain_test.py": "import requests\n",
  "README.md": "app\n",
};

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, files: Record<string, string | null>) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(root, path));
    else {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  }
  git(root, "add", "-A");
  git(root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "c");
  return git(root, "rev-parse", "HEAD");
}

async function planned(
  edits: Record<string, string | null>,
  select: Partial<TestSelect> = { package_roots: ["src"] },
): Promise<TestPlan> {
  const root = mkdtempSync(join(tmpdir(), "paws-python-"));
  roots.push(root);
  git(root, "init", "-q");
  const base = write(root, FILES);
  const head = write(root, edits);
  const env = { PATH: process.env.PATH ?? "" };
  return pytestTestAdapter.plan({
    item: {
      id: "test",
      kind: "command",
      gate: "beforePR",
      exec: ["python3", "-m", "pytest", "-q"],
      timeoutSeconds: 60,
      select: { runner: "pytest", ...select },
    },
    cwd: root,
    base,
    head,
    reportDir: root,
    env,
    deadline: Date.now() + 60_000,
    changes: () => testChanges(root, base, head, env),
    readAtBase: async () => undefined,
    readAtHead: async () => undefined,
    snapshot: (at, read) => snapshotAt(root, at, env, read),
  });
}

const targets = (plan: TestPlan) =>
  plan.selection.mode === "selected" ? plan.selection.targets : plan.selection.reasons;

test("a src-layout change selects the tests that import it, directly or through relative imports", async () => {
  const plan = await planned({
    "src/app/core.py": "def add(a, b):\n    return b + a\n",
    "tests/unit/new_test.py": "from app import core\n",
  });
  expect(targets(plan)).toEqual([
    "tests/test_core.py",
    "tests/test_util.py",
    "tests/unit/new_test.py",
  ]);
  expect(plan.invocations[0]?.argv.slice(0, 6)).toEqual([
    "python3",
    "-m",
    "pytest",
    "-q",
    "-o",
    "junit_family=xunit1",
  ]);
  expect(plan.invocations[0]?.argv.slice(7)).toEqual(targets(plan));
});

test("imports at the base, package __init__ imports and test helpers are followed", async () => {
  expect(targets(await planned({ "src/app/core.py": null, "src/app/util.py": "" }))).toEqual([
    "tests/test_core.py",
    "tests/test_util.py",
  ]);
  expect(targets(await planned({ "src/app/shapes/square.py": "SIDES = 5\n" }))).toEqual([
    "tests/test_shapes.py",
  ]);
  expect(
    targets(await planned({ "tests/helpers.py": "VALUE = 2\n" }, { package_roots: ["src"] })),
  ).toEqual(["tests/test_other.py"]);
  expect(
    targets(
      await planned(
        { "src/app/core.py": "X = 1\n" },
        { package_roots: ["src"], always: ["tests/test_other.py"] },
      ),
    ),
  ).toEqual(["tests/test_core.py", "tests/test_other.py", "tests/test_util.py"]);
});

test("conftest, dependency files, dynamic imports and namespace packages force the full run", async () => {
  const cases: [Record<string, string | null>, string][] = [
    [{ "tests/conftest.py": "import os\n" }, "tests/conftest.py changed"],
    [{ "pyproject.toml": '[project]\nname = "b"\n' }, "pyproject.toml changed"],
    [{ "requirements-dev.txt": "pytest\n" }, "requirements-dev.txt changed"],
    [{ "pytest.ini": "[pytest]\npython_files = check_*.py\n" }, "pytest.ini changed"],
    [
      { "src/app/other.py": "import importlib\nimportlib.import_module('json')\n" },
      "at head: src/app/other.py imports modules dynamically",
    ],
    [
      { "src/app/core.py": "X = __import__('os')\n" },
      "at head: src/app/core.py imports modules dynamically",
    ],
    [
      { "src/app/extra/mod.py": "X = 1\n" },
      "at head: src/app/extra is a namespace package without __init__.py",
    ],
    [
      { "src/app/data.json": "{}\n" },
      "src/app/data.json changed, and it is not a Python file under package_roots",
    ],
    [{ "README.md": "b\n" }, "no test file reaches a changed path, and select.always is empty"],
    [{ "src/app/core.py": "def add(:\n" }, "at head: src/app/core.py could not be parsed"],
  ];
  for (const [edits, reason] of cases) {
    const plan = await planned(edits);
    expect(plan.selection.mode).toBe("full");
    expect(plan.selection.reasons.join("\n")).toContain(reason);
    expect(plan.invocations[0]?.argv.at(-1)).toMatch(/^--junitxml=/);
  }
  expect(
    (await planned({ "src/app/core.py": "X = 1\n" }, { package_roots: ["src"], max_selected: 1 }))
      .selection.reasons,
  ).toEqual(["2 test files are selected, more than max_selected 1"]);
});

test("without package_roots the pytest runner runs the full suite", async () => {
  const plan = await planned({ "src/app/core.py": "X = 1\n" }, {});
  expect(plan.selection).toEqual({ mode: "full", reasons: ["package_roots not set"] });
});

test("package_roots needs the pytest runner and stays inside the root", () => {
  const parse = createPolicyParser(policySchema);
  const policy = (exec: string, select: string) =>
    `specVersion: "0.1"\nitems:\n  - id: test\n    kind: command\n    gate: beforePR\n    exec: ${exec}\n    timeoutSeconds: 60\n    select: ${select}\n`;
  expect(
    parse(policy('["pytest"]', '{ runner: pytest, package_roots: ["src", "."] }')),
  ).toMatchObject({
    ok: true,
    document: { items: [{ select: { package_roots: ["src", "."] } }] },
  });
  expect(
    parse(policy('["pytest"]', '{ runner: pytest, package_roots: ["../lib"] }')),
  ).toMatchObject({
    ok: false,
  });
  expect(parse(policy('["bun", "test"]', '{ runner: bun, package_roots: ["src"] }'))).toMatchObject(
    {
      ok: false,
    },
  );
});
