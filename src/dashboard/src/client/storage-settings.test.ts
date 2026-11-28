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

test("a storage field set by the environment is read-only and the save leaves it out", async () => {
  const window = new Window({ url: "http://127.0.0.1:8787/dashboard/settings/storage" });
  const globals = ["window", "document", "Element", "HTMLElement", "Event"] as const;
  const saved = globals.map((name) => globalThis[name]);
  const realFetch = globalThis.fetch;
  const puts: string[] = [];
  const storage = {
    kind: "s3",
    source: "environment",
    bucket: "env-bucket",
    endpoint: "https://s3.example",
    region: "eu-1",
    accessKeyId: "AKIA",
    hasSecretAccessKey: true,
    hasSessionToken: false,
    closeoutLogRetentionDays: 0,
    sources: {
      bucket: { source: "environment", variable: "PAWS_S3_BUCKET" },
      secretAccessKey: { source: "environment", variable: "PAWS_S3_SECRET_ACCESS_KEY" },
      region: { source: "settings" },
    },
  };
  try {
    for (const name of globals)
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
    globalThis.fetch = (async (_url: URL | string, init?: RequestInit) => {
      if (init?.method === "PUT") puts.push(String(init.body));
      return Response.json(storage);
    }) as typeof fetch;
    const root = window.document.createElement("div") as unknown as HTMLElement;
    window.document.body.appendChild(root as never);
    createStorageSettings().mount(root, "http://127.0.0.1:8787");
    await settleReactWork();
    const input = (key: string) => root.querySelector<HTMLInputElement>(`#storage-${key}`)!;
    expect(input("bucket").readOnly).toBe(true);
    expect(input("bucket").value).toBe("env-bucket");
    expect(input("bucket").parentElement?.textContent).toContain(
      "Set by PAWS_S3_BUCKET in the service environment",
    );
    expect(input("secretAccessKey").readOnly).toBe(true);
    expect(input("region").readOnly).toBe(false);
    expect(input("region").closest("fieldset")?.disabled).toBe(false);
    expect(root.querySelector<HTMLSelectElement>("#storage-kind")?.disabled).toBe(true);
    root
      .querySelector<HTMLFormElement>("#storage-form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
    await settleReactWork();
    expect(puts.map((body) => JSON.parse(body))).toEqual([
      {
        kind: "s3",
        endpoint: "https://s3.example",
        region: "eu-1",
        accessKeyId: "AKIA",
        closeoutLogRetentionDays: 0,
      },
    ]);
  } finally {
    await settleReactWork();
    globalThis.fetch = realFetch;
    globals.forEach((name, index) => {
      (globalThis as Record<string, unknown>)[name] = saved[index];
    });
    await window.happyDOM.close();
  }
});
