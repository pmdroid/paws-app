import { describe, expect, test } from "bun:test";
import type { MergeSettingsView } from "../merge-settings";
import { mergeSettingsBody, mergeSettingsRequest, renderMergeSettings } from "./merge-settings";
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
});
