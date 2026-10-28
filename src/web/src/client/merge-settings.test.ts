import { describe, expect, test } from "bun:test";
import type { MergeSettingsView } from "../merge-settings";
import {
  mergeSettingsBody,
  mergeSettingsRequest,
  renderMergeSettings,
  riskGlobs,
} from "./merge-settings";
import { parseRoute } from "./route";
import { SETTINGS_PAGES } from "./settings-pages";

function data(): MergeSettingsView {
  return {
    default: { order: "queue", mainMoved: "overlap" },
    projects: [{ id: "p-paws" }, { id: "p-pay", order: "queue", mainMoved: "closeout" }],
    rules: [{ project: "p-paws", label: "Bug", mainMoved: "closeout" }, { label: "Chore" }],
    choices: {
      projects: [
        { id: "p-paws", name: "Paws" },
        { id: "p-pay", name: "Payments" },
        { id: "p-mono", name: "Monorepo" },
      ],
      labels: ["Bug", "Chore", "Feature"],
    },
  };
}

describe("Settings → Merging", () => {
  test("is a settings page after Agents", () => {
    expect(SETTINGS_PAGES.map((page) => page.id).slice(1, 3)).toEqual(["agents", "merging"]);
    expect(parseRoute("/settings/merging")).toEqual({ view: "settings", page: "merging" });
  });

  test("shows the default, projects by name and rules, with inherited choices disabled", () => {
    const html = renderMergeSettings({ data: data(), busy: null, error: null, saved: false });
    for (const heading of ["Workspace default", "Projects", "Issue rules"])
      expect(html).toContain(`<h2>${heading}</h2>`);
    expect(html).toContain("<h3>Paws</h3>");
    expect(html).toContain("<h3>Payments</h3>");
    expect(html).toContain("<h3>Paws · label Bug</h3>");
    expect(html).toContain("<h3>Any project · label Chore</h3>");
    expect(html).toMatch(/name="project-0-inherit" checked>Use workspace default/);
    expect(html).toMatch(/name="project-0-main"[^>]*disabled>/);
    expect(html).toMatch(/name="project-1-inherit" >/);
    // An inherited rule shows the project's choice; Chore in any project shows the default.
    expect(html).toMatch(/name="rule-1-main"[^>]*disabled><option value="overlap" selected>/);
    expect(html).toContain("“Require branches to be up to date” rule off");
    // Listed projects are not offered again.
    const picker = /<select id="merge-new-project"[^]*?<\/select>/.exec(html)![0];
    expect(picker).toContain(">Monorepo<");
    expect(picker).not.toContain(">Paws<");
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
    expect(html).toContain("A Closeout re-check starts with a fresh retry budget.");
  });

  test("falls back to typed project ids and labels when Linear choices are unavailable", () => {
    const html = renderMergeSettings({
      data: {
        ...data(),
        choices: null,
        choicesError: "Linear projects and labels could not be loaded.",
      },
      busy: null,
      error: null,
      saved: false,
    });
    expect(html).toContain('placeholder="Linear project id"');
    expect(html).toContain('placeholder="Linear label"');
    expect(html).toContain("Linear projects and labels could not be loaded.");
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
    expect(on).toContain("otherwise approve on the issue page in Paws");
    expect(renderMergeSettings({ data: data(), busy: null, error: null, saved: false })).toContain(
      "High-risk approval",
    );
  });

  test("members see why they cannot change it", () => {
    expect(
      renderMergeSettings({ data: null, busy: null, error: null, saved: false, denied: true }),
    ).toContain("Only workspace owners and admins");
  });

  test("saves without the Linear choices and with the CSRF token", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: URL, init: RequestInit) => {
      sent = { url: String(url), init };
      return Response.json(JSON.parse(String(init.body)));
    }) as unknown as typeof fetch;
    const body = mergeSettingsBody(data());
    expect(await mergeSettingsRequest("http://127.0.0.1:8787", "PUT", body, "csrf", fake)).toEqual(
      body,
    );
    expect(sent!.url).toBe("http://127.0.0.1:8787/api/settings/merging");
    expect(JSON.parse(String(sent!.init.body))).not.toHaveProperty("choices");
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

  test("High-risk paths: an engine that does not list them leaves the section and body out", () => {
    const html = renderMergeSettings({ data: data(), busy: null, error: null, saved: false });
    expect(html).not.toContain("High-risk paths");
    expect(mergeSettingsBody(data())).not.toHaveProperty("highRiskPaths");
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

test("automatic approval is checked by default and its off value is submitted", () => {
  const view = { ...data(), autoApproveHighRisk: false };
  expect(mergeSettingsBody(view).autoApproveHighRisk).toBe(false);
  expect(renderMergeSettings({ data: data(), busy: null, error: null, saved: false })).toContain(
    'name="auto-approve-high-risk" checked',
  );
  expect(renderMergeSettings({ data: view, busy: null, error: null, saved: false })).not.toContain(
    'name="auto-approve-high-risk" checked',
  );
});
