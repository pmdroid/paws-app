import { describe, expect, test } from "bun:test";
import type { AgentSettings } from "../agent-settings";
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
  return { data, busy: null, error: null, saved: false, connections: new Map() };
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
    expect(parseRoute("#/settings")).toEqual({ view: "settings" });
    expect(routeHref({ view: "settings" })).toBe("#/settings");
    const rendered = render({
      route: { view: "settings" },
      phase: "loading",
      snapshot: null,
      via: null,
      error: null,
      engineUrl: "http://localhost:8787",
      epicView: "graph",
      selectedCheck: null,
    });
    expect(rendered.content).toContain('id="agent-settings"');
    expect(rendered.side).toContain('href="#/settings"');
    expect(rendered.tabbar).toContain('aria-label="Settings"');
  });

  test("rendering explains inheritance and preserves empty model as agent default", () => {
    const html = renderAgentSettings(view());
    expect(html).toContain('name="0-reviewer-inherit" checked');
    expect(html).toContain('name="0-reviewer-agent" disabled');
    expect(html).toContain('placeholder="Agent default"');
    expect(html).toContain("Agents use their own CLI sign-ins");
    expect(html).toContain("Test connection");
    expect(html).not.toContain("API key");
    const data = settings();
    data.defaults.reviewer = { ...data.defaults.implementer };
    expect(renderAgentSettings(view(data))).toContain('type="submit" disabled');
  });

  test("effort dropdown uses advertised choices and preserves saved effort before testing", () => {
    const state = view();
    state.data!.defaults.reviewer.effort = "high";
    const saved = renderAgentSettings(state);
    expect(saved).toContain('id="defaults-reviewer-effort"');
    expect(saved).toContain('<option value="high" selected>high</option>');
    expect(saved).toContain("Test connection to load effort choices");
    state.connections.set("defaults-reviewer", {
      ok: true,
      agent: "codex",
      model: "gpt-5.4",
      models: [],
      effort: "medium",
      efforts: [
        { id: "medium", name: "Medium" },
        { id: "high", name: "High" },
      ],
      message: "Connected",
    });
    const html = renderAgentSettings(state);
    expect(html).toContain('<option value="medium" >Medium</option>');
    expect(html).toContain('<option value="high" selected>High</option>');
    expect(html).not.toContain('<option value="xhigh"');
    expect(html).toContain(
      'name="0-reviewer-effort" aria-describedby="0-reviewer-effort-help" disabled',
    );
    state.connections.set("defaults-reviewer", {
      ...state.connections.get("defaults-reviewer"),
      efforts: [],
    });
    expect(renderAgentSettings(state)).toContain("This model uses its agent's default effort.");
  });

  test("connection results and persisted values escape untrusted text", () => {
    const state = view();
    state.data!.projects[0]!.repo = '<img src=x onerror="alert(1)">';
    state.connections.set("defaults-reviewer", {
      ok: false,
      agent: "codex",
      model: null,
      models: [{ id: '<bad"model>', name: "<script>" }],
      efforts: [{ id: '<bad"effort>', name: "<script>" }],
      message: "<script>bad</script>",
    });
    const html = renderAgentSettings(state);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;bad&quot;model&gt;");
    expect(html).toContain("&lt;bad&quot;effort&gt;");
  });

  test("load errors give retry and connection tests cannot pretend success", () => {
    expect(renderAgentSettings({ ...view(null), error: "Engine unavailable" })).toContain(
      'data-settings="reload"',
    );
    expect(renderAgentSettings({ ...view(), busy: "Testing Codex connection…" })).toContain(
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
    await settingsRequest(
      "http://localhost:8787",
      "POST",
      { profile: settings().defaults.reviewer },
      "csrf-token",
      fake,
    );
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8787/api/settings/agents",
      "http://localhost:8787/api/settings/agents",
      "http://localhost:8787/api/settings/agents/test",
    ]);
    expect(calls[1]!.init!.headers).toMatchObject({ "x-paws-csrf": "csrf-token" });
    expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({
      profile: settings().defaults.reviewer,
    });
    const failing = (async () =>
      Response.json({ error: "CLI is not installed" }, { status: 422 })) as unknown as typeof fetch;
    await expect(
      settingsRequest("http://localhost:8787", "POST", {}, "csrf", failing),
    ).rejects.toThrow("CLI is not installed");
  });
});
