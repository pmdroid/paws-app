import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testFiles } from "./affected-tests";

export function stressMatrix(root: string, base: string) {
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=AMR", "--find-renames", `${base}...HEAD`],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (diff.error || diff.status !== 0) throw new Error(`Cannot read stress diff: ${diff.stderr}`);
  const existing = new Set(testFiles(root));
  const files = [...new Set(diff.stdout.split("\0").filter((path) => existing.has(path)))].sort();
  const classifier = new RegExp(
    process.env.DATABASE_TESTS ??
      "tempStore|serverPostgres|describePglite|pgliteServer|improvement-fixtures|decision-memory-fixture",
  );
  const exclusions = join(root, "test/postgres-known-failures.txt");
  const excluded = new Set(
    (existsSync(exclusions) ? readFileSync(exclusions, "utf8") : "")
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean),
  );
  const database = files.filter(
    (file) =>
      file.startsWith("src/db/") ||
      (file.startsWith("test/") &&
        file.endsWith(".test.ts") &&
        !excluded.has(file) &&
        classifier.test(readFileSync(join(root, file), "utf8"))),
  );
  const include = [...batches(files, "default"), ...batches(database, "postgres")];
  if (include.length > 256) throw new Error(`Unsupported stress batch count: ${include.length}`);
  return { include };
}

function batches(files: string[], dialect: string) {
  return Array.from({ length: Math.max(1, Math.ceil(files.length / 10)) }, (_, index) => ({
    batch: index + 1,
    dialect,
    files: files.slice(index * 10, (index + 1) * 10).map((path) => `./${path}`),
  }));
}

if (import.meta.main) {
  if (process.argv[2] === "--run") {
    const files: unknown = JSON.parse(process.env.STRESS_FILES ?? "");
    if (
      !Array.isArray(files) ||
      files.length > 10 ||
      files.some((file) => typeof file !== "string" || !file.startsWith("./"))
    )
      throw new Error("Invalid stress batch");
    if (files.length === 0) console.log("No new or changed test files for this backend");
    else if (process.env.STRESS_DIALECT === "postgres" && !process.env.PAWS_TEST_DATABASE_URL)
      throw new Error("Postgres stress requires PAWS_TEST_DATABASE_URL");
    else {
      const run = spawnSync(
        "bun",
        [
          join(import.meta.dir, "test-watchdog.ts"),
          "--parallel=4",
          "--timeout=20000",
          "--no-orphans",
          "--rerun-each=3",
          ...files,
        ],
        { stdio: "inherit" },
      );
      process.exit(run.status ?? 1);
    }
  } else {
    const base = process.argv[2];
    if (!base) throw new Error("Stress selection requires a base");
    const matrix = JSON.stringify(stressMatrix(process.cwd(), base));
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GITHUB_OUTPUT");
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
    console.log(matrix);
  }
}
