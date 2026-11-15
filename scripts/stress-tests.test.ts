import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
      expect(
        matrix.include
          .filter((batch) => batch.dialect === "default")
          .map((batch) => batch.files.length),
      ).toEqual(count === 0 ? [0] : count === 1 ? [1] : count === 11 ? [10, 1] : [10, 10, 1]);
      expect(
        matrix.include
          .filter((batch) => batch.dialect === "default")
          .flatMap((batch) => batch.files),
      ).toEqual(expected);
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
    expect(
      stressMatrix(root, "base")
        .include.filter((batch) => batch.dialect === "default")
        .flatMap((batch) => batch.files),
    ).toEqual([
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

test("database selection repeats only eligible changed tests on Postgres", () => {
  history((root, git) => {
    mkdirSync(join(root, "src/db"), { recursive: true });
    mkdirSync(join(root, "test"));
    const files = {
      "src/db/rows.test.ts": "",
      "test/caller.test.ts": "tempStore",
      "test/plain.test.ts": "",
      "test/excluded.test.ts": "tempStore",
    };
    for (const [file, body] of Object.entries(files)) writeFileSync(join(root, file), body);
    writeFileSync(
      join(root, "test/postgres-known-failures.txt"),
      "# existing exclusions\ntest/excluded.test.ts\n",
    );
    git("add", ".");
    git("commit", "-qm", "database changes");
    const matrix = stressMatrix(root, "base");
    expect(
      matrix.include.filter((batch) => batch.dialect === "default").flatMap((batch) => batch.files),
    ).toEqual(
      Object.keys(files)
        .sort()
        .map((file) => `./${file}`),
    );
    expect(
      matrix.include
        .filter((batch) => batch.dialect === "postgres")
        .flatMap((batch) => batch.files),
    ).toEqual(["./src/db/rows.test.ts", "./test/caller.test.ts"]);
  });
});

test("Postgres stress requires a server URL and skips an empty subset explicitly", () => {
  const run = (files: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dir, "stress-tests.ts"), "--run"], {
      env: {
        ...process.env,
        STRESS_FILES: JSON.stringify(files),
        STRESS_DIALECT: "postgres",
        PAWS_TEST_DATABASE_URL: "",
      },
      encoding: "utf8",
    });
  expect(run(["./src/db/rows.test.ts"]).stderr).toContain("Postgres stress requires");
  expect(run([]).status).toBe(0);
  expect(run([]).stdout).toContain("No new or changed test files for this backend");
});

test("server-only failure propagates through the stress process to the required aggregate", () => {
  history((root) => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
    );
    const stress = workflow.jobs["changed-tests"];
    expect(stress.services).toEqual(workflow.jobs["test-postgres"].services);
    expect(stress.steps.at(-1).env.PAWS_TEST_DATABASE_URL).toContain(
      "matrix.dialect == 'postgres'",
    );
    expect(workflow.jobs["select-changed-tests"].steps.at(-1).env.DATABASE_TESTS).toBe(
      workflow.jobs["test-postgres"].env.DATABASE_TESTS,
    );
    writeFileSync(
      join(root, "bun"),
      '#!/bin/sh\nprintf "%s\\n" "$PAWS_TEST_DATABASE_URL" "$@"\nif [ -n "$PAWS_TEST_DATABASE_URL" ]; then exit 7; fi\n',
      { mode: 0o755 },
    );
    for (const dialect of ["default", "postgres"]) {
      const url =
        dialect === "postgres" ? workflow.jobs["test-postgres"].env.PAWS_TEST_DATABASE_URL : "";
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "stress-tests.ts"), "--run"],
        {
          env: {
            ...process.env,
            PATH: root,
            STRESS_FILES: '["./src/db/rows.test.ts"]',
            STRESS_DIALECT: dialect,
            PAWS_TEST_DATABASE_URL: url,
          },
          encoding: "utf8",
        },
      );
      expect(result.stdout).toContain("--rerun-each=3");
      expect(result.stdout).toContain("./src/db/rows.test.ts");
      expect(result.status).toBe(dialect === "postgres" ? 7 : 0);
      if (url) expect(result.stdout).toContain(url);
      const gate = workflow.jobs.check.steps[0];
      const aggregate = spawnSync("bash", ["-e", "-c", gate.run], {
        env: {
          ...process.env,
          EVENT_NAME: "pull_request",
          TEST_RESULT: "success",
          POSTGRES_RESULT: "success",
          SELECTION_RESULT: "success",
          STRESS_RESULT: result.status === 0 ? "success" : "failure",
        },
      });
      expect(aggregate.status === 0).toBe(dialect === "default");
    }
  });
});
