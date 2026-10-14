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
  return { data, busy: null, error: null, saved: false };
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
      selectedCheck: null,
    });
    expect(rendered.content).toContain('id="agent-settings"');
  });

  test("rendering explains inheritance and preserves empty model as agent default", () => {
    const html = renderAgentSettings(view());
    expect(html).toContain('name="0-reviewer-inherit" checked');
    expect(html).toContain('name="0-reviewer-agent" disabled');
    expect(html).toContain('placeholder="Agent default"');
    expect(html).toContain("Agents run on an installed runner");
    expect(html).toContain('href="#/runners"');
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
    expect(saved).toContain('name="defaults-reviewer-effort" value="high"');
    expect(saved).toContain(
      'name="0-reviewer-effort" value="high" placeholder="Agent default" maxlength="100" pattern="[A-Za-z0-9_-]*" autocapitalize="none" spellcheck="false" disabled',
    );
    expect(saved).not.toContain("Test connection");
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
