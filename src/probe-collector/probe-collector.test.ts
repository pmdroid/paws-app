import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunAgentOptions, RunAgentResult } from "../acp";
import {
  createFakeReviewThreads,
  type FakeReviewThread,
  type GitHubClient,
  type GitHubResponse,
  type GitHubTokenProvider,
} from "../github";
import { collectProbes, type CollectOptions } from "./collect";
import { parseProbesArgs } from "./cli";
import { collectPullSources } from "./sources";
import type { AgentTurn, StoredFinding } from "./types";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paws-probe-collector-"));
  temps.push(dir);
  return dir;
}

const NOW = new Date("2026-10-27T12:00:00Z");
const tokenProvider: GitHubTokenProvider = { mode: "token", tokenFor: async () => "test-token" };

type FakePull = {
  number: number;
  title: string;
  mergedAt: string | null;
  updatedAt: string;
  mergeCommitSha?: string;
  comments?: { author: string; body: string }[];
  threads?: FakeReviewThread[];
};

/** GitHub REST pulls and issue comments plus the review threads GraphQL query, per pull. */
function fakeGitHubClient(pulls: FakePull[]): GitHubClient & { paths: string[] } {
  const threads = new Map(
    pulls.map((pull) => [pull.number, createFakeReviewThreads(pull.threads ?? [])]),
  );
  const url = (number: number) => `https://github.com/acme/widgets/pull/${number}`;
  const paths: string[] = [];
  return {
    paths,
    async request({ method, path, body }): Promise<GitHubResponse> {
      paths.push(`${method} ${path}`);
      if (method === "GET" && path.startsWith("/repos/acme/widgets/pulls?"))
        return {
          status: 200,
          body: path.includes("page=1")
            ? pulls.map((pull) => ({
                number: pull.number,
                title: pull.title,
                html_url: url(pull.number),
                merged_at: pull.mergedAt,
                updated_at: pull.updatedAt,
                merge_commit_sha: pull.mergeCommitSha ?? null,
              }))
            : [],
        };
      const comments = /^\/repos\/acme\/widgets\/issues\/(\d+)\/comments/.exec(path);
      if (method === "GET" && comments) {
        const pull = pulls.find((entry) => entry.number === Number(comments[1]));
        return {
          status: 200,
          body: (pull?.comments ?? []).map((comment, index) => ({
            body: comment.body,
            user: { login: comment.author },
            html_url: `${url(pull!.number)}#issuecomment-${pull!.number}0${index}`,
            created_at: pull!.updatedAt,
          })),
        };
      }
      if (method === "POST" && path === "/graphql") {
        const number = (body as { variables?: { number?: number } }).variables?.number;
        const answer = threads.get(number ?? -1)?.respond({ method, path, body });
        if (answer) return answer;
      }
      return { status: 404, body: { message: "Not Found" } };
    },
  };
}

