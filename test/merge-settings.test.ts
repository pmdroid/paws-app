import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_IGNORED_COMMENT_BOTS,
  ignoredCommentBots,
  loadConfigFile,
  parseConfigToml,
  readMergeSettings,
  highRiskPaths,
  repositoryPackages,
  resolveMergeSettings,
  type MergePolicy,
} from "../src/config";
import { createFakeMergeQueue, repositoriesWithMergeQueue, type GitHubClient } from "../src/github";
import { handleMergeSettingsRequest, type MergeSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";

const PAWS = "843abf82-7a05-4340-b47b-2c81fe6e6e16";
const PAYMENTS = "4179d503-3ec3-4be7-a8ef-4415a2d9b5e9";

const policy: MergePolicy = {
  default: { order: "queue", mainMoved: "closeout" },
  projects: {
    [PAWS]: {},
    [PAYMENTS]: { order: "github-queue", mainMoved: "closeout" },
  },
  rules: [
    { label: "Bug", mainMoved: "closeout" },
    { project: PAYMENTS, label: "bug", order: "ci-green" },
  ],
};

describe("resolveMergeSettings", () => {
  test("an issue rule wins over the project, which wins over the workspace default", () => {
    expect(resolveMergeSettings({ projectId: PAYMENTS, labels: ["Feature"] }, policy)).toEqual({
      order: "github-queue",
      mainMoved: "closeout",
      sources: { order: "project", mainMoved: "project" },
    });
    // The project rule sets the order; its main-moved choice comes from the project.
    expect(resolveMergeSettings({ projectId: PAYMENTS, labels: ["BUG"] }, policy)).toEqual({
      order: "ci-green",
      mainMoved: "closeout",
      sources: { order: "rule", mainMoved: "project" },
      rule: { project: PAYMENTS, label: "bug" },
    });
    expect(resolveMergeSettings({ projectId: null, labels: [] }, policy)).toEqual({
      order: "queue",
      mainMoved: "closeout",
      sources: { order: "default", mainMoved: "default" },
    });
  });

  test("a rule without a project matches its label in any project", () => {
    for (const projectId of [PAWS, "other-project", null])
      expect(resolveMergeSettings({ projectId, labels: ["Feature", "Bug"] }, policy)).toEqual({
        order: "queue",
        mainMoved: "closeout",
        sources: { order: "default", mainMoved: "rule" },
        rule: { label: "Bug" },
      });
  });

  test("a project that inherits the default uses the workspace default", () => {
    const changed = { ...policy, default: { order: "ci-green", mainMoved: "closeout" } } as const;
    expect(resolveMergeSettings({ projectId: PAWS, labels: [] }, changed)).toEqual({
      order: "ci-green",
      mainMoved: "closeout",
      sources: { order: "default", mainMoved: "default" },
    });
  });
});

describe("config.toml [merge]", () => {
  test("projects and rules round-trip next to the other settings", () => {
    const text = `[caps]
max_turns = 40

[merge]
order = "ci-green"
main_moved = "closeout"
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
    expect(config.maxTurns).toBe(40);
    expect(readMergeSettings(config)).toEqual({
      default: { order: "ci-green", mainMoved: "closeout" },
      projects: { [PAWS]: {}, [PAYMENTS]: { mainMoved: "closeout" } },
      rules: [
        { label: "Bug", order: "queue" },
        { project: PAYMENTS, label: 'Needs "care"' },
      ],
      repositories: { "acme/platform": { packages: ["apps/*", "packages/*"] } },
      ciFixAttempts: 2,
    });
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

  test("unknown choices are rejected", () => {
    expect(() => parseConfigToml('[merge]\norder = "fast"\n')).toThrow("merge.order");
    expect(() => parseConfigToml('[[merge.rules]]\nlabel = "Bug"\nmain_moved = "x"\n')).toThrow(
      'must be "closeout"',
    );
  });

  test('main_moved other than "closeout" is rejected with a message naming "closeout"', () => {
    const retired =
      /is no longer supported: Paws runs Closeout on every rebased head before it merges\. Set it to "closeout" or remove the key\./;
    for (const value of ["ci", "overlap"]) {
      expect(() => parseConfigToml(`[merge]\nmain_moved = "${value}"\n`)).toThrow(
        `config.toml line 2 merge.main_moved "${value}" is no longer supported`,
      );
      expect(() => parseConfigToml(`[merge]\nmain_moved = "${value}"\n`)).toThrow(retired);
      expect(() =>
        parseConfigToml(`[merge.projects."${PAWS}"]\nmain_moved = "${value}"\n`),
      ).toThrow(`config.toml merge.projects.${PAWS}.main_moved "${value}" is no longer supported`);
      expect(() =>
        parseConfigToml(`[[merge.rules]]\nlabel = "Bug"\nmain_moved = "${value}"\n`),
      ).toThrow(retired);
    }
  });

  test('a missing main_moved means "closeout"', () => {
    expect(readMergeSettings(parseConfigToml('[merge]\norder = "queue"\n')).default).toEqual({
      order: "queue",
      mainMoved: "closeout",
    });
  });
});

function fixture() {
  const configPath = join(tempHome(), "config.toml");
  const audits: [string, string][] = [];
  const options: MergeSettingsOptions = {
    configPath,
    csrfToken: "test-token",
    audit: (action, subject) => audits.push([action, subject]),
    choices: async () => ({
      projects: [
        { id: PAWS, name: "Paws" },
        { id: PAYMENTS, name: "Payments" },
      ],
      labels: ["Bug", "Feature"],
    }),
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
  test("GET returns the defaults and the Linear choices", async () => {
    const { options } = fixture();
    const response = await handleMergeSettingsRequest(request(), options);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      default: { order: "queue", mainMoved: "closeout" },
      projects: [],
      rules: [],
      highRiskPaths: [],
      choices: {
        projects: [
          { id: PAWS, name: "Paws" },
          { id: PAYMENTS, name: "Payments" },
        ],
        labels: ["Bug", "Feature"],
      },
    });
  });

  test("GET lists repositories where GitHub requires branches to be up to date", async () => {
    const { options } = fixture();
    const body = (await (await handleMergeSettingsRequest(request(), {
      ...options,
      upToDateRules: async () => ["acme/platform"],
    }))!.json()) as { upToDateRule?: string[] };
    expect(body.upToDateRule).toEqual(["acme/platform"]);
  });

  test("PUT saves to config.toml, keeps other settings and audits each change", async () => {
    const { options, audits } = fixture();
    writeFileSync(
      options.configPath,
      '[caps]\nmax_turns = 31\n\n[merge]\norder = "ci-green"\nci_fix_attempts = 5\n\n[merge.repositories."acme/platform"]\npackages = ["apps/*"]\n\n[agents.defaults.implementer]\nagent = "claude"\n',
    );
    const body = {
      default: { order: "queue", mainMoved: "closeout" },
      projects: [{ id: PAWS }, { id: PAYMENTS, order: "github-queue", mainMoved: "closeout" }],
      rules: [{ label: "Bug", mainMoved: "closeout" }],
    };
    const saved = await handleMergeSettingsRequest(request("PUT", body), options);
    expect(saved?.status).toBe(200);
    expect(await saved!.json()).toEqual({ ...body, highRiskPaths: [] });
    const text = readFileSync(options.configPath, "utf8");
    expect(text).toContain("max_turns = 31");
    expect(text).toContain('[agents.defaults.implementer]\nagent = "claude"');
    expect(text).toContain(`[merge.projects."${PAWS}"]\n`);
    expect(text).toContain('[[merge.rules]]\nlabel = "Bug"\nmain_moved = "closeout"');
    const config = loadConfigFile(options.configPath);
    expect(readMergeSettings(config)).toEqual({
      default: { order: "queue", mainMoved: "closeout" },
      projects: { [PAWS]: {}, [PAYMENTS]: { order: "github-queue", mainMoved: "closeout" } },
      rules: [{ label: "Bug", mainMoved: "closeout" }],
      repositories: { "acme/platform": { packages: ["apps/*"] } },
      ciFixAttempts: 5,
    });
    expect(
      ((await (await handleMergeSettingsRequest(request(), options))!.json()) as { rules: unknown })
        .rules,
    ).toEqual(body.rules);
    expect(audits).toEqual([
      [
        "settings.merging",
        "Workspace default merge order: Merge each pull request when its CI is green → Merge queue",
      ],
      ["settings.merging", `Project ${PAWS} added`],
      ["settings.merging", `Project ${PAYMENTS} added`],
      [
        "settings.merging",
        `Project ${PAYMENTS} merge order: inherited → Add to the GitHub merge queue`,
      ],
      [
        "settings.merging",
        `Project ${PAYMENTS} when main moved: inherited → Always update the branch and run Closeout again`,
      ],
      ["settings.merging", "Rule label Bug in any project added"],
      [
        "settings.merging",
        "Rule label Bug in any project when main moved: inherited → Always update the branch and run Closeout again",
      ],
    ]);

    // Saving the same settings again is not a change.
    await handleMergeSettingsRequest(request("PUT", body), options);
    expect(audits).toHaveLength(7);
  });

  test("PUT saves high-risk paths per repository and a body without them keeps them", async () => {
    const { options, audits } = fixture();
    writeFileSync(
      options.configPath,
      '[merge.repositories."acme/platform"]\npackages = ["apps/*"]\nignore_comment_bots = ["codecov[bot]"]\n',
    );
    const valid = { default: { order: "queue", mainMoved: "closeout" }, projects: [], rules: [] };
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

  test("PUT rejects invalid settings and a missing CSRF token", async () => {
    const { options, audits } = fixture();
    const valid = { default: { order: "queue", mainMoved: "closeout" }, projects: [], rules: [] };
    for (const body of [
      { ...valid, default: { order: "fast", mainMoved: "closeout" } },
      { ...valid, default: { order: "queue", mainMoved: "ci" } },
      { ...valid, projects: [{ id: PAWS, mainMoved: "overlap" }] },
      { ...valid, projects: [{ id: PAWS }, { id: PAWS }] },
      { ...valid, rules: [{ label: " " }] },
      { ...valid, rules: [{ label: "Bug" }, { label: "bug" }] },
      { ...valid, projects: [{ id: "../x" }] },
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
      default: { order: "github-queue", mainMoved: "closeout" },
      projects: [],
      rules: [],
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

  test("GET still answers when Linear choices cannot be loaded", async () => {
    const { options } = fixture();
    options.choices = async () => {
      throw new Error("offline");
    };
    const body = await (await handleMergeSettingsRequest(request(), options))!.json();
    expect(body).toMatchObject({ choices: null, choicesError: expect.any(String) });
  });
});
