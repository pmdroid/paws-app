import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { initializeGitHubAppSetup } from "./github-app-setup";
import { settleReactWork } from "./settle-react";

test("a GitHub App field set by the environment is read-only and the save leaves it out", async () => {
  const window = new Window({ url: "https://paws.example/dashboard/workspace" });
  const globals = globalThis as Record<string, unknown>;
  const names = ["window", "document", "HTMLElement", "FormData"];
  const saved = names.map((name) => globals[name]);
  for (const name of names)
    globals[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  const realFetch = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return (posts.push(String(init.body)), Response.json({}));
    return Response.json({
      configured: false,
      canManage: true,
      webhookUrl: "https://paws.example/webhooks/github",
      permissions: {},
      events: [],
      sources: {
        appId: { source: "unset" },
        privateKeyPath: { source: "environment", variable: "GITHUB_APP_PRIVATE_KEY_PATH" },
        webhookSecret: { source: "environment", variable: "GITHUB_WEBHOOK_SECRET" },
      },
    });
  }) as typeof fetch;
  try {
    const root = window.document.createElement("div") as unknown as HTMLElement;
    await initializeGitHubAppSetup(root, "csrf", () => {});
    const form = root.querySelector("form")!;
    const field = (name: string) =>
      form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
    expect(field("privateKeyPem").readOnly).toBe(true);
    expect(field("privateKeyPem").closest("label")?.textContent).toContain(
      "Set by GITHUB_APP_PRIVATE_KEY_PATH in the service environment",
    );
    expect(form.querySelector('[name="keyFile"]')).toBeNull();
    expect(field("webhookSecret").readOnly).toBe(true);
    expect(field("appId").readOnly).toBe(false);
    expect(field("appId").required).toBe(true);
    field("appId").value = "123";
    field("clientId").value = "synthetic-client";
    field("clientSecret").value = "synthetic-secret";
    form.dispatchEvent(new window.Event("submit", { cancelable: true }) as never);
    await settleReactWork();
    expect(posts.map((body) => JSON.parse(body))).toEqual([
      { appId: "123", clientId: "synthetic-client", clientSecret: "synthetic-secret" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
    names.forEach((name, index) => (globals[name] = saved[index]));
    await window.happyDOM.close();
  }
});
