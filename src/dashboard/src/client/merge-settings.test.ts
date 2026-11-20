import { describe, expect, test } from "bun:test";
import type { MergeSettingsView } from "../merge-settings";
import {
  ciFixProblem,
  conflictChecksFor,
  conflictProneProblem,
  mergeSettingsBody,
  mergeSettingsRequest,
  fieldProblem,
  markerLines,
  renderMergeSettings,
  riskGlobs,
} from "./merge-settings";
import { parseRoute } from "./route";
import { WORKSPACE_PAGES } from "./settings-pages";

function data(): MergeSettingsView {
  return {
    default: { order: "queue", mainMoved: "overlap" },
  };
}

describe("Settings → Merging", () => {
  test("is a workspace page after Agents", () => {
    expect(WORKSPACE_PAGES.map((page) => page.id).indexOf("merging")).toBe(2);
    expect(parseRoute("/workspace/merging")).toEqual({ view: "workspace", page: "merging" });
  });

  test("shows one Merging section and no Projects or Issue rules", () => {
    const html = renderMergeSettings({ data: data(), busy: null, error: null, saved: false });
    expect(html).toContain("<h2>Merging</h2>");
    expect(html).toContain("Used by every project.");
    for (const gone of ["Workspace default", "Projects", "Issue rules", "issue rule"])
      expect(html).not.toContain(gone);
    expect(html).not.toContain("inherit");
    expect(html).toContain("“Require branches to be up to date” rule off");
  });

  test("offers the GitHub merge queue only when a repository has one", () => {
    const render = (view: Partial<MergeSettingsView>) =>
      renderMergeSettings({ data: { ...data(), ...view }, busy: null, error: null, saved: false });
    const without = render({ githubQueue: { repositories: [] } });
    expect(without).not.toContain('value="github-queue"');
    expect(render({ githubQueue: null, githubQueueError: "Paws could not check." })).toContain(
      "Paws could not check.",
    );
    expect(render({})).not.toContain('value="github-queue"');
    const offered = render({ githubQueue: { repositories: ["acme/platform"] } });
    expect(offered).toContain(
      '<option value="github-queue" >Add to the GitHub merge queue</option>',
    );
    // A level that already uses it keeps it, and says the repositories fall back.
    const kept = render({
      default: { order: "github-queue", mainMoved: "ci" },
      githubQueue: { repositories: [] },
    });
    expect(kept).toContain('<option value="github-queue" selected>');
    expect(kept).toContain("No configured repository has a GitHub merge queue");
    const help = render({
      default: { order: "github-queue", mainMoved: "ci" },
      githubQueue: { repositories: ["acme/platform"] },
    });
    expect(help).toContain("GitHub&#39;s merge queue on acme/platform.");
  });

  test("says where GitHub's up-to-date rule makes overlap-only updates fall back", () => {
    const html = renderMergeSettings({
      data: { ...data(), upToDateRule: ["acme/platform"] },
      busy: null,
      error: null,
      saved: false,
    });
    expect(html).toContain(
      "GitHub requires branches to be up to date in acme/platform, so merges there always update the branch and wait for CI.",
    );
  });

  test("says why high-risk approval is off on a Paws without an https link", () => {
    const off = renderMergeSettings({
      data: {
        ...data(),
        riskGate: { on: false, reason: "The risk gate is off: set PAWS_PUBLIC_URL." },
      },
      busy: null,
      error: null,
      saved: false,
    });
    expect(off).toContain("High-risk approval");
    expect(off).toContain("The risk gate is off: set PAWS_PUBLIC_URL.");
    const on = renderMergeSettings({
      data: { ...data(), riskGate: { on: true } },
      busy: null,
      error: null,
      saved: false,
    });
    expect(on).toContain("waits for an approval on its issue page in Paws");
    expect(
      renderMergeSettings({ data: data(), busy: null, error: null, saved: false }),
    ).not.toContain("High-risk approval");
  });

  test("saves project lanes but no retired rules, with the CSRF token", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: URL, init: RequestInit) => {
      sent = { url: String(url), init };
      return Response.json(JSON.parse(String(init.body)));
    }) as unknown as typeof fetch;
    const old = {
      ...data(),
      projects: { "p-paws": { lane: "repository" as const } },
      rules: [{ label: "Bug" }],
    };
    const body = mergeSettingsBody(old);
    expect(await mergeSettingsRequest("http://127.0.0.1:8787", "PUT", body, "csrf", fake)).toEqual(
      body,
    );
    expect(sent!.url).toBe("http://127.0.0.1:8787/api/settings/merging");
    expect(JSON.parse(String(sent!.init.body))).toEqual({
      default: data().default,
      projects: old.projects,
    });
    expect((sent!.init.headers as Record<string, string>)["x-paws-csrf"]).toBe("csrf");
  });

  test("High-risk paths: each repository's settings are editable and its file is read-only", () => {
    const html = renderMergeSettings({
      data: {
        ...data(),
        highRiskRepositories: [
          {
            repository: "acme/platform",
            paths: ["src/auth/**", ".github/workflows/**"],
            file: { state: "present", commit: "a1b2c3d4e5", paths: ["infra/**"] },
          },
          { repository: "acme/web", paths: [], file: { state: "missing", commit: "b".repeat(40) } },
          {
            repository: "acme/docs",
            paths: [],
            file: { state: "unavailable", reason: "Paws has no copy of this repository yet." },
          },
        ],
      },
      busy: null,
      error: null,
      saved: false,
    });
    expect(html).toContain("<h2>High-risk paths</h2>");
    expect(html).toContain("<h3>acme/platform</h3>");
    expect(html).toMatch(
      /<textarea id="risk-0" name="risk-0"[^>]*>src\/auth\/\*\*\n\.github\/workflows\/\*\*<\/textarea>/,
    );
    const file = html.slice(
      html.indexOf("<h3>acme/platform</h3>"),
      html.indexOf("<h3>acme/web</h3>"),
    );
    expect(file).toContain('<ul class="risk-file"><li><code>infra/**</code></li></ul>');
    expect(file).toContain('at <span class="mono">a1b2c3d</span>. Change it in the repository.');
    // The file's globs are not in an editable field.
    expect(file).not.toMatch(/<(?:textarea|input)[^>]*>[^<]*infra/);
    expect(html).toContain(
      'No file on <span class="mono">origin/main</span> at <span class="mono">bbbbbbb</span>.',
    );
    expect(html).toContain("Paws has no copy of this repository yet.");
  });

  test("Pull request comments: the wait is editable and saved; an engine without it leaves it out", () => {
    const view = { ...data(), commentWait: { quietSeconds: 90, maxWaitSeconds: 600 } };
    const html = renderMergeSettings({ data: view, busy: null, error: null, saved: false });
    expect(html).toContain("<h2>Pull request comments</h2>");
    expect(html).toContain('name="comment-quiet" type="number"');
    expect(html).toContain('value="90"');
    expect(html).toContain('name="comment-max" type="number"');
    expect(html).toContain('value="600"');
    expect(mergeSettingsBody(view).commentWait).toEqual({ quietSeconds: 90, maxWaitSeconds: 600 });

    const without = renderMergeSettings({ data: data(), busy: null, error: null, saved: false });
    expect(without).not.toContain("Pull request comments");
    expect(mergeSettingsBody(data())).not.toHaveProperty("commentWait");
  });

  test("Pull request checks: CI fix attempts follow Pull request comments, 3 when missing", () => {
    const view = { ...data(), commentWait: { quietSeconds: 90, maxWaitSeconds: 600 } };
    const ciFix = { attempts: 3, stored: 3 };
    const html = renderMergeSettings({ data: view, busy: null, error: null, saved: false, ciFix });
    expect(html).toContain("<h2>Pull request checks</h2>");
    expect(html.indexOf("<h2>Pull request comments</h2>")).toBeLessThan(
      html.indexOf("<h2>Pull request checks</h2>"),
    );
    expect(html.indexOf("<h2>Pull request checks</h2>")).toBeLessThan(
      html.indexOf('class="settings-actions"'),
    );
    expect(html).toContain('<label for="merge-ci-fix-attempts">CI fix attempts</label>');
    expect(html).toMatch(
      /name="merge-ci-fix-attempts" type="number"[^>]*min="0" max="10"[^>]*value="3"/,
    );
    expect(html).toContain("With 0, Paws asks in Linear on the first failure.");
    expect(html).not.toContain('aria-invalid="true"');
    expect(mergeSettingsBody(view)).not.toHaveProperty("merge");

    const invalid = renderMergeSettings({
      data: data(),
      busy: null,
      error: null,
      saved: false,
      ciFix: { attempts: 11, stored: 3 },
    });
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain("CI fix attempts: enter a whole number from 0 to 10.");
    expect(ciFixProblem(0)).toBeNull();
    for (const attempts of [11, -1, 1.5, NaN])
      expect(ciFixProblem(attempts)).toBe("CI fix attempts: enter a whole number from 0 to 10.");

    const failed = renderMergeSettings({
      data: data(),
      busy: null,
      error: null,
      saved: false,
      ciFix: { error: "CI fix attempts could not be loaded. Reload to try again." },
    });
    expect(failed).toContain("<h2>Pull request checks</h2>");
    expect(failed).toContain("CI fix attempts could not be loaded.");
    expect(failed).not.toContain('name="merge-ci-fix-attempts"');
    expect(
      renderMergeSettings({ data: data(), busy: null, error: null, saved: false }),
    ).not.toContain("Pull request checks");
  });

  test("Ignored PR comments: both lists per repository, saved as sent, errors at the field", async () => {
    const view: MergeSettingsView = {
      ...data(),
      ignoredComments: [
        {
          repository: "acme/monorepo",
          ignoreCommentBots: ["codecov[bot]"],
          ignoreCommentMarkers: ["<!-- deploy-security-proof -->"],
        },
      ],
    };
    const html = renderMergeSettings({ data: view, busy: null, error: null, saved: false });
    expect(html).toContain("<h2>Ignored PR comments</h2>");
    expect(html).toMatch(/<textarea id="ignore-bots-0" name="ignore-bots-0"[^>]*>codecov\[bot\]</);
    expect(html).toContain(">&lt;!-- deploy-security-proof --&gt;</textarea>");
    expect(html).toContain(
      "Ignore every comment from this account. Use markers instead when the account also posts real failures.",
    );
    expect(html).toContain(
      "A comment that contains this text is ignored, for example <code>&lt;!-- deploy-security-proof --&gt;</code>.",
    );
    expect(mergeSettingsBody(view).ignoredComments).toEqual(view.ignoredComments);
    expect(mergeSettingsBody(data())).not.toHaveProperty("ignoredComments");
    expect(
      renderMergeSettings({ data: data(), busy: null, error: null, saved: false }),
    ).not.toContain("Ignored PR comments");

    const fake = (async () =>
      Response.json(
        {
          error: "ignoredComments.0.ignoreCommentMarkers.0 must not be empty",
          field: "ignoredComments.0.ignoreCommentMarkers",
        },
        { status: 400 },
      )) as unknown as typeof fetch;
    const failure = (await mergeSettingsRequest(
      "http://127.0.0.1:8787",
      "PUT",
      mergeSettingsBody(view),
      "csrf",
      fake,
    ).catch((error: unknown) => error)) as Error & { field?: string };
    expect(failure.field).toBe("ignoredComments.0.ignoreCommentMarkers");
    const failed = renderMergeSettings({
      data: view,
      busy: null,
      error: failure.message,
      field: failure.field!,
      saved: false,
    });
    expect(failed).toContain(
      'aria-describedby="ignore-markers-0-help ignore-markers-0-error" aria-invalid="true"',
    );
    expect(failed).toContain(
      '<small class="err" id="ignore-markers-0-error" role="alert">Line 1 must not be empty</small>',
    );
    expect(failed).not.toContain('id="ignore-bots-0-error"');
    expect(fieldProblem("ignoredComments.1.ignoreCommentBots lists more than 100 accounts")).toBe(
      "Lists more than 100 accounts",
    );
  });

  test("High-risk paths: an engine that does not list them leaves the section and body out", () => {
    const html = renderMergeSettings({ data: data(), busy: null, error: null, saved: false });
    expect(html).not.toContain("High-risk paths");
    expect(mergeSettingsBody(data())).not.toHaveProperty("highRiskPaths");
  });

  test("Comment markers keep their spaces and drop blank lines", () => {
    expect(markerLines(" Result: PASS \r\n\n  \n<!-- deploy-security-proof -->\n")).toEqual([
      " Result: PASS ",
      "<!-- deploy-security-proof -->",
    ]);
  });

  test("High-risk paths save every listed repository, one glob per line, and reload", async () => {
    expect(riskGlobs(" src/auth/**\r\n\n  infra/** \n")).toEqual(["src/auth/**", "infra/**"]);
    const view: MergeSettingsView = {
      ...data(),
      highRiskRepositories: [
        {
          repository: "acme/platform",
          paths: ["src/auth/**"],
          file: { state: "present", commit: "a".repeat(40), paths: ["infra/**"] },
        },
        { repository: "acme/web", paths: [], file: { state: "missing", commit: "b".repeat(40) } },
      ],
    };
    const body = mergeSettingsBody(view);
    expect(body.highRiskPaths).toEqual([
      { repository: "acme/platform", paths: ["src/auth/**"] },
      { repository: "acme/web", paths: [] },
    ]);
    // The engine answers with what it saved and the files it read; the page renders that.
    const fake = (async () =>
      Response.json({
        ...body,
        highRiskPaths: [{ repository: "acme/platform", paths: ["src/auth/**"] }],
        highRiskRepositories: view.highRiskRepositories,
      })) as unknown as typeof fetch;
    const saved = await mergeSettingsRequest("http://127.0.0.1:8787", "PUT", body, "csrf", fake);
    expect(saved.highRiskRepositories).toEqual(view.highRiskRepositories);
    const html = renderMergeSettings({ data: saved, busy: null, error: null, saved: true });
    expect(html).toMatch(/name="risk-0"[^>]*>src\/auth\/\*\*<\/textarea>/);
    expect(html).toContain("Merging settings saved.");
  });
});

