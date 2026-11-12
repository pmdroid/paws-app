import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_IGNORED_COMMENT_BOTS,
  MAIN_MOVED,
  ignoredCommentBots,
  loadConfigFile,
  mergeLaneKey,
  parseCommentWait,
  parseConfigToml,
  readMergeSettings,
  highRiskPaths,
  repositoryPackages,
  reviewApps,
  storedMerge,
  suggestedFindingsMode,
  writeMergePolicy,
} from "../src/config";
import { createFakeMergeQueue, repositoriesWithMergeQueue, type GitHubClient } from "../src/github";
import { handleMergeSettingsRequest, type MergeSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";

const PAWS = "843abf82-7a05-4340-b47b-2c81fe6e6e16";
const PAYMENTS = "4179d503-3ec3-4be7-a8ef-4415a2d9b5e9";

describe("config.toml [merge]", () => {
  test("stored project choices and issue rules load and every item uses the default", () => {
    const text = `[caps]
max_awake_ms = 40

[merge]
order = "ci-green"
main_moved = "overlap"
ci_fix_attempts = 2

[merge.projects."${PAWS}"]

[merge.projects."${PAYMENTS}"]
main_moved = "closeout"

[[merge.rules]]
label = "Bug"
order = "queue"

[[merge.rules]]
project = "${PAYMENTS}"
label = "Needs \\"care\\""

[merge.repositories."acme/platform"]
packages = ["apps/*", "packages/*"]
`;
    const config = parseConfigToml(text);
    expect(config.maxAwakeMs).toBe(40);
    expect(readMergeSettings(config)).toEqual({
      default: { order: "ci-green", mainMoved: "overlap" },
      repositories: { "acme/platform": { packages: ["apps/*", "packages/*"] } },
      lane: "project",
      projectLanes: {},
      autoApproveHighRisk: false,
      ciFixAttempts: 2,
      commentWait: { quietSeconds: 60, maxWaitSeconds: 300, reviewWaitMaxSeconds: 900 },
    });
    expect(config.ignoredMergeOverrides).toBe(true);
    expect(parseConfigToml('[merge]\norder = "queue"\n').ignoredMergeOverrides).toBeUndefined();
    expect(repositoryPackages(readMergeSettings(config), "Acme/Platform")).toEqual([
      "apps/*",
      "packages/*",
    ]);
    expect(repositoryPackages(readMergeSettings(config), "acme/web")).toEqual([]);
  });

  test("a repository's ignored comment bots replace the default status bots", () => {
    const config = parseConfigToml(
      `[merge.repositories."acme/platform"]\nignore_comment_bots = ["Codecov[bot]", "deploy-bot"]\n`,
    );
    const settings = readMergeSettings(config);
    expect(settings.repositories).toEqual({
      "acme/platform": { packages: [], ignoreCommentBots: ["Codecov[bot]", "deploy-bot"] },
    });
    expect(ignoredCommentBots(settings, "ACME/platform")).toEqual(["codecov[bot]", "deploy-bot"]);
    expect(ignoredCommentBots(settings, "acme/web")).toContain("cloudflare-workers-and-pages[bot]");
    expect(DEFAULT_IGNORED_COMMENT_BOTS).toContain("linear-code[bot]");
    expect(() =>
      parseConfigToml(`[merge.repositories."acme/platform"]\nignore_comment_bots = ["a b"]\n`),
    ).toThrow("must be a GitHub login");
  });

  test("a repository's review apps read, render and write back", () => {
    const text = `[merge]\nreview_wait_max_seconds = 600\n\n[merge.repositories."acme/platform"]\npackages = []\nreview_apps = ["Acme-Review", "acme-lint"]\n`;
    const settings = readMergeSettings(parseConfigToml(text));
    expect(reviewApps(settings, "ACME/platform")).toEqual(["acme-review", "acme-lint"]);
    expect(reviewApps(settings, "acme/web")).toEqual([]);
    expect(settings.commentWait.reviewWaitMaxSeconds).toBe(600);
    const home = tempHome();
    const path = join(home, "config.toml");
    writeMergePolicy(
      path,
      { default: { order: "queue", mainMoved: "ci" } },
      storedMerge(parseConfigToml(text)),
    );
    const saved = readMergeSettings(loadConfigFile(path));
    expect(reviewApps(saved, "acme/platform")).toEqual(["acme-review", "acme-lint"]);
    expect(saved.commentWait.reviewWaitMaxSeconds).toBe(600);
    expect(() =>
      parseConfigToml(`[merge.repositories."acme/platform"]\nreview_apps = ["acme review"]\n`),
    ).toThrow("must be a GitHub App slug");
  });

  test("each main_moved value round-trips through config.toml, and a missing key means ci", () => {
    expect(readMergeSettings(parseConfigToml('[merge]\norder = "queue"\n')).default).toEqual({
      order: "queue",
      mainMoved: "ci",
    });
    for (const value of MAIN_MOVED) {
      const config = parseConfigToml(
        `[merge]\nmain_moved = "${value}"\n\n[merge.projects."${PAWS}"]\nmain_moved = "${value}"\n\n[[merge.rules]]\nlabel = "Bug"\nmain_moved = "${value}"\n`,
      );
      const settings = readMergeSettings(config);
      expect(settings.default.mainMoved).toBe(value);
      const path = join(tempHome(), "config.toml");
      writeMergePolicy(path, settings, storedMerge(config));
      expect(readMergeSettings(loadConfigFile(path))).toEqual(settings);
    }
  });

  test("lane defaults to the Linear project, and a project's lane wins over [merge]", () => {
    const fallback = readMergeSettings(parseConfigToml(""));
    expect(fallback.lane).toBe("project");
    expect(mergeLaneKey(PAWS, fallback)).toBe(PAWS);
    // An item without a project shares the repository-wide lane.
    expect(mergeLaneKey(null, fallback)).toBe("");

    const config = parseConfigToml(
      `[merge]\nlane = "repository"\n\n[merge.projects."${PAWS}"]\nlane = "project"\n\n[merge.projects."${PAYMENTS}"]\norder = "ci-green"\n`,
    );
    const settings = readMergeSettings(config);
    expect(settings.lane).toBe("repository");
    expect(settings.projectLanes).toEqual({ [PAWS]: "project" });
    expect(mergeLaneKey(PAWS, settings)).toBe(PAWS);
    expect(mergeLaneKey(PAYMENTS, settings)).toBe("");
    expect(mergeLaneKey(null, settings)).toBe("");

    // Saving the Merging settings keeps the project lane and drops the ignored project choice.
    const path = join(tempHome(), "config.toml");
    writeMergePolicy(path, settings, storedMerge(config));
    expect(readMergeSettings(loadConfigFile(path))).toEqual(settings);
    expect(readFileSync(path, "utf8")).not.toContain("ci-green");

    expect(() => parseConfigToml('[merge]\nlane = "label"\n')).toThrow("merge.lane");
    expect(() => parseConfigToml(`[merge.projects."${PAWS}"]\nlane = "issue"\n`)).toThrow();
  });

  test("package roots must be relative paths in the repository", () => {
    for (const root of ["../apps/*", "/apps", "apps/**x", ""])
      expect(() =>
        parseConfigToml(
          `[merge.repositories."acme/platform"]\npackages = [${JSON.stringify(root)}]\n`,
        ),
      ).toThrow();
  });

  test("a repository's high-risk paths are globs in the repository", () => {
    const settings = readMergeSettings(
      parseConfigToml(
        `[merge.repositories."acme/platform"]\nhigh_risk_paths = ["src/auth/**", ".github/workflows/**"]\n`,
      ),
    );
    expect(settings.repositories).toEqual({
      "acme/platform": { packages: [], highRiskPaths: ["src/auth/**", ".github/workflows/**"] },
    });
    expect(highRiskPaths(settings, "Acme/Platform")).toEqual([
      "src/auth/**",
      ".github/workflows/**",
    ]);
    expect(highRiskPaths(settings, "acme/web")).toEqual([]);
    for (const glob of ["!src/**", "/src/**", "../x", ""])
      expect(() =>
        parseConfigToml(
          `[merge.repositories."acme/platform"]\nhigh_risk_paths = [${JSON.stringify(glob)}]\n`,
        ),
      ).toThrow("high_risk_paths");
  });

  test("a repository's suggested-findings mode round-trips, and a missing key means next_turn", () => {
    const config = parseConfigToml(
      `[merge.repositories."acme/platform"]\nsuggested_findings = "own_turn"\n\n[merge.repositories."acme/web"]\nsuggested_findings = "off"\n`,
    );
    const settings = readMergeSettings(config);
    expect(suggestedFindingsMode(settings, "Acme/Platform")).toBe("own_turn");
    expect(suggestedFindingsMode(settings, "acme/web")).toBe("off");
    expect(suggestedFindingsMode(settings, "acme/api")).toBe("next_turn");
    const path = join(tempHome(), "config.toml");
    writeMergePolicy(path, settings, storedMerge(config));
    expect(readMergeSettings(loadConfigFile(path)).repositories).toEqual(settings.repositories);
    expect(() =>
      parseConfigToml(`[merge.repositories."acme/platform"]\nsuggested_findings = "always"\n`),
    ).toThrow("suggested_findings");
  });

  test("the pull request comment wait reads, defaults and stays within bounds", () => {
    expect(readMergeSettings(parseConfigToml("")).commentWait).toEqual({
      quietSeconds: 60,
      maxWaitSeconds: 300,
      reviewWaitMaxSeconds: 900,
    });
    expect(
      readMergeSettings(
        parseConfigToml("[merge]\ncomment_quiet_seconds = 120\ncomment_max_wait_seconds = 600\n"),
      ).commentWait,
    ).toEqual({ quietSeconds: 120, maxWaitSeconds: 600, reviewWaitMaxSeconds: 900 });
    // A longest wait below the quiet time waits the quiet time; values cap at an hour.
    expect(
      readMergeSettings(
        parseConfigToml("[merge]\ncomment_quiet_seconds = 9000\ncomment_max_wait_seconds = 30\n"),
      ).commentWait,
    ).toEqual({ quietSeconds: 3600, maxWaitSeconds: 3600, reviewWaitMaxSeconds: 900 });
    expect(parseCommentWait({ quietSeconds: 0, maxWaitSeconds: 0 })).toEqual({
      quietSeconds: 0,
      maxWaitSeconds: 0,
    });
    expect(
      readMergeSettings(parseConfigToml("[merge]\nreview_wait_max_seconds = 1200\n")).commentWait
        .reviewWaitMaxSeconds,
    ).toBe(1200);
    expect(
      parseCommentWait({ quietSeconds: 0, maxWaitSeconds: 0, reviewWaitMaxSeconds: 600 }),
    ).toEqual({ quietSeconds: 0, maxWaitSeconds: 0, reviewWaitMaxSeconds: 600 });
    expect(() =>
      parseCommentWait({ quietSeconds: 0, maxWaitSeconds: 0, reviewWaitMaxSeconds: 4000 }),
    ).toThrow("reviewWaitMaxSeconds");
    expect(() => parseCommentWait({ quietSeconds: 90, maxWaitSeconds: 60 })).toThrow(
      "at least the quiet time",
    );
    expect(() => parseCommentWait({ quietSeconds: 1.5, maxWaitSeconds: 60 })).toThrow(
      "whole number of seconds",
    );
    expect(() => parseCommentWait({ quietSeconds: 60, maxWaitSeconds: 3601 })).toThrow(
      "from 0 to 3600",
    );
    expect(() => parseCommentWait({ quietSeconds: 60, maxWaitSeconds: 60, extra: 1 })).toThrow(
      "unknown key",
    );
  });

  test("unknown choices are rejected", () => {
    expect(() => parseConfigToml('[merge]\norder = "fast"\n')).toThrow("merge.order");
  });
});

function fixture() {
  const configPath = join(tempHome(), "config.toml");
  const audits: [string, string][] = [];
  const options: MergeSettingsOptions = {
    configPath,
    csrfToken: "test-token",
    audit: async (action, subject) => {
      audits.push([action, subject]);
    },
  };
  return { options, audits };
}

function request(method = "GET", body?: unknown, csrf = "test-token") {
  return new Request("http://127.0.0.1:8787/api/settings/merging", {
    method,
    headers: { "Content-Type": "application/json", "x-paws-csrf": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Merging settings API", () => {
  test("GET returns the defaults", async () => {
    const { options } = fixture();
    const response = await handleMergeSettingsRequest(request(), options);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      autoApproveHighRisk: false,
      commentWait: { quietSeconds: 60, maxWaitSeconds: 300, reviewWaitMaxSeconds: 900 },
      default: { order: "queue", mainMoved: "ci" },
      highRiskPaths: [],
      highRiskRepositories: [],
      ignoredComments: [],
    });
  });

  test("each main_moved value saves and reads back, and saving the unchanged page succeeds", async () => {
    for (const value of MAIN_MOVED) {
      const { options } = fixture();
      const body = { default: { order: "queue", mainMoved: value } };
      expect((await handleMergeSettingsRequest(request("PUT", body), options))?.status).toBe(200);
      const read = (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
        default: unknown;
      };
      expect(read).toMatchObject(body);
      const again = { default: read.default };
      expect((await handleMergeSettingsRequest(request("PUT", again), options))?.status).toBe(200);
    }
    // A fresh page shows the default and saves it unchanged.
    const { options } = fixture();
    const view = (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
      default: unknown;
    };
    expect(view.default).toEqual({ order: "queue", mainMoved: "ci" });
    const unchanged = { default: view.default };
    expect((await handleMergeSettingsRequest(request("PUT", unchanged), options))?.status).toBe(
      200,
    );
  });

  test("GET lists repositories where GitHub requires branches to be up to date", async () => {
    const { options } = fixture();
    const body = (await (await handleMergeSettingsRequest(request(), {
      ...options,
      upToDateRules: async () => ["acme/platform"],
    }))!.json()) as { upToDateRule?: string[] };
    expect(body.upToDateRule).toEqual(["acme/platform"]);
  });

  test("GET says whether high-risk pull requests wait for an approval in Paws", async () => {
    const { options } = fixture();
    const reason = "The risk gate is off: set PAWS_PUBLIC_URL.";
    const body = (await (await handleMergeSettingsRequest(request(), {
      ...options,
      riskGate: { on: false, reason },
    }))!.json()) as { riskGate?: unknown };
    expect(body.riskGate).toEqual({ on: false, reason });
  });

  test("PUT saves to config.toml, keeps other settings and audits each change", async () => {
    const { options, audits } = fixture();
    writeFileSync(
      options.configPath,
      `[caps]\nmax_turns = 31\n\n[merge]\nmain_moved = "closeout"\nci_fix_attempts = 5\n\n[merge.projects."${PAYMENTS}"]\norder = "github-queue"\n\n[[merge.rules]]\nlabel = "Bug"\nmain_moved = "overlap"\n\n[merge.repositories."acme/platform"]\npackages = ["apps/*"]\n\n[agents.defaults.implementer]\nagent = "claude"\n`,
    );
    const stored = (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
      default: unknown;
    };
    expect(stored.default).toEqual({ order: "queue", mainMoved: "closeout" });
    expect(Object.keys(stored)).not.toContainEqual("projects");
    expect(Object.keys(stored)).not.toContainEqual("rules");
    const body = { default: { order: "queue", mainMoved: "ci" } };
    const saved = await handleMergeSettingsRequest(request("PUT", body), options);
    expect(saved?.status).toBe(200);
    expect(await saved!.json()).toEqual({
      autoApproveHighRisk: false,
      ...body,
      commentWait: { quietSeconds: 60, maxWaitSeconds: 300, reviewWaitMaxSeconds: 900 },
      highRiskPaths: [],
      highRiskRepositories: [],
      ignoredComments: [],
    });
    const text = readFileSync(options.configPath, "utf8");
    expect(text).toContain("max_turns = 31");
    expect(text).toContain('[agents.defaults.implementer]\nagent = "claude"');
    expect(text).not.toContain("[merge.projects.");
    expect(text).not.toContain("[[merge.rules]]");
    const config = loadConfigFile(options.configPath);
    expect(readMergeSettings(config)).toEqual({
      default: { order: "queue", mainMoved: "ci" },
      repositories: { "acme/platform": { packages: ["apps/*"] } },
      lane: "project",
      projectLanes: {},
      autoApproveHighRisk: false,
      ciFixAttempts: 5,
      commentWait: { quietSeconds: 60, maxWaitSeconds: 300, reviewWaitMaxSeconds: 900 },
    });
    expect(audits).toEqual([
      [
        "settings.merging",
        "Workspace default when main moved: Always update the branch and run Closeout again → Always update the branch and wait for CI",
      ],
    ]);

    // Saving the same settings again is not a change.
    await handleMergeSettingsRequest(request("PUT", body), options);
    expect(audits).toHaveLength(1);
  });

  test("PUT saves high-risk paths per repository and a body without them keeps them", async () => {
    const { options, audits } = fixture();
    writeFileSync(
      options.configPath,
      '[merge.repositories."acme/platform"]\npackages = ["apps/*"]\nignore_comment_bots = ["codecov[bot]"]\n',
    );
    const valid = { default: { order: "queue", mainMoved: "closeout" } };
    const saved = await handleMergeSettingsRequest(
      request("PUT", {
        ...valid,
        highRiskPaths: [
          { repository: "acme/platform", paths: ["src/auth/**", " .github/workflows/** "] },
          { repository: "acme/web", paths: ["infra/**"] },
        ],
      }),
      options,
    );
    expect(saved?.status).toBe(200);
    const expected = [
      { repository: "acme/platform", paths: ["src/auth/**", ".github/workflows/**"] },
      { repository: "acme/web", paths: ["infra/**"] },
    ];
    expect(((await saved!.json()) as { highRiskPaths: unknown }).highRiskPaths).toEqual(expected);
    expect(readMergeSettings(loadConfigFile(options.configPath)).repositories).toEqual({
      "acme/platform": {
        packages: ["apps/*"],
        ignoreCommentBots: ["codecov[bot]"],
        highRiskPaths: ["src/auth/**", ".github/workflows/**"],
      },
      "acme/web": { packages: [], highRiskPaths: ["infra/**"] },
    });
    expect(audits.filter(([, subject]) => subject.startsWith("High-risk"))).toEqual([
      [
        "settings.merging",
        "High-risk paths for acme/platform: none → src/auth/**, .github/workflows/**",
      ],
      ["settings.merging", "High-risk paths for acme/web: none → infra/**"],
    ]);

    // The page that does not send highRiskPaths keeps them.
    await handleMergeSettingsRequest(request("PUT", valid), options);
    const got = (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
      highRiskPaths: unknown;
    };
    expect(got.highRiskPaths).toEqual(expected);

    // An empty list removes a repository's paths.
    await handleMergeSettingsRequest(
      request("PUT", { ...valid, highRiskPaths: [{ repository: "acme/web", paths: [] }] }),
      options,
    );
    expect(readMergeSettings(loadConfigFile(options.configPath)).repositories).toEqual({
      "acme/platform": { packages: ["apps/*"], ignoreCommentBots: ["codecov[bot]"] },
      "acme/web": { packages: [] },
    });
    for (const riskPaths of [
      [{ repository: "acme/web", paths: ["!src/**"] }],
      [{ repository: "acme/web", paths: ["src/../x"] }],
      [{ repository: "nope", paths: [] }],
      [
        { repository: "acme/web", paths: [] },
        { repository: "ACME/web", paths: [] },
      ],
    ])
      expect(
        (
          await handleMergeSettingsRequest(
            request("PUT", { ...valid, highRiskPaths: riskPaths }),
            options,
          )
        )?.status,
      ).toBe(400);
  });

  test("High-risk paths list each repository with its settings and its file read-only", async () => {
    const { options } = fixture();
    writeFileSync(options.configPath, 'repo = "acme/platform"\n');
    const reads: string[] = [];
    const withFile: MergeSettingsOptions = {
      ...options,
      repos: ["acme/web", "ACME/Platform", "acme/docs"],
      highRiskFile: async (repo) => {
        reads.push(repo);
        if (repo === "acme/platform") return { commit: "a".repeat(40), paths: ["infra/**"] };
        if (repo === "acme/web") return { commit: "b".repeat(40), paths: null };
        if (repo === "acme/docs") throw new Error("git failed");
        return null;
      },
    };
    const valid = { default: { order: "queue", mainMoved: "closeout" } };
    const saved = await handleMergeSettingsRequest(
      request("PUT", {
        ...valid,
        highRiskPaths: [
          { repository: "acme/platform", paths: ["src/auth/**"] },
          { repository: "acme/api", paths: ["src/**"] },
        ],
      }),
      withFile,
    );
    const expected = [
      {
        repository: "acme/api",
        paths: ["src/**"],
        file: { state: "unavailable", reason: expect.stringContaining("no copy") },
      },
      {
        repository: "acme/docs",
        paths: [],
        file: { state: "unavailable", reason: "Paws could not read .paws/high-risk-paths." },
      },
      {
        repository: "acme/platform",
        paths: ["src/auth/**"],
        file: { state: "present", commit: "a".repeat(40), paths: ["infra/**"] },
      },
      { repository: "acme/web", paths: [], file: { state: "missing", commit: "b".repeat(40) } },
    ];
    expect(
      ((await saved!.json()) as { highRiskRepositories: unknown }).highRiskRepositories,
    ).toEqual(expected);
    const reloaded = (await (await handleMergeSettingsRequest(request(), withFile))!.json()) as {
      highRiskRepositories: unknown;
    };
    expect(reloaded.highRiskRepositories).toEqual(expected);
    expect(reads.filter((repo) => repo === "acme/platform")).toHaveLength(2);
  });

  test("PUT saves the comment wait, audits it, and a body without it keeps it", async () => {
    const { options, audits } = fixture();
    writeFileSync(options.configPath, "max_turns = 31\n");
    const valid = { default: { order: "queue", mainMoved: "ci" } };
    const read = async () =>
      (
        (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
          commentWait: unknown;
        }
      ).commentWait;
    expect(await read()).toEqual({
      quietSeconds: 60,
      maxWaitSeconds: 300,
      reviewWaitMaxSeconds: 900,
    });

    const saved = await handleMergeSettingsRequest(
      request("PUT", { ...valid, commentWait: { quietSeconds: 120, maxWaitSeconds: 900 } }),
      options,
    );
    expect(saved?.status).toBe(200);
    expect(((await saved!.json()) as { commentWait: unknown }).commentWait).toEqual({
      quietSeconds: 120,
      maxWaitSeconds: 900,
      reviewWaitMaxSeconds: 900,
    });
    const text = readFileSync(options.configPath, "utf8");
    expect(text).toContain("max_turns = 31");
    expect(text).toContain("comment_quiet_seconds = 120\ncomment_max_wait_seconds = 900");
    expect(audits).toContainEqual([
      "settings.merging",
      "Pull request comment wait: 60s quiet, 300s at most → 120s quiet, 900s at most",
    ]);

    expect((await handleMergeSettingsRequest(request("PUT", valid), options))?.status).toBe(200);
    expect(await read()).toEqual({
      quietSeconds: 120,
      maxWaitSeconds: 900,
      reviewWaitMaxSeconds: 900,
    });

    const review = { quietSeconds: 120, maxWaitSeconds: 900, reviewWaitMaxSeconds: 1200 };
    await handleMergeSettingsRequest(request("PUT", { ...valid, commentWait: review }), options);
    expect(await read()).toEqual(review);
    expect(readFileSync(options.configPath, "utf8")).toContain("review_wait_max_seconds = 1200");
    expect(audits).toContainEqual([
      "settings.merging",
      "Review check wait: 900s at most → 1200s at most",
    ]);
    await handleMergeSettingsRequest(
      request("PUT", { ...valid, commentWait: { quietSeconds: 60, maxWaitSeconds: 300 } }),
      options,
    );
    expect(await read()).toEqual({
      quietSeconds: 60,
      maxWaitSeconds: 300,
      reviewWaitMaxSeconds: 1200,
    });

    const invalid = await handleMergeSettingsRequest(
      request("PUT", { ...valid, commentWait: { quietSeconds: 600, maxWaitSeconds: 60 } }),
      options,
    );
    expect(invalid?.status).toBe(400);
    expect(((await invalid!.json()) as { error: string }).error).toContain(
      "at least the quiet time",
    );
  });

  test("PUT rejects invalid settings and a missing CSRF token", async () => {
    const { options, audits } = fixture();
    const valid = { default: { order: "queue", mainMoved: "ci" } };
    for (const body of [
      { ...valid, default: { order: "fast", mainMoved: "ci" } },
      { ...valid, projects: [{ id: PAWS }] },
      { ...valid, rules: [{ label: "Bug" }] },
      { ...valid, extra: true },
    ])
      expect((await handleMergeSettingsRequest(request("PUT", body), options))?.status).toBe(400);
    expect(
      (await handleMergeSettingsRequest(request("PUT", valid, "wrong"), options))?.status,
    ).toBe(403);
    expect(audits).toEqual([]);
  });

  test("GET lists the repositories whose main has a GitHub merge queue", async () => {
    const { options } = fixture();
    const queue = createFakeMergeQueue({ branches: ["main"] });
    const client: GitHubClient = {
      async request(req) {
        const body = req.body as { variables?: { repo?: string } };
        // Only acme/platform has a merge queue on main.
        if (body?.variables?.repo === "web") {
          queue.branches.clear();
          const answer = await queue.respond(req);
          queue.branches.add("main");
          return answer!;
        }
        return (await queue.respond(req)) ?? { status: 404, body: {} };
      },
    };
    options.githubQueues = (signal) =>
      repositoriesWithMergeQueue({
        repositories: [
          { owner: "acme", repo: "platform" },
          { owner: "acme", repo: "web" },
        ],
        client,
        signal,
        token: async () => "ghs_test",
      });
    const body = (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
      githubQueue: unknown;
    };
    expect(body.githubQueue).toEqual({ repositories: ["acme/platform"] });
  });

  test("a workspace whose repositories have no GitHub merge queue cannot choose it", async () => {
    const { options, audits } = fixture();
    options.githubQueues = async () => [];
    const body = (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
      githubQueue: unknown;
    };
    expect(body.githubQueue).toEqual({ repositories: [] });
    const choice = {
      default: { order: "github-queue", mainMoved: "ci" },
    };
    const refused = await handleMergeSettingsRequest(request("PUT", choice), options);
    expect(refused?.status).toBe(400);
    expect(((await refused!.json()) as { error: string }).error).toContain(
      "No configured repository has a GitHub merge queue",
    );
    expect(audits).toEqual([]);
    // A failed check does not block the save; GitHub is read again when the task merges.
    options.githubQueues = async () => {
      throw new Error("offline");
    };
    expect((await handleMergeSettingsRequest(request("PUT", choice), options))?.status).toBe(200);
    const failed = await (await handleMergeSettingsRequest(request(), options))!.json();
    expect(failed).toMatchObject({ githubQueue: null, githubQueueError: expect.any(String) });
  });
});

test("automatic high-risk approval defaults off, round-trips, and old clients preserve it", async () => {
  const { options, audits } = fixture();
  options.riskGate = { on: true };
  expect(readMergeSettings(parseConfigToml("")).autoApproveHighRisk).toBe(false);
  const body = { default: { order: "queue", mainMoved: "ci" } };
  for (const enabled of [true, false]) {
    const response = await handleMergeSettingsRequest(
      request("PUT", { ...body, autoApproveHighRisk: enabled }),
      options,
    );
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as { autoApproveHighRisk: boolean }).autoApproveHighRisk).toBe(
      enabled,
    );
    expect(readFileSync(options.configPath, "utf8")).toContain(
      `auto_approve_high_risk = ${enabled}`,
    );
    expect(readMergeSettings(loadConfigFile(options.configPath)).autoApproveHighRisk).toBe(enabled);
    await handleMergeSettingsRequest(request("PUT", body), options);
    expect(
      (
        (await (await handleMergeSettingsRequest(request(), options))!.json()) as {
          autoApproveHighRisk: boolean;
        }
      ).autoApproveHighRisk,
    ).toBe(enabled);
  }
  options.riskGate = { on: false };
  const put = (enabled: boolean) =>
    handleMergeSettingsRequest(request("PUT", { ...body, autoApproveHighRisk: enabled }), options);
  const saved = readFileSync(options.configPath, "utf8");
  const auditCount = audits.length;
  expect((await put(true))?.status).toBe(400);
  expect(readFileSync(options.configPath, "utf8")).toBe(saved);
  expect(audits).toHaveLength(auditCount);
  writeFileSync(options.configPath, "[merge]\nauto_approve_high_risk = true\n");
  expect((await put(true))?.status).toBe(200);
  expect((await put(false))?.status).toBe(200);
  expect(readMergeSettings(loadConfigFile(options.configPath)).autoApproveHighRisk).toBe(false);
  expect(audits.map(([, text]) => text)).toContain("Automatic high-risk approval: on");
  expect(audits.map(([, text]) => text)).toContain("Automatic high-risk approval: off");
  for (const invalid of ["true", 1, null]) {
    expect(
      (
        await handleMergeSettingsRequest(
          request("PUT", { ...body, autoApproveHighRisk: invalid }),
          options,
        )
      )?.status,
    ).toBe(400);
  }
  expect(() => parseConfigToml('[merge]\nauto_approve_high_risk = "true"\n')).toThrow();
});

test("a failed display notification does not undo a settings write or its audit", async () => {
  const { options, audits } = fixture();
  options.changed = () => {
    throw new Error("display unavailable");
  };
  options.riskGate = { on: true };
  const response = await handleMergeSettingsRequest(
    request("PUT", {
      default: { order: "queue", mainMoved: "ci" },
      autoApproveHighRisk: true,
    }),
    options,
  );
  expect(response?.status).toBe(200);
  expect(readMergeSettings(loadConfigFile(options.configPath)).autoApproveHighRisk).toBe(true);
  expect(audits).toContainEqual(["settings.merging", "Automatic high-risk approval: on"]);
});