describe("collecting pull request comments", () => {
  test("reads resolved and unresolved review threads and top-level comments from merged pull requests", async () => {
    const client = fakeGitHubClient([
      {
        number: 12,
        title: "Edit the first migration",
        mergedAt: "2026-10-20T10:00:00Z",
        updatedAt: "2026-10-20T10:00:00Z",
        comments: [{ author: "ana", body: "Shipped migrations must never change." }],
        threads: [
          {
            resolved: true,
            path: "migrations/001.sql",
            line: 3,
            comments: [
              {
                author: "ben",
                body: "Add a new migration instead of editing this one.",
                url: "https://github.com/acme/widgets/pull/12#discussion_r1",
              },
              { author: "cy", body: "Done." },
            ],
          },
          {
            resolved: false,
            path: "src/api.ts",
            comments: [
              {
                author: "ana",
                body: "Never remove a field from the API.",
                url: "https://github.com/acme/widgets/pull/12#discussion_r2",
              },
            ],
          },
        ],
      },
      {
        number: 13,
        title: "Closed without merging",
        mergedAt: null,
        updatedAt: "2026-10-21T10:00:00Z",
        comments: [{ author: "ana", body: "Not merged, not a rule." }],
      },
      {
        number: 5,
        title: "Too old",
        mergedAt: "2026-06-01T10:00:00Z",
        updatedAt: "2026-06-01T10:00:00Z",
        comments: [{ author: "ana", body: "Older than the window." }],
      },
    ]);
    const collected = await collectPullSources({
      client,
      tokenProvider,
      owner: "acme",
      repo: "widgets",
      since: new Date("2026-07-29T12:00:00Z"),
    });
    expect(collected.pulls.map((pull) => pull.number)).toEqual([12]);
    expect(collected.sources.map(({ kind, url, title }) => ({ kind, url, title }))).toEqual([
      {
        kind: "pull_comment",
        url: "https://github.com/acme/widgets/pull/12#issuecomment-1200",
        title: "#12 Edit the first migration: comment by ana",
      },
      {
        kind: "review_thread",
        url: "https://github.com/acme/widgets/pull/12#discussion_r1",
        title: "#12 Edit the first migration: review thread on migrations/001.sql:3, resolved",
      },
      {
        kind: "review_thread",
        url: "https://github.com/acme/widgets/pull/12#discussion_r2",
        title: "#12 Edit the first migration: review thread on src/api.ts, unresolved",
      },
    ]);
    expect(collected.sources[1]!.text).toBe(
      "ben: Add a new migration instead of editing this one.\n\ncy: Done.",
    );
    expect(client.paths.some((path) => path.includes("/issues/13/"))).toBe(false);
  });
});

function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/**
 * A repository whose AGENTS.md says shipped migrations never change, a commit that broke
 * that rule, and the commit that fixed it on main.
 */
function fixtureRepository(): { path: string; broke: string; main: string } {
  const path = tempDir();
  sh(path, "init", "-q", "-b", "main");
  write(
    path,
    "AGENTS.md",
    "# Widgets\n\nShipped migration files under migrations/ never change.\nKeep the changelog friendly.\n",
  );
  write(path, "migrations/001.sql", "CREATE TABLE widget (id TEXT);\n");
  sh(path, "add", ".");
  sh(path, "commit", "-q", "-m", "init");
  write(path, "migrations/001.sql", "CREATE TABLE widget (id TEXT, name TEXT);\n");
  sh(path, "commit", "-q", "-am", "edit the first migration");
  const broke = sh(path, "rev-parse", "HEAD");
  write(path, "migrations/001.sql", "CREATE TABLE widget (id TEXT);\n");
  write(path, "migrations/002.sql", "ALTER TABLE widget ADD name TEXT;\n");
  sh(path, "add", ".");
  sh(path, "commit", "-q", "-m", "move the change to a new migration");
  return { path, broke, main: sh(path, "rev-parse", "HEAD") };
}

const MIGRATIONS_PROBE = `const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const diff = Bun.spawnSync(["git", "-C", arg("--repo"), "diff", "--name-status", arg("--base"), arg("--head"), "--", "migrations"]);
const changed = diff.stdout.toString().split("\\n").filter((line) => /^[MDR]/.test(line));
for (const line of changed) console.log(\`shipped migration changed: \${line}\`);
process.exit(changed.length ? 1 : 0);
`;

const BLIND_PROBE = "process.exit(0);\n";

type Recorded = { prompt: string; role: string; worktree: string; readOnly: boolean };

/**
 * The agent seam. The distill turn groups the AGENTS.md line and the two review comments;
 * each writing session writes the probe its candidate needs.
 */