test("Merging renders and submits the opt-in high-risk checkbox", () => {
  for (const enabled of [false, true]) {
    const view = { ...data(), autoApproveHighRisk: enabled, riskGate: { on: true } };
    const html = renderMergeSettings({ data: view, busy: null, error: null, saved: false });
    expect(html).toContain("Let high-risk changes through when both reviews are clean");
    expect(html).toContain(
      `aria-describedby="auto-approve-high-risk-help"${enabled ? " checked" : ""}>`,
    );
    expect(html).toContain("High-risk approval");
    expect(html).toContain("Closeout accepted the exact commit");
    expect(mergeSettingsBody(view).autoApproveHighRisk).toBe(enabled);
  }
});

test("automatic high-risk approval is disabled while the risk gate is off", () => {
  const html = renderMergeSettings({
    data: {
      ...data(),
      autoApproveHighRisk: true,
      riskGate: { on: false, reason: "HTTPS public URL required" },
    },
    busy: null,
    error: null,
    saved: false,
  });
  expect(html).toContain("checked disabled> Let high-risk");
  expect(html).toContain("Turn on the risk gate before changing this setting.");
});

describe("Conflict-prone files", () => {
  const file = (path: string, conflicts: number) => ({
    repository: "acme/platform",
    path,
    conflicts,
    items: ["PAS-1"],
  });
  const render = (hotFiles: MergeSettingsView["hotFiles"]) =>
    renderMergeSettings({ data: { ...data(), hotFiles }, busy: null, error: null, saved: false });

  test("explains the list and puts a held file first with links to the items", () => {
    const html = render([
      file("src/busy.ts", 5),
      { ...file("src/held.ts", 1), holds: [{ held: "PAS-3", holder: "PAS-2" }] },
    ]);
    expect(html).toContain(
      "These files caused merge conflicts in the last 7 days. Paws starts only one item at a time that changes them, so the next one doesn't hit the same conflict.",
    );
    expect(html).not.toContain("Read-only");
    expect(html.indexOf("src/held.ts")).toBeLessThan(html.indexOf("src/busy.ts"));
    expect(html).toContain(
      'Holding <a class="lin-id" href="/issues/PAS-3">PAS-3</a> until <a class="lin-id" href="/issues/PAS-2">PAS-2</a> merges',
    );
    expect(html).toContain('<a class="lin-id" href="/issues/PAS-1">PAS-1</a>');
    expect(html).toContain("1 conflict in 7 days");
    expect(html).toContain("5 conflicts in 7 days");
    expect(html).not.toContain("Show all");
  });

  test("shows ten files and a toggle for the rest", () => {
    const html = render(
      Array.from({ length: 12 }, (_, index) => file(`src/f${index}.ts`, 12 - index)),
    );
    expect(html).toContain("<summary>Show all 12</summary>");
    expect(html.indexOf("src/f9.ts")).toBeLessThan(html.indexOf("Show all"));
    expect(html.indexOf("src/f10.ts")).toBeGreaterThan(html.indexOf("Show all"));
  });

  test("each file has a hold toggle, a not-held file is greyed, and a migration journal has a note", () => {
    const html = renderMergeSettings({
      data: {
        ...data(),
        parallelFiles: [{ repository: "acme/platform", paths: ["src/index.ts"] }],
        hotFiles: [
          { ...file("src/index.ts", 4), held: false, holds: [{ held: "PAS-3", holder: "PAS-2" }] },
          { ...file("src/db/drizzle-pg/meta/_journal.json", 2), held: true },
        ],
      },
      busy: null,
      error: null,
      saved: false,
    });
    expect(html).toContain(
      '<input type="checkbox" name="hot-hold" data-repository="acme/platform" data-path="src/index.ts"> Hold work that changes this file</label><span class="sub">Not held</span>',
    );
    expect(html).toContain('<li class="hot-file opacity-60"><code>src/index.ts</code>');
    expect(html).not.toContain("Holding");
    expect(html).toContain(
      'data-path="src/db/drizzle-pg/meta/_journal.json" checked> Hold work that changes this file</label><p class="sub">Migrations made side by side need a manual rebase</p>',
    );
    expect(
      mergeSettingsBody({
        ...data(),
        parallelFiles: [{ repository: "acme/platform", paths: ["src/index.ts"] }],
      }).parallelFiles,
    ).toEqual([{ repository: "acme/platform", paths: ["src/index.ts"] }]);
  });

  test("an engine without parallel files shows the toggle disabled", () => {
    expect(render([file("src/index.ts", 1)])).toContain(" checked disabled> Hold work");
  });

  test("says nothing is held back without conflicts", () => {
    expect(render([])).toContain(
      "No file reached 2 conflicts in the last 7 days, so nothing is held back.",
    );
  });

  const rule = { overlapHold: true, conflictProneAfter: 3, conflictProneDays: 14 };
  const ruled = (view: Partial<MergeSettingsView>, field?: string, error?: string) =>
    renderMergeSettings({
      data: { ...data(), ...rule, ...view },
      busy: null,
      error: error ?? null,
      ...(field ? { field } : {}),
      saved: false,
    });

  test("the hold switch and the rule render with a list, an empty list and no list", () => {
    for (const hotFiles of [[file("src/index.ts", 3)], [], undefined]) {
      const html = ruled(hotFiles ? { hotFiles } : {});
      expect(html).toContain(
        '<input type="checkbox" name="overlap-hold" aria-describedby="merge-overlap-hold-help" checked> Hold work that changes conflict-prone files</label>',
      );
      expect(html).toContain(
        "On, a restart that changes one of these files waits until the other work on it has merged. Off, it does not wait for these files and is rebased if it conflicts.",
      );
      expect(html).toContain(
        '<label for="merge-conflict-prone-after">Conflicts before a file holds work</label>',
      );
      expect(html).toMatch(/id="merge-conflict-prone-after"[^>]*min="1" max="20"[^>]*value="3"/);
      expect(html).toContain(
        '<label for="merge-conflict-prone-days">Counted over the last (days)</label>',
      );
      expect(html).toMatch(/id="merge-conflict-prone-days"[^>]*min="1" max="30"[^>]*value="14"/);
      expect(html).toContain("These files caused merge conflicts in the last 14 days.");
    }
    expect(ruled({ hotFiles: [file("src/index.ts", 3)] })).toContain("3 conflicts in 14 days");
    expect(ruled({ hotFiles: [] })).toContain(
      "No file reached 3 conflicts in the last 14 days, so nothing is held back.",
    );
    expect(ruled({})).toContain("The conflict-prone files could not be listed.");
    expect(ruled({ overlapHold: false })).toContain(
      'aria-describedby="merge-overlap-hold-help"> Hold work that changes conflict-prone files',
    );
  });

  test("the save body carries the switch and both numbers", () => {
    expect(mergeSettingsBody({ ...data(), ...rule, overlapHold: false })).toMatchObject({
      overlapHold: false,
      conflictProneAfter: 3,
      conflictProneDays: 14,
    });
    for (const key of ["overlapHold", "conflictProneAfter", "conflictProneDays"])
      expect(mergeSettingsBody(data())).not.toHaveProperty(key);
  });

  test("with the switch off each file's toggle is disabled and keeps its value", () => {
    const html = ruled({
      overlapHold: false,
      parallelFiles: [{ repository: "acme/platform", paths: ["src/index.ts"] }],
      hotFiles: [
        { ...file("src/index.ts", 3), held: false },
        { ...file("src/busy.ts", 4), held: true },
      ],
    });
    expect(html).toContain('data-path="src/index.ts" disabled> Hold work that changes this file');
    expect(html).toContain('data-path="src/busy.ts" checked disabled> Hold work that changes');
    expect(
      ruled({
        parallelFiles: [],
        hotFiles: [{ ...file("src/busy.ts", 4), held: true }],
      }),
    ).toContain('data-path="src/busy.ts" checked> Hold work');
  });

  test("an out-of-range number is named under its field and blocks the save", () => {
    expect(conflictProneProblem({ ...data(), ...rule })).toBeNull();
    for (const [view, field, max] of [
      [{ conflictProneAfter: 21 }, "conflictProneAfter", 20],
      [{ conflictProneAfter: NaN }, "conflictProneAfter", 20],
      [{ conflictProneDays: 0 }, "conflictProneDays", 30],
      [{ conflictProneDays: 1.5 }, "conflictProneDays", 30],
    ] as const) {
      const problem = conflictProneProblem({ ...data(), ...rule, ...view });
      expect(problem).toEqual({ field, error: `${field} must be a whole number from 1 to ${max}` });
      const html = ruled(view, problem!.field, problem!.error);
      const id =
        field === "conflictProneAfter" ? "merge-conflict-prone-after" : "merge-conflict-prone-days";
      const other =
        field === "conflictProneAfter" ? "merge-conflict-prone-days" : "merge-conflict-prone-after";
      expect(html).toContain(`aria-describedby="${id}-help ${id}-error" aria-invalid="true"`);
      expect(html).toContain(
        `<small class="err" id="${id}-error" role="alert">Must be a whole number from 1 to ${max}</small>`,
      );
      expect(html).not.toContain(`id="${other}-error"`);
      expect(html).toContain("Fix the field marked under Conflict-prone files.");
    }
  });
});

