/**
 * Vendored Closeout conformance suite.
 *
 * Fixtures come from `pmdroid/closeout` `conformance/` at `SPEC_COMMIT`.
 * The hash manifest records that snapshot. Replacing a fixture means updating
 * the manifest and bumping `SPEC_COMMIT` together.
 *
 * `git: true` cases are committed, and that commit is both base and head.
 * Validate and decision read `origin/main`, so the harness publishes the
 * commit. Evidence templates may use `$base`, `$head`, `$digest`, and
 * `$version`. A digest case appends a newline to `touch` and the directory
 * digest must change.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { CLOSEOUT_REFERENCE_VERSION } from "../src/closeout-spec/evaluate";
import {
  SPEC_COMMIT,
  addReview,
  decision,
  digest,
  run,
  validate,
  type DecisionDocument,
} from "../src/closeout-spec";

const FIXTURES = new URL("./fixtures/closeout-conformance/", import.meta.url).pathname;

const CASES = [
  "digest",
  "duplicate-id",
  "findings",
  "import-conflict",
  "import-cycle",
  "independence-model",
  "independence-session",
  "malformed",
  "missing",
  "path-escape",
  "retry-exhausted",
  "stale",
  "unknown-kind",
  "unknown-version",
] as const;

type ExpectItem = {
  id: string;
  state?: string;
  message?: string;
};

type ExpectFile = {
  check: string;
  git?: boolean;
  ok?: boolean;
  message?: string;
  messageContains?: string;
  warningCodes?: string[];
  decision?: string;
  candidate?: { session?: string; model?: string; provider?: string; task?: string };
  records?: unknown[];
  items?: ExpectItem[];
  touch?: string;
};

type Manifest = {
  specVersion: string;
  commit: string;
  commitFull: string;
  files: Record<string, string>;
};

describe("closeout conformance", () => {
  test("fixture hashes are pinned to SPEC_COMMIT", () => {
    const manifest = readManifest();
    expect(manifest.specVersion).toBe("0.1");
    expect(manifest.commit).toBe(SPEC_COMMIT);
    expect(manifest.commitFull.startsWith(SPEC_COMMIT)).toBe(true);

    const present = walk(FIXTURES)
      .map((path) => relative(FIXTURES, path).split("\\").join("/"))
      .filter((path) => path !== "manifest.json")
      .sort();
    const listed = Object.keys(manifest.files).sort();
    expect(present).toEqual(listed);
    for (const path of listed) {
      const bytes = readFileSync(join(FIXTURES, path));
      const hash = createHash("sha256").update(bytes).digest("hex");
      const expected = manifest.files[path];
      if (expected === undefined) throw new Error(`manifest is missing ${path}`);
      expect(hash).toBe(expected);
    }

    const dirs = readdirSync(FIXTURES)
      .filter((name) => statSync(join(FIXTURES, name)).isDirectory())
      .sort();
    expect(dirs).toEqual([...CASES]);
  });

  for (const name of CASES) {
    test(name, async () => {
      await runCase(name);
    });
  }

  test("run executes an origin command and addReview records a passing review", async () => {
    const temp = await mkdtemp(join(tmpdir(), "closeout-facade-"));
    try {
      const repo = join(temp, "repo");
      mkdirSync(join(repo, ".agents/skills/adversarial-review"), { recursive: true });
      writeFileSync(
        join(repo, ".agents/closeout.yaml"),
        [
          'specVersion: "0.1"',
          "items:",
          "  - id: check",
          "    kind: command",
          "    gate: beforePR",
          '    exec: ["/usr/bin/true"]',
          "    timeoutSeconds: 30",
          "  - id: adversarial-review",
          "    kind: review",
          "    gate: beforePR",
          "    skill: .agents/skills/adversarial-review/SKILL.md",
          "    independence:",
          "      differentSession: true",
          "      differentModel: true",
          "    failOn: P1",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(repo, ".agents/skills/adversarial-review/SKILL.md"),
        "Review the candidate revision.\n",
      );
      const sha = publishFixture(repo);
      const home = emptyHome(repo);
      const candidate = { session: "implementer", model: "model-a", provider: "codex" };
      const pawsHome = join(temp, "paws");
      mkdirSync(pawsHome);
      const ran = await run({
        repo,
        base: sha,
        head: sha,
        gate: "beforePR",
        task: "task-one",
        candidate,
        home,
        pawsHome,
      });
      expect(ran.decision).toBe("blocked");
      expect(ran.items.find((item) => item.id === "check")?.state).toBe("passed");
      expect(ran.items.find((item) => item.id === "check")?.message).toBe("exited 0");
      expect(ran.items.find((item) => item.id === "adversarial-review")?.state).toBe("missing");

      const added = await addReview({
        repo,
        base: sha,
        head: sha,
        gate: "beforePR",
        task: "task-one",
        itemId: "adversarial-review",
        candidate,
        home,
        reviewer: {
          async review() {
            return {
              producer: { session: "reviewer", model: "model-b", provider: "other" },
              findings: [],
              artifacts: [],
            };
          },
        },
      });
      expect(added.ok).toBe(true);

      const decided = await decision({
        repo,
        base: sha,
        head: sha,
        gate: "beforePR",
        task: "task-one",
        candidate,
        home,
      });
      expect(decided.decision).toBe("accepted");
      expect(decided.items.find((item) => item.id === "adversarial-review")?.state).toBe("passed");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.env.CLOSEOUT_REFERENCE_BIN === undefined)(
    "reference binary matches the vendored fixtures",
    async () => {
      const bin = process.env.CLOSEOUT_REFERENCE_BIN;
      if (bin === undefined) return;
      for (const name of CASES) {
        await crossCheck(bin, name);
      }
    },
  );
});

async function runCase(name: string): Promise<void> {
  const expectFile = readExpect(name);
  const temp = await mkdtemp(join(tmpdir(), "closeout-conformance-"));
  try {
    const repo = join(temp, "repo");
    copyFixture(name, repo);
    const published = expectFile.git === true || expectFile.check === "validate";
    const sha = published ? publishFixture(repo) : "";
    if (expectFile.check === "validate") {
      await checkValidate(name, expectFile, repo);
      return;
    }
    if (expectFile.check === "digest") {
      checkDigest(name, expectFile, repo);
      return;
    }
    if (expectFile.check === "decision") {
      await checkDecision(name, expectFile, repo, sha);
      return;
    }
    throw new Error(`${name}: unknown check ${expectFile.check}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function checkValidate(name: string, expectFile: ExpectFile, repo: string): Promise<void> {
  const result = await validate(repo, emptyHome(repo));
  if (result.ok !== expectFile.ok) {
    const message = result.ok ? "validation succeeded" : result.message;
    throw new Error(`${name}: ${message}`);
  }
  if (result.ok) return;
  if (expectFile.message !== undefined) expect(result.message).toBe(expectFile.message);
  if (expectFile.messageContains !== undefined) {
    expect(result.message).toContain(expectFile.messageContains);
  }
}

function checkDigest(name: string, expectFile: ExpectFile, repo: string): void {
  const touch = expectFile.touch;
  if (touch === undefined) throw new Error(`${name}: digest fixture has no touch`);
  const before = digest(repo);
  expect(before.ok).toBe(true);
  if (!before.ok || before.digest === null) throw new Error(`${name}: policy did not load`);
  expect(before.digest.startsWith("sha256:")).toBe(true);
  const file = join(repo, touch);
  const text = readFileSync(file, "utf8");
  writeFileSync(file, `${text}\n`);
  const after = digest(repo);
  expect(after.ok).toBe(true);
  if (!after.ok) throw new Error(`${name}: policy did not reload`);
  expect(after.digest).not.toBe(before.digest);
}

async function checkDecision(
  name: string,
  expectFile: ExpectFile,
  repo: string,
  sha: string,
): Promise<void> {
  const loaded = await validate(repo, emptyHome(repo));
  if (!loaded.ok || loaded.digest === null) {
    throw new Error(`${name}: policy did not load${loaded.ok ? "" : `: ${loaded.message}`}`);
  }
  const base = sha;
  const head = sha;
  writeEvidence(repo, expectFile.records ?? [], base, head, loaded.digest);
  const document = await decision({
    repo,
    base,
    head,
    gate: "beforePR",
    candidate: candidateOf(expectFile),
    home: emptyHome(repo),
    trust: { trustReference: true },
  });
  if (expectFile.decision === undefined) throw new Error(`${name}: missing decision`);
  expect(document.decision).toBe(expectFile.decision as DecisionDocument["decision"]);
  if (expectFile.warningCodes !== undefined) {
    expect(document.warnings.map((warning) => warning.code)).toEqual(expectFile.warningCodes);
  }
  const items = expectFile.items ?? [];
  expect(document.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
  for (const [index, item] of items.entries()) {
    const actual = document.items[index];
    if (actual === undefined) throw new Error(`${name}: missing item ${item.id}`);
    if (item.state !== undefined) expect(actual.state as string).toBe(item.state);
    if (item.message !== undefined) expect(actual.message).toBe(item.message);
  }
}

function writeEvidence(
  repo: string,
  records: readonly unknown[],
  base: string,
  head: string,
  policyDigest: string,
): void {
  for (const template of records) {
    const value = substitute(template, {
      $base: base,
      $head: head,
      $digest: policyDigest,
      $version: CLOSEOUT_REFERENCE_VERSION,
    });
    if (!isRecord(value)) throw new Error("evidence template is not an object");
    const recordDigest = stringField(value, "policyDigest");
    const recordHead = stringField(value, "head");
    const itemId = stringField(value, "itemId");
    const attempt = value.attempt;
    if (typeof attempt !== "number") throw new Error("evidence template has no attempt");
    const hex = recordDigest.startsWith("sha256:")
      ? recordDigest.slice("sha256:".length)
      : recordDigest;
    const file = join(
      repo,
      ".closeout",
      "evidence",
      hex,
      recordHead,
      ...itemId.split("/"),
      `${attempt}.json`,
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
}

function candidateOf(expectFile: ExpectFile): {
  session: string;
  model: string;
  provider: string;
  task?: string;
} {
  const candidate = expectFile.candidate;
  const result = {
    session: candidate?.session ?? "",
    model: candidate?.model ?? "",
    provider: candidate?.provider ?? "",
  };
  if (candidate?.task !== undefined) return { ...result, task: candidate.task };
  return result;
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const [token, replacement] of Object.entries(vars)) {
      text = text.replaceAll(token, replacement);
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) copy[key] = substitute(child, vars);
    return copy;
  }
  return value;
}

async function crossCheck(bin: string, name: string): Promise<void> {
  const expectFile = readExpect(name);
  const temp = await mkdtemp(join(tmpdir(), "closeout-reference-"));
  const home = join(temp, "home");
  mkdirSync(home);
  try {
    const repo = join(temp, "repo");
    copyFixture(name, repo);
    const sha = publishFixture(repo);
    if (expectFile.check === "validate") {
      const ours = await validate(repo, home);
      const ran = reference(bin, repo, home, ["validate", "--json"]);
      const body = json(ran.stdout);
      if (ours.ok) {
        expect(body.ok).toBe(true);
        expect(body.digest).toBe(ours.digest);
      } else {
        expect(typeof body.message).toBe("string");
        expect(body.message).toBe(ours.message);
      }
      return;
    }
    if (expectFile.check === "digest") {
      const before = digest(repo);
      const listed = reference(bin, repo, home, ["validate", "--json"]);
      const body = json(listed.stdout);
      expect(before.ok).toBe(true);
      if (before.ok) expect(body.digest).toBe(before.digest);
      const touch = expectFile.touch;
      if (touch === undefined) throw new Error(`${name}: digest fixture has no touch`);
      const file = join(repo, touch);
      writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
      const after = digest(repo);
      expect(after.ok).toBe(true);
      if (before.ok && after.ok) expect(after.digest).not.toBe(before.digest);
      return;
    }
    const loaded = await validate(repo, home);
    if (!loaded.ok || loaded.digest === null) throw new Error(`${name}: policy did not load`);
    writeEvidence(repo, expectFile.records ?? [], sha, sha, loaded.digest);
    const candidate = candidateOf(expectFile);
    const args = ["decision", "--gate", "beforePR", "--base", sha, "--head", sha, "--json"];
    if (candidate.session !== "") args.push("--candidate-session", candidate.session);
    if (candidate.model !== "") args.push("--candidate-model", candidate.model);
    if (candidate.provider !== "") args.push("--candidate-provider", candidate.provider);
    const ran = reference(bin, repo, home, args);
    const body = json(ran.stdout);
    const ours = await decision({
      repo,
      base: sha,
      head: sha,
      gate: "beforePR",
      candidate,
      home,
      trust: { trustReference: true },
    });
    expect(body.decision).toBe(ours.decision);
    expect(itemStates(body)).toEqual(
      ours.items.map((item) => ({ id: item.id, state: item.state, message: item.message })),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function itemStates(
  body: Record<string, unknown>,
): Array<{ id: string; state: string; message: string }> {
  if (!Array.isArray(body.items)) return [];
  const states: Array<{ id: string; state: string; message: string }> = [];
  for (const item of body.items) {
    if (!isRecord(item)) continue;
    states.push({
      id: typeof item.id === "string" ? item.id : "",
      state: typeof item.state === "string" ? item.state : "",
      message: typeof item.message === "string" ? item.message : "",
    });
  }
  return states;
}

function reference(
  bin: string,
  repo: string,
  home: string,
  args: string[],
): { stdout: string; stderr: string } {
  const result = spawnSync(bin, [...args, "--root", repo], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0" },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("reference output is not an object");
  return value;
}

function publishFixture(repo: string): string {
  const hooks = join(repo, "empty-hooks");
  const bare = join(dirname(repo), "origin.git");
  mkdirSync(hooks);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "closeout@example.com"]);
  git(repo, ["config", "user.name", "Closeout"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "core.hooksPath", hooks]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["init", "--bare", "-b", "main", bare]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["config", "protocol.file.allow", "always"]);
  git(repo, ["push", "origin", "main"]);
  return git(repo, ["rev-parse", "HEAD"]).trim().toLowerCase();
}

function copyFixture(name: string, repo: string): void {
  const source = join(FIXTURES, name, "repo");
  mkdirSync(repo, { recursive: true });
  copyDir(source, repo);
}

function copyDir(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyDir(join(from, entry.name), dest);
      continue;
    }
    writeFileSync(dest, readFileSync(join(from, entry.name)));
  }
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

function emptyHome(repo: string): string {
  const home = join(dirname(repo), "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function readExpect(name: string): ExpectFile {
  const value: unknown = JSON.parse(readFileSync(join(FIXTURES, name, "expect.json"), "utf8"));
  if (!isRecord(value) || typeof value.check !== "string") {
    throw new Error(`${name}: expect.json is not a fixture`);
  }
  return value as ExpectFile;
}

function readManifest(): Manifest {
  const value: unknown = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
  if (!isRecord(value) || !isRecord(value.files) || typeof value.commit !== "string") {
    throw new Error("conformance manifest is invalid");
  }
  if (typeof value.commitFull !== "string" || typeof value.specVersion !== "string") {
    throw new Error("conformance manifest is invalid");
  }
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== "string") throw new Error(`manifest hash for ${path} is not a string`);
    files[path] = hash;
  }
  return {
    specVersion: value.specVersion,
    commit: value.commit,
    commitFull: value.commitFull,
    files,
  };
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`evidence template ${key} is not a string`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