function fakeTurn(broke: string): AgentTurn & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const turn = async (options: RunAgentOptions): Promise<RunAgentResult> => {
    calls.push({
      prompt: options.prompt,
      role: options.role,
      worktree: options.worktreePath,
      readOnly: options.readOnly ?? false,
    });
    const id = (pattern: RegExp) => pattern.exec(options.prompt)?.[1] ?? "S0";
    let reply: string;
    if (options.prompt.startsWith("You are drafting")) {
      const agents = id(/## (S\d+) · doc · AGENTS\.md/);
      const migration = id(/## (S\d+) · review_thread · [^\n]*migrations\/001\.sql/);
      const api = id(/## (S\d+) · review_thread · [^\n]*src\/api\.ts/);
      reply = `\`\`\`json\n${JSON.stringify({
        candidates: [
          {
            id: "migrations-append-only",
            summary: "Shipped migration files never change.",
            decidable: true,
            sources: [
              { source: agents, line: 3 },
              { source: migration, quote: "Add a new migration instead of editing this one." },
            ],
            breaks: [{ commit: broke }],
          },
          {
            id: "api-fields-stay",
            summary: "No field is removed from the API.",
            decidable: true,
            sources: [{ source: api, quote: "Never remove a field from the API." }],
            breaks: [{ pull: 12 }],
          },
          {
            id: "friendly-changelog",
            summary: "The changelog stays friendly.",
            decidable: false,
            reason: "Tone needs a person.",
            sources: [{ source: agents, line: 4 }],
          },
        ],
      })}\n\`\`\``;
    } else {
      const rule = /Write a Closeout probe for the rule `([a-z-]+)`/.exec(options.prompt)![1]!;
      write(
        options.worktreePath,
        `.agents/probes/${rule}.ts`,
        rule === "migrations-append-only" ? MIGRATIONS_PROBE : BLIND_PROBE,
      );
      reply = `Done.\n\`\`\`json\n${JSON.stringify(
        rule === "migrations-append-only"
          ? { paths: ["migrations/**"], failOn: "P0" }
          : { paths: ["src/api.ts"], failOn: "P1", onFail: "approve" },
      )}\n\`\`\``;
    }
    await options.onEvent?.({
      type: "session_update",
      sessionId: "fake",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
    } as never);
    return {
      role: options.role,
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      identity: { session: "fake", model: "fake-model", provider: "fake" },
    };
  };
  return Object.assign(turn, { calls });
}

function collectOptions(input: {
  remote: string;
  broke: string;
  pawsRoot: string;
  out: string;
  turn: AgentTurn;
  dryRun?: boolean;
  findings?: StoredFinding[];
}): CollectOptions {
  return {
    repository: { owner: "acme", repo: "widgets", remoteUrl: input.remote },
    pawsRoot: input.pawsRoot,
    since: new Date("2026-07-29T12:00:00Z"),
    dryRun: input.dryRun ?? false,
    out: input.out,
    github: {
      client: fakeGitHubClient([
        {
          number: 12,
          title: "Edit the first migration",
          mergedAt: "2026-10-20T10:00:00Z",
          updatedAt: "2026-10-20T10:00:00Z",
          mergeCommitSha: input.broke,
          threads: [
            {
              resolved: true,
              path: "migrations/001.sql",
              line: 1,
              comments: [
                {
                  author: "ben",
                  body: "Add a new migration instead of editing this one.",
                  url: "https://github.com/acme/widgets/pull/12#discussion_r1",
                },
              ],
            },
            {
              path: "src/api.ts",
              comments: [
                {
                  author: "ana",
                  body: "Never remove a field from the API.",
                  url: "https://github.com/acme/widgets/pull/12#discussion_r2",
                },
              ],
            },
          ],
        },
      ]),
      tokenProvider,
    },
    turn: input.turn,
    findings: async () => input.findings ?? [],
    keep: async (candidates) => candidates.map((candidate) => candidate.id),
    print: () => undefined,
    runKey: "probes-test",
  };
}

describe("paws probes collect", () => {
  test("drafts checked rules whose sources link back to AGENTS.md and the review comments", async () => {
    const fixture = fixtureRepository();
    const pawsRoot = tempDir();
    const out = join(tempDir(), "probes.proposed.yaml");
    const turn = fakeTurn(fixture.broke);
    const result = await collectProbes(
      collectOptions({ remote: fixture.path, broke: fixture.broke, pawsRoot, out, turn }),
    );

    expect(result.main).toBe(fixture.main);
    const agentsUrl = `https://github.com/acme/widgets/blob/${fixture.main}/AGENTS.md`;
    expect(result.candidates.map((candidate) => candidate.sources.map((link) => link.url))).toEqual(
      [
        [`${agentsUrl}#L3`, "https://github.com/acme/widgets/pull/12#discussion_r1"],
        ["https://github.com/acme/widgets/pull/12#discussion_r2"],
        [`${agentsUrl}#L4`],
      ],
    );
    expect(result.candidates[0]!.sources[0]!.quote).toBe(
      "Shipped migration files under migrations/ never change.",
    );

    expect(result.skipped.map(({ candidate, reason }) => [candidate.id, reason])).toEqual([
      ["friendly-changelog", "Tone needs a person."],
    ]);

    const byId = new Map(result.rules.map((rule) => [rule.candidate.id, rule]));
    const migrations = byId.get("migrations-append-only")!;
    expect(migrations.check.main.passed).toBe(true);
    expect(migrations.check.breaks.map((entry) => [entry.commit, entry.run?.passed])).toEqual([
      [fixture.broke, false],
    ]);
    expect(migrations.check.breaks[0]!.run!.output).toContain("migrations/001.sql");
    expect(migrations.check.status).toBe("checked");

    const blind = byId.get("api-fields-stay")!;
    expect(blind.check.breaks.map((entry) => [entry.commit, entry.run?.passed])).toEqual([
      [fixture.broke, true],
    ]);
    expect(blind.check.status).toBe("misses_bug");

    const yaml = readFileSync(out, "utf8");
    expect(yaml).toContain(
      `  # source: ${agentsUrl}#L3 "Shipped migration files under migrations/ never change."`,
    );
    expect(yaml).toContain(
      '  # source: https://github.com/acme/widgets/pull/12#discussion_r1 "Add a new migration instead of editing this one."',
    );
    expect(yaml).toContain(
      '  # source: https://github.com/acme/widgets/pull/12#discussion_r2 "Never remove a field from the API."',
    );
    expect(yaml).toContain(`  # check: fails on ${fixture.broke.slice(0, 12)}, as it should\n`);
    expect(yaml).toContain(
      `  # check: passes on #12 (${fixture.broke.slice(0, 12)}), so it does not see the bug\n`,
    );
    expect(yaml).toContain("  - id: migrations-append-only\n");
    expect(yaml).toContain('    paths: ["migrations/**"]\n    failOn: P0\n');
    expect(yaml).toContain("    onFail: approve\n");
    expect(yaml).toContain(
      "# - friendly-changelog: The changelog stays friendly. (Tone needs a person.)",
    );
    expect(
      readFileSync(join(dirname(out), "probes.proposed", "migrations-append-only.ts"), "utf8"),
    ).toBe(MIGRATIONS_PROBE);

    expect(turn.calls.map((call) => [call.role, call.readOnly])).toEqual([
      ["reviewer", true],
      ["implementer", false],
      ["implementer", false],
    ]);
    expect(turn.calls[0]!.worktree.startsWith(pawsRoot)).toBe(false);
    expect(existsSync(turn.calls[1]!.worktree)).toBe(false);
    expect(existsSync(join(fixture.path, ".agents"))).toBe(false);
    expect(sh(fixture.path, "rev-parse", "main")).toBe(fixture.main);
  });

  test("stored Closeout findings are sources", async () => {
    const fixture = fixtureRepository();
    const turn = fakeTurn(fixture.broke);
    await collectProbes({
      ...collectOptions({
        remote: fixture.path,
        broke: fixture.broke,
        pawsRoot: tempDir(),
        out: join(tempDir(), "probes.proposed.yaml"),
        turn,
        dryRun: true,
        findings: [
          {
            task: "PAS-1",
            check: "independent-review",
            head: fixture.main,
            finding: {
              severity: "P1",
              location: "src/loop/restart.ts:10",
              explanation: "Only src/loop may restart an item.",
              evidence: "restart() is called from src/server.",
            },
          },
        ],
      }),
    });
    expect(turn.calls[0]!.prompt).toContain(
      "closeout_finding · Closeout independent-review finding (P1) in PAS-1 at src/loop/restart.ts:10",
    );
    expect(turn.calls[0]!.prompt).toContain("Only src/loop may restart an item.");
  });

  test("--dry-run prints the candidates, opens no probe session and writes no files", async () => {
    const fixture = fixtureRepository();
    const pawsRoot = tempDir();
    const outDir = tempDir();
    const out = join(outDir, "probes.proposed.yaml");
    const turn = fakeTurn(fixture.broke);
    const printed: string[] = [];
    const result = await collectProbes({
      ...collectOptions({
        remote: fixture.path,
        broke: fixture.broke,
        pawsRoot,
        out,
        turn,
        dryRun: true,
      }),
      print: (text) => printed.push(text),
    });
    expect(turn.calls).toHaveLength(1);
    expect(result.rules).toEqual([]);
    expect(result.out).toBeNull();
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(outDir, "probes.proposed"))).toBe(false);
    expect(existsSync(join(pawsRoot, "worktrees"))).toBe(false);
    const listing = printed.join("\n");
    expect(listing).toContain("+ migrations-append-only: Shipped migration files never change.");
    expect(listing).toContain(
      "- friendly-changelog: The changelog stays friendly.\n    skipped: Tone needs a person.",
    );
  });

  test("a candidate nobody keeps is skipped and gets no session", async () => {
    const fixture = fixtureRepository();
    const turn = fakeTurn(fixture.broke);
    const out = join(tempDir(), "probes.proposed.yaml");
    const result = await collectProbes({
      ...collectOptions({
        remote: fixture.path,
        broke: fixture.broke,
        pawsRoot: tempDir(),
        out,
        turn,
      }),
      keep: async () => ["migrations-append-only"],
    });
    expect(turn.calls).toHaveLength(2);
    expect(result.rules.map((rule) => rule.candidate.id)).toEqual(["migrations-append-only"]);
    expect(result.skipped.map(({ candidate, reason }) => [candidate.id, reason])).toEqual([
      ["friendly-changelog", "Tone needs a person."],
      ["api-fields-stay", "not kept"],
    ]);
  });
});