test("Linear session controls render saved choices and save only applicable minutes", () => {
  for (const sessionDone of ["pull_request", "ci_green", "settled"] as const) {
    const settings = { ...data(), sessionDone, sessionQuietMinutes: 17 };
    const html = renderMergeSettings({ data: settings, busy: null, error: null, saved: false });
    expect(html).toContain(`value="${sessionDone}" checked`);
    expect(html.includes('name="session-quiet"')).toBe(sessionDone === "settled");
    expect(mergeSettingsBody(settings)).toMatchObject({
      sessionDone,
      ...(sessionDone === "settled" ? { sessionQuietMinutes: 17 } : {}),
    });
    if (sessionDone !== "settled")
      expect(mergeSettingsBody(settings)).not.toHaveProperty("sessionQuietMinutes");
  }
  const settings = { ...data(), sessionDone: "settled" as const };
  expect(mergeSettingsBody(settings).sessionQuietMinutes).toBe(10);
  expect(renderMergeSettings({ data: settings, busy: null, error: null, saved: false })).toContain(
    'min="1" max="120" step="1" required value="10"',
  );
});

test("repository settings round trip and render as editable controls", () => {
  const value: MergeSettingsView = {
    ...data(),
    repositories: {
      "acme/app": { packages: ["apps/*"], reviewApps: ["review-bot"], suggestedFindings: false },
    },
    projects: { abc: { lane: "repository" } },
  };
  expect(mergeSettingsBody(value)).toEqual(value);
  const html = renderMergeSettings({
    data: value,
    busy: null,
    error: null,
    saved: false,
  });
  expect(html).toContain('name="repo-packages-0" rows="3" spellcheck="false">apps/*</textarea>');
  expect(html).toContain('spellcheck="false">review-bot</textarea>');
  expect(html).toContain('<option value="off" selected>Off</option>');
  expect(html).toContain('<label for="project-lane-0">abc</label>');
  expect(html).toContain('<option value="repository" selected>Repository lane</option>');
});

