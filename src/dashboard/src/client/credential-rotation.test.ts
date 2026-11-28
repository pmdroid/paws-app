import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { initializeCredentialRotation } from "./credential-rotation";
import { clearSettingsLoads, settingsPageShown } from "./settings-loads";
import { settleReactWork } from "./settle-react";

test("Rotate offers empty inputs only for values saved in Settings", async () => {
  const window = new Window({ url: "https://paws.example/dashboard/workspace" });
  const globals = globalThis as Record<string, unknown>;
  const names = ["window", "document", "HTMLElement", "FormData"];
  const saved = names.map((name) => globals[name]);
  for (const name of names)
    globals[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  const realFetch = globalThis.fetch;
  const puts: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return (puts.push(String(init.body)), Response.json({}));
    return Response.json({
      sources: {
        clientId: { source: "settings" },
        clientSecret: { source: "environment", variable: "LINEAR_CLIENT_SECRET" },
        webhookSecret: { source: "settings" },
      },
    });
  }) as typeof fetch;
  try {
    const root = window.document.createElement("div") as unknown as HTMLElement;
    clearSettingsLoads();
    initializeCredentialRotation(root, "csrf");
    settingsPageShown("linear");
    for (let turn = 0; turn < 20 && !root.querySelector("form"); turn++) await settleReactWork();
    const form = root.querySelector("form")!;
    const inputs = [...form.querySelectorAll("input")];
    expect(inputs.map((input) => [input.name, input.value])).toEqual([
      ["clientId", ""],
      ["webhookSecret", ""],
    ]);
    expect(form.textContent).toContain("Set by LINEAR_CLIENT_SECRET in the service environment");
    inputs[1]!.value = "synthetic-webhook";
    form.dispatchEvent(new window.Event("submit", { cancelable: true }) as never);
    for (let turn = 0; turn < 20 && !form.querySelector("[data-done]")?.textContent; turn++)
      await settleReactWork();
    expect(puts.map((body) => JSON.parse(body))).toEqual([{ webhookSecret: "synthetic-webhook" }]);
    expect(inputs[1]!.value).toBe("");
  } finally {
    clearSettingsLoads();
    globalThis.fetch = realFetch;
    names.forEach((name, index) => (globals[name] = saved[index]));
    await window.happyDOM.close();
  }
});
