import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stressMatrix } from "./stress-tests";

function history(run: (root: string, git: (...args: string[]) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), "paws-stress-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(root, "existing.test.ts"), "original");
    writeFileSync(join(root, "deleted.test.ts"), "deleted");
    git("add", ".");
    git("commit", "-qm", "base");
    git("tag", "base");
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const count of [0, 1, 11, 21]) {
  test(`selects all ${count} changed tests exactly once in bounded batches`, () => {
    history((root, git) => {
      const expected = Array.from(
        { length: count },
        (_, index) => `./file-${String(index).padStart(2, "0")}.test.ts`,
      );
      for (const file of expected) writeFileSync(join(root, file), "");
      git("add", ".");
      git("commit", "--allow-empty", "-qm", "change");
      const matrix = stressMatrix(root, "base");
      expect(matrix.include.map((batch) => batch.files.length)).toEqual(
        count === 0 ? [0] : count === 1 ? [1] : count === 11 ? [10, 1] : [10, 10, 1],
      );
      expect(matrix.include.flatMap((batch) => batch.files)).toEqual(expected);
    });
  });
}

test("includes modifications, rename destinations and test conventions, excludes deletions", () => {
  history((root, git) => {
    renameSync(join(root, "existing.test.ts"), join(root, "renamed.test.tsx"));
    unlinkSync(join(root, "deleted.test.ts"));
    for (const file of ["modified.test.ts", "space name.spec.jsx", "under_test.mjs", "plain.ts"])
      writeFileSync(join(root, file), "before");
    git("add", ".");
    git("commit", "-qm", "rename and additions");
    writeFileSync(join(root, "modified.test.ts"), "after");
    git("add", ".");
    git("commit", "-qm", "modify");
    expect(stressMatrix(root, "base").include.flatMap((batch) => batch.files)).toEqual([
      "./modified.test.ts",
      "./renamed.test.tsx",
      "./space name.spec.jsx",
      "./under_test.mjs",
    ]);
    expect(stressMatrix(root, "HEAD^").include[0]!.files).toEqual(["./modified.test.ts"]);
  });
});

test("unreadable base and unsupported matrix size fail closed", () => {
  history((root, git) => {
    expect(() => stressMatrix(root, "missing")).toThrow("Cannot read stress diff");
    for (let index = 0; index < 2561; index++) writeFileSync(join(root, `${index}.test.ts`), "");
    git("add", ".");
    git("commit", "-qm", "too many");
    expect(() => stressMatrix(root, "base")).toThrow("Unsupported stress batch count");
    const command = ["bun", join(import.meta.dir, "stress-tests.ts"), "invalid-base-ref"];
    const result = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
});

test("workflow bounds stress and feeds the matrix to the required aggregate", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
  );
  const stress = workflow.jobs["changed-tests"];
  expect(workflow.jobs["select-changed-tests"].steps.at(-2).run).toBe(
    "bun install --frozen-lockfile",
  );
  expect(workflow.jobs["select-changed-tests"].steps.at(-1).run).toBe(
    'bun scripts/stress-tests.ts "origin/$BASE_REF"',
  );
  expect(stress.needs).toEqual(["select-changed-tests"]);
  expect(stress.strategy).toEqual({
    "fail-fast": false,
    "max-parallel": 2,
    matrix: "${{ fromJSON(needs.select-changed-tests.outputs.matrix) }}",
  });
  expect(stress["timeout-minutes"]).toBe(30);
  expect(stress.steps.at(-1).env.STRESS_FILES).toBe("${{ toJSON(matrix.files) }}");
  expect(stress.steps.at(-1).run).toBe("bun scripts/stress-tests.ts --run");
  expect(readFileSync(join(import.meta.dir, "stress-tests.ts"), "utf8")).toContain(
    '"--rerun-each=3"',
  );
});
