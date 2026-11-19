import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { settingsPageShown } from "./settings-loads";
import { initializeWorkspaceSlack } from "./workspace-slack";

test("the Slack card shows identity, capabilities and the callback result, and reconnects", async () => {
  const window = new Window({ url: "https://paws.example/dashboard/workspace?slack=denied" });
  const globals = globalThis as Record<string, unknown>;
  const names = ["window", "document", "location", "history", "HTMLElement"];
  const saved = names.map((name) => globals[name]);
  for (const name of names)
    globals[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    return Response.json({
      configured: true,
      redirectUrl: "https://paws.example/oauth/slack/callback",
      eventsUrl: "https://paws.example/webhooks/slack",
      connection: { teamId: "T111111", teamName: "Acme", appId: "A1", botUserId: "B1" },
      capabilities: {
        missing: ["im:history"],
        threads: { ready: true },
        directMessages: { ready: false, message: "Reconnect Slack to grant im:history." },
        code: { ready: false, message: "Slack Code is not available on this connection yet." },
      },
    });
  }) as typeof fetch;
  try {
    const root = window.document.createElement("div") as unknown as HTMLElement;
    initializeWorkspaceSlack(root, "csrf");
    settingsPageShown("integrations");
    await Bun.sleep(20);
    const text = (selector: string) => root.querySelector(selector)?.textContent;
    expect(text("[data-slack-status]")).toBe("Connected to Acme (T111111), app A1, bot B1.");
    expect(text('[data-capability="directMessages"]')).toBe(
      "App messages: Reconnect Slack to grant im:history.",
    );
    expect(text('[data-capability="code"]')).toContain("not available");
    expect(text("[data-slack-notice]")).toContain("unchanged");
    expect(window.location.search).toBe("");
    root.querySelector<HTMLButtonElement>('[data-slack="reconnect"]')!.click();
    await Bun.sleep(20);
    expect(requests).toContain("POST /api/workspaces/slack/connect");
  } finally {
    globalThis.fetch = realFetch;
    names.forEach((name, index) => (globals[name] = saved[index]));
    await window.happyDOM.close();
  }
});

test("the Slack card offers the paws login slack connection and adopts it", async () => {
  const window = new Window({ url: "https://paws.example/dashboard/workspace" });
  const globals = globalThis as Record<string, unknown>;
  const names = ["window", "document", "location", "history", "HTMLElement"];
  const saved = names.map((name) => globals[name]);
  for (const name of names)
    globals[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") return Response.json({ ok: true });
    return Response.json({
      configured: true,
      connection: null,
      capabilities: null,
      login: { teamId: "T111111", teamName: "Acme" },
    });
  }) as typeof fetch;
  try {
    const root = window.document.createElement("div") as unknown as HTMLElement;
    initializeWorkspaceSlack(root, "csrf");
    settingsPageShown("integrations");
    await Bun.sleep(20);
    expect(root.querySelector("[data-slack-status]")?.textContent).toContain("Acme (T111111)");
    const button = root.querySelector<HTMLButtonElement>('[data-slack="adopt"]')!;
    expect(button.textContent).toBe("Use the paws login slack connection");
    button.click();
    await Bun.sleep(20);
    expect(requests).toContain("POST /api/workspaces/slack/adopt");
    expect(root.querySelector("[data-slack-notice]")?.textContent).toBe("Slack is connected.");
  } finally {
    globalThis.fetch = realFetch;
    names.forEach((name, index) => (globals[name] = saved[index]));
    await window.happyDOM.close();
  }
});

async function withSlackCard(
  reply: (method: string, url: string, body: string) => object,
  run: (root: HTMLElement, window: Window) => Promise<void>,
) {
  const window = new Window({ url: "https://paws.example/dashboard/workspace" });
  const globals = globalThis as Record<string, unknown>;
  const names = ["window", "document", "location", "history", "HTMLElement", "FormData"];
  const saved = names.map((name) => globals[name]);
  for (const name of names)
    globals[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    Response.json(reply(init?.method ?? "GET", url, String(init?.body ?? "")))) as typeof fetch;
  try {
    const root = window.document.createElement("div") as unknown as HTMLElement;
    initializeWorkspaceSlack(root, "csrf");
    settingsPageShown("integrations");
    await Bun.sleep(20);
    await run(root, window);
  } finally {
    globalThis.fetch = realFetch;
    names.forEach((name, index) => (globals[name] = saved[index]));
    await window.happyDOM.close();
  }
}

test("an unconfigured Slack card saves the app credentials and then offers Add to Slack", async () => {
  const puts: string[] = [];
  let configured = false;
  await withSlackCard(
    (method, url, body) => {
      if (method === "PUT") {
        puts.push(`${url} ${body}`);
        configured = true;
        return { ok: true };
      }
      return { configured, environment: false, connection: null, capabilities: null };
    },
    async (root, window) => {
      expect(root.textContent).not.toContain("on the server");
      const form = root.querySelector<HTMLFormElement>("[data-slack-app]")!;
      const input = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
      expect(input("clientId").type).toBe("text");
      expect(input("clientSecret").type).toBe("password");
      expect(input("signingSecret").type).toBe("password");
      expect(root.querySelector('[data-slack="connect"]')).toBeNull();
      input("clientId").value = "c1";
      input("clientSecret").value = "cs1";
      input("signingSecret").value = "ss1";
      form.dispatchEvent(new window.Event("submit", { cancelable: true }) as never);
      await Bun.sleep(20);
      expect(puts).toEqual([
        '/api/settings/slack-app {"clientId":"c1","clientSecret":"cs1","signingSecret":"ss1"}',
      ]);
      expect(root.querySelector("[data-slack-notice]")?.textContent).toBe("Saved");
      expect(root.querySelector("[data-slack-app]")).toBeNull();
      expect(root.querySelector('[data-slack="connect"]')?.textContent).toBe("Add to Slack");
    },
  );
});

test("a Slack app from the server environment hides the credentials form", async () => {
  await withSlackCard(
    () => ({ configured: true, environment: true, connection: null, capabilities: null }),
    async (root) => {
      expect(root.querySelector("[data-slack-status]")?.textContent).toBe(
        "Not connected. The Slack app comes from the server environment.",
      );
      expect(root.querySelector("[data-slack-app]")).toBeNull();
      expect(root.querySelector('[data-slack="connect"]')).not.toBeNull();
    },
  );
});