describe("probes arguments", () => {
  test("defaults to 90 days and probes.proposed.yaml", () => {
    expect(parseProbesArgs(["collect", "acme/widgets"], NOW)).toEqual({
      owner: "acme",
      repo: "widgets",
      since: new Date("2026-07-29T12:00:00Z"),
      out: "probes.proposed.yaml",
      keep: null,
      dryRun: false,
    });
  });

  test("reads --since, --out, --keep and --dry-run", () => {
    expect(
      parseProbesArgs(
        [
          "collect",
          "acme/widgets",
          "--since",
          "30d",
          "--out",
          "rules.yaml",
          "--keep",
          "a, b",
          "--dry-run",
        ],
        NOW,
      ),
    ).toEqual({
      owner: "acme",
      repo: "widgets",
      since: new Date("2026-09-27T12:00:00Z"),
      out: "rules.yaml",
      keep: ["a", "b"],
      dryRun: true,
    });
    expect(
      parseProbesArgs(["collect", "acme/widgets", "--since", "2026-10-01"], NOW).since,
    ).toEqual(new Date("2026-10-01T00:00:00Z"));
  });

  test("rejects a missing repository and unknown options", () => {
    expect(() => parseProbesArgs(["collect"], NOW)).toThrow("owner/repo");
    expect(() => parseProbesArgs(["collect", "acme/widgets", "--push"], NOW)).toThrow(
      "Unknown option --push.",
    );
    expect(() => parseProbesArgs(["list"], NOW)).toThrow("Unknown probes command.");
  });
});
