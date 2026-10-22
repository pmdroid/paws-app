import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfigFile,
  parseConfigToml,
  readMergeSettings,
  resolveMergeSettings,
  type MergePolicy,
} from "../src/config";
import { handleMergeSettingsRequest, type MergeSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";

const PAWS = "843abf82-7a05-4340-b47b-2c81fe6e6e16";
const PAYMENTS = "4179d503-3ec3-4be7-a8ef-4415a2d9b5e9";

const policy: MergePolicy = {
  default: { order: "queue", mainMoved: "ci" },
  projects: {
    [PAWS]: {},
    [PAYMENTS]: { order: "github-queue", mainMoved: "overlap" },
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
      mainMoved: "overlap",
      sources: { order: "project", mainMoved: "project" },
    });
    // The project rule sets the order; its main-moved choice comes from the project.
    expect(resolveMergeSettings({ projectId: PAYMENTS, labels: ["BUG"] }, policy)).toEqual({
      order: "ci-green",
      mainMoved: "overlap",
      sources: { order: "rule", mainMoved: "project" },
      rule: { project: PAYMENTS, label: "bug" },
    });
    expect(resolveMergeSettings({ projectId: null, labels: [] }, policy)).toEqual({
      order: "queue",
      mainMoved: "ci",
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
`;
    const config = parseConfigToml(text);
    expect(config.maxTurns).toBe(40);
    expect(readMergeSettings(config)).toEqual({
      default: { order: "ci-green", mainMoved: "overlap" },
      projects: { [PAWS]: {}, [PAYMENTS]: { mainMoved: "closeout" } },
      rules: [
        { label: "Bug", order: "queue" },
        { project: PAYMENTS, label: 'Needs "care"' },
      ],
      ciFixAttempts: 2,
    });
  });

  test("the PAS-389 switch is the workspace default for when main moved", () => {
    expect(
      readMergeSettings(parseConfigToml("[merge]\ncloseout_after_update = true\n")).default,
    ).toEqual({ order: "queue", mainMoved: "closeout" });
    expect(readMergeSettings(parseConfigToml("")).default).toEqual({
      order: "queue",
      mainMoved: "ci",
    });
  });

  test("unknown choices are rejected", () => {
    expect(() => parseConfigToml('[merge]\norder = "fast"\n')).toThrow("merge.order");
    expect(() => parseConfigToml('[[merge.rules]]\nlabel = "Bug"\nmain_moved = "x"\n')).toThrow();
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
      default: { order: "queue", mainMoved: "ci" },
      projects: [],
      rules: [],
      choices: {
        projects: [
          { id: PAWS, name: "Paws" },
          { id: PAYMENTS, name: "Payments" },
        ],
        labels: ["Bug", "Feature"],
      },
    });
  });

  test("PUT saves to config.toml, keeps other settings and audits each change", async () => {
    const { options, audits } = fixture();
    writeFileSync(
      options.configPath,
      '[caps]\nmax_turns = 31\n\n[merge]\ncloseout_after_update = true\nci_fix_attempts = 5\n\n[agents.defaults.implementer]\nagent = "claude"\n',
    );
    const body = {
      default: { order: "queue", mainMoved: "ci" },
      projects: [{ id: PAWS }, { id: PAYMENTS, order: "github-queue", mainMoved: "overlap" }],
      rules: [{ label: "Bug", mainMoved: "closeout" }],
    };
    const saved = await handleMergeSettingsRequest(request("PUT", body), options);
    expect(saved?.status).toBe(200);
    expect(await saved!.json()).toEqual(body);
    const text = readFileSync(options.configPath, "utf8");
    expect(text).toContain("max_turns = 31");
    expect(text).toContain('[agents.defaults.implementer]\nagent = "claude"');
    expect(text).not.toContain("closeout_after_update");
    expect(text).toContain(`[merge.projects."${PAWS}"]\n`);
    expect(text).toContain('[[merge.rules]]\nlabel = "Bug"\nmain_moved = "closeout"');
    const config = loadConfigFile(options.configPath);
    expect(readMergeSettings(config)).toEqual({
      default: { order: "queue", mainMoved: "ci" },
      projects: { [PAWS]: {}, [PAYMENTS]: { order: "github-queue", mainMoved: "overlap" } },
      rules: [{ label: "Bug", mainMoved: "closeout" }],
      ciFixAttempts: 5,
    });
    expect(
      ((await (await handleMergeSettingsRequest(request(), options))!.json()) as { rules: unknown })
        .rules,
    ).toEqual(body.rules);
    expect(audits).toEqual([
      [
        "settings.merging",
        "Workspace default when main moved: Always update the branch and run Closeout again → Always update the branch and wait for CI",
      ],
      ["settings.merging", `Project ${PAWS} added`],
      ["settings.merging", `Project ${PAYMENTS} added`],
      [
        "settings.merging",
        `Project ${PAYMENTS} merge order: inherited → Add to the GitHub merge queue`,
      ],
      [
        "settings.merging",
        `Project ${PAYMENTS} when main moved: inherited → Update and re-test only when main changed the same files or package`,
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

  test("PUT rejects invalid settings and a missing CSRF token", async () => {
    const { options, audits } = fixture();
    const valid = { default: { order: "queue", mainMoved: "ci" }, projects: [], rules: [] };
    for (const body of [
      { ...valid, default: { order: "fast", mainMoved: "ci" } },
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

  test("GET still answers when Linear choices cannot be loaded", async () => {
    const { options } = fixture();
    options.choices = async () => {
      throw new Error("offline");
    };
    const body = await (await handleMergeSettingsRequest(request(), options))!.json();
    expect(body).toMatchObject({ choices: null, choicesError: expect.any(String) });
  });
});
