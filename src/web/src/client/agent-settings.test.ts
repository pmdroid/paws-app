import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog, AgentSettings } from "../agent-settings";
import { renderAgentSettings, settingsProblems, settingsRequest } from "./agent-settings";
import { render } from "./render";
import { parseRoute, routeHref } from "./route";

function settings(): AgentSettings {
  return {
    defaults: {
      implementer: { agent: "claude", model: null },
      reviewer: { agent: "codex", model: "gpt-5.4" },
    },
    projects: [{ repo: "pmdroid/barkvisor" }],
  };
}

function view(data: AgentSettings | null = settings()) {
  const catalogs: AgentModelCatalog[] = [
    {
      agent: "claude",
      updatedAt: 1,
      efforts: [{ id: "high", name: "High" }],
      models: [{ id: "sonnet", name: "Sonnet", efforts: [{ id: "high", name: "High" }] }],
    },
    {
      agent: "codex",
      updatedAt: 1,
      efforts: [{ id: "medium", name: "Medium" }],
      models: [
        { id: "gpt-5.4", name: "GPT 5.4", efforts: [{ id: "high", name: "High" }] },
        {
          id: "another-model",
          name: "Another model",
          efforts: [{ id: "xhigh", name: "Extra high" }],
        },
      ],
    },
  ];
  return { data, busy: null, error: null, saved: false, catalogs };
}

describe("agent settings", () => {
  test("global defaults and effective project overrides must have independent profiles", () => {
    const data = settings();
    expect(settingsProblems(data)).toEqual([]);
    data.projects[0]!.reviewer = { agent: "claude", model: null };
    expect(settingsProblems(data)).toEqual([
      "pmdroid/barkvisor: choose a different reviewer agent or model for independent review.",
    ]);
    data.projects[0]!.reviewer.model = "another-model";
    expect(settingsProblems(data)).toEqual([]);
    data.defaults.reviewer = { ...data.defaults.implementer };
    expect(settingsProblems(data)[0]).toStartWith("Global defaults:");
  });

  test("settings remain reachable before any status items exist", () => {
    expect(parseRoute("/settings")).toEqual({ view: "settings" });
    expect(routeHref({ view: "settings" })).toBe("/settings");
    const rendered = render({
      route: { view: "settings" },
      phase: "loading",
      snapshot: null,
      via: null,
      error: null,
      engineUrl: "http://localhost:8787",
      selectedCheck: null,
    });
    expect(rendered.content).toContain('id="agent-settings"');
  });

  test("rendering explains inheritance and preserves empty model as agent default", () => {
    const html = renderAgentSettings(view());
    expect(html).toContain('name="0-reviewer-inherit" checked');
    expect(html).toContain('name="0-reviewer-agent" disabled');
    expect(html).toContain('<option value="" selected>Agent default</option>');
    expect(html).toContain('<select id="defaults-implementer-model"');
    expect(html).toContain('class="settings-roles"');
    expect(html).toContain("Agents run on an installed runner");
    expect(html).toContain('href="/runners"');
    expect(html).not.toContain("Test connection");
    expect(html).not.toContain("API key");
    const data = settings();
    data.defaults.reviewer = { ...data.defaults.implementer };
    expect(renderAgentSettings(view(data))).toContain('type="submit" disabled');
  });

  test("saved effort stays in the field and inherited roles stay locked", () => {
    const state = view();
    state.data!.defaults.reviewer.effort = "high";
    const saved = renderAgentSettings(state);
    expect(saved).toContain('<option value="high" selected>High</option>');
    expect(saved).toContain('id="0-reviewer-effort" name="0-reviewer-effort" disabled');
    expect(saved).not.toContain("Test connection");
  });

  test("effort choices follow the cached selected model", () => {
    const state = view();
    state.data!.defaults.reviewer.model = "another-model";
    const html = renderAgentSettings(state);
    const effort = html.match(/<select id="defaults-reviewer-effort"[\s\S]*?<\/select>/)?.[0];
    expect(effort).toContain('<option value="xhigh" >Extra high</option>');
    expect(effort).not.toContain('<option value="high"');
  });

  test("missing catalogs retain saved choices and show a sign-in action", () => {
    const state = view();
    state.catalogs = [];
    const html = renderAgentSettings(state);
    expect(html).toContain('id="defaults-reviewer-model" name="defaults-reviewer-model" disabled');
    expect(html).toContain('<option value="gpt-5.4" selected>gpt-5.4</option>');
    expect(html).toContain("Sign in on a runner to load model choices.");
  });

  test("persisted values escape untrusted text", () => {
    const state = view();
    state.data!.projects[0]!.repo = '<img src=x onerror="alert(1)">';
    state.data!.defaults.reviewer.model = "<script>";
    state.data!.defaults.reviewer.effort = '<bad"effort>';
    const html = renderAgentSettings(state);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;bad&quot;effort&gt;");
  });

  test("load errors give retry and a busy form cannot be edited", () => {
    expect(renderAgentSettings({ ...view(null), error: "Engine unavailable" })).toContain(
      'data-settings="reload"',
    );
    expect(renderAgentSettings({ ...view(), busy: "Saving agent settings…" })).toContain(
      'class="settings-fields" disabled',
    );
    expect(renderAgentSettings({ ...view(), saved: true })).toContain("Agent settings saved");
  });

  test("requests use the selected engine and protect mutations with CSRF", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(settings());
    }) as typeof fetch;
    await settingsRequest("http://localhost:8787/api/status", "GET", undefined, "", fake);
    await settingsRequest("http://localhost:8787", "PUT", settings(), "csrf-token", fake);
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8787/api/settings/agents",
      "http://localhost:8787/api/settings/agents",
    ]);
    expect(calls[1]!.init!.headers).toMatchObject({ "x-paws-csrf": "csrf-token" });
    expect(calls[1]!.init!.method).toBe("PUT");
    const failing = (async () =>
      Response.json(
        { error: "Settings could not be saved" },
        { status: 503 },
      )) as unknown as typeof fetch;
    await expect(
      settingsRequest("http://localhost:8787", "PUT", settings(), "csrf", failing),
    ).rejects.toThrow("Settings could not be saved");
  });
});