describe("Checks after a conflict fix", () => {
  const view = (): MergeSettingsView => ({
    ...data(),
    highRiskRepositories: [
      {
        repository: "acme/platform",
        paths: [],
        file: { state: "missing", commit: "a".repeat(40) },
      },
      { repository: "acme/web", paths: [], file: { state: "missing", commit: "b".repeat(40) } },
    ],
    conflictChecks: [{ repository: "ACME/platform", ids: ["lint", "typecheck"] }],
  });

  test("one field per listed repository with the stored ids", () => {
    const html = renderMergeSettings({ data: view(), busy: null, error: null, saved: false });
    const section = html.slice(html.indexOf('id="merge-conflict-checks"'));
    expect(section).toContain("<h2>Checks after a conflict fix</h2>");
    expect(section).toContain(
      "When a restart only resolved a merge conflict, the agent and Closeout run just these checks, and both reviews. The other checks keep their result from before the conflict, and CI has to be green on the fixed commit. Leave empty to run every check.",
    );
    expect(section).toMatch(
      /<textarea id="conflict-checks-0" name="conflict-checks-0"[^>]*placeholder="lint&#10;typecheck"[^>]*>lint\ntypecheck<\/textarea>/,
    );
    expect(section).toMatch(
      /<textarea id="conflict-checks-1" name="conflict-checks-1"[^>]*><\/textarea>/,
    );
    expect(section).not.toContain("conflict-checks-2");
    const { conflictChecks: _, ...older } = view();
    expect(
      renderMergeSettings({ data: older, busy: null, error: null, saved: false }),
    ).not.toContain("merge-conflict-checks");
    expect(mergeSettingsBody(older)).not.toHaveProperty("conflictChecks");
  });

  test("the save body carries the edited lists and an emptied field sends an empty list", () => {
    const edited = view();
    const texts = ["", " lint \r\n\nproof\n"];
    edited.conflictChecks = conflictChecksFor(
      edited.highRiskRepositories!,
      [...edited.conflictChecks!, { repository: "acme/docs", ids: ["lint"] }],
      (index) => texts[index],
    );
    expect(mergeSettingsBody(edited).conflictChecks).toEqual([
      { repository: "acme/platform", ids: [] },
      { repository: "acme/web", ids: ["lint", "proof"] },
      { repository: "acme/docs", ids: ["lint"] },
    ]);
    expect(mergeSettingsBody(view()).conflictChecks).toEqual([
      { repository: "acme/platform", ids: ["lint", "typecheck"] },
      { repository: "acme/web", ids: [] },
    ]);
  });

  test("a rejected save shows the problem under the repository's field", () => {
    const failed = renderMergeSettings({
      data: view(),
      busy: null,
      error: "conflictChecks.1.ids.0 must be a Closeout check id such as lint or shared/lint",
      field: "conflictChecks.1",
      saved: false,
    });
    expect(failed).toContain(
      "Merging settings were not saved. Fix the field marked under Checks after a conflict fix.",
    );
    expect(failed).toContain(
      'aria-describedby="conflict-checks-1-help conflict-checks-1-error" aria-invalid="true"',
    );
    expect(failed).toContain(
      '<small class="err" id="conflict-checks-1-error" role="alert">Line 1 must be a Closeout check id such as lint or shared/lint</small>',
    );
    expect(failed).not.toContain('id="conflict-checks-0-error"');
    expect(fieldProblem("conflictChecks.0.ids lists a check twice")).toBe("Lists a check twice");
  });
});
