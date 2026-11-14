import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createStorageSettings } from "./storage-settings";
import { settleReactWork } from "./settle-react";

test("connection checks display body failures at HTTP 200 and allow a successful retry", async () => {
  const window = new Window({ url: "http://127.0.0.1:8787/dashboard/settings/storage" });
  const globals = ["window", "document", "Element", "HTMLElement", "Event"] as const;
  const saved = globals.map((name) => globalThis[name]);
  const realFetch = globalThis.fetch;
  let ok = false;
  try {
    for (const name of globals)
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
    globalThis.fetch = (async (url: URL | string) =>
      Response.json(
        String(url).endsWith("/check")
          ? { ok, ...(ok ? {} : { error: "Access denied to bucket" }) }
          : { kind: "local", source: "settings", closeoutLogRetentionDays: 0 },
      )) as typeof fetch;
    const root = window.document.createElement("div") as unknown as HTMLElement;
    window.document.body.appendChild(root as never);
    createStorageSettings().mount(root, "http://127.0.0.1:8787");
    await settleReactWork();
    const check = () => root.querySelector<HTMLButtonElement>('[data-storage="check"]')!.click();
    check();
    await settleReactWork();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Access denied to bucket");
    expect(root.textContent).not.toContain("Connection OK.");
    ok = true;
    check();
    await settleReactWork();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).toContain("Connection OK.");
  } finally {
    await settleReactWork();
    globalThis.fetch = realFetch;
    globals.forEach((name, index) => {
      (globalThis as Record<string, unknown>)[name] = saved[index];
    });
    await window.happyDOM.close();
  }
});
