import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createStorageDisk } from "./storage-disk";
import { settleReactWork } from "./settle-react";

const GB = 1024 ** 3;
const fs = (mount: string, total: number, free: number, memory = false) => ({
  mount,
  type: memory ? "tmpfs" : "ext4",
  totalBytes: total * GB,
  freeBytes: free * GB,
  ...(memory ? { memory: true } : {}),
});

test("shows every machine, previews and runs a cleanup, and opens history", async () => {
  const window = new Window({ url: "http://127.0.0.1:8787/dashboard/workspace/storage" });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  const globals = ["window", "document", "Element", "HTMLElement", "Event"] as const;
  const saved = globals.map((name) => globalThis[name]);
  const realFetch = globalThis.fetch;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const now = Date.now();
  try {
    for (const name of globals)
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
    let ran = false;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith("/storage-usage"))
        return Response.json({
          scanning: false,
          live: { home: fs("/", 100, 40), tmp: fs("/tmp", 10, 1, true), checkedAt: now },
          snapshots: [
            {
              machine: "server",
              takenAt: now - 120_000,
              partial: false,
              filesystems: { home: null, tmp: null },
              categories: {
                temporary: { bytes: 2 * GB, files: 3 },
                secrets: { bytes: 10, files: 1 },
              },
            },
          ],
          runners: [
            {
              machine: "r1",
              name: "old-runner",
              state: "unsupported",
              online: true,
              reporting: false,
              snapshot: null,
            },
          ],
        });
      if (path.endsWith("/storage-cleanup") && method === "GET")
        return Response.json({
          schedule: { enabled: false, timeUtc: "03:00", machines: [] },
          categories: {
            temporary: { enabled: true, olderThanHours: 24 },
            closeout_logs: { enabled: true },
          },
        });
      if (path.endsWith("/history"))
        return Response.json(
          ran
            ? [
                {
                  id: "c1",
                  machine: "server",
                  actor: "admin",
                  startedAt: now,
                  finishedAt: now,
                  deleted: [{ category: "temporary", ref: "paws-old", bytes: GB }],
                  skipped: [
                    { category: "temporary", ref: "paws-new", reason: "newer than 24 hours" },
                  ],
                  freedBytes: GB,
                  error: null,
                },
              ]
            : [],
        );
      if (path.endsWith("/preview"))
        return Response.json({
          id: "p1",
          expiresAt: now + 900_000,
          items: [{ category: "temporary", ref: "paws-old", bytes: GB }],
          kept: [{ category: "temporary", reason: "newer than 24 hours", count: 1 }],
        });
      if (path.endsWith("/run")) {
        ran = true;
        return Response.json({
          id: "c1",
          deleted: [{ category: "temporary", ref: "paws-old", bytes: GB }],
          skipped: [],
          freedBytes: GB,
          error: null,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) as typeof fetch;
    const root = window.document.createElement("div") as unknown as HTMLElement;
    window.document.body.appendChild(root as never);
    createStorageDisk().mount(root, "http://127.0.0.1:8787");
    await settleReactWork();
    await settleReactWork();
    const text = () => root.textContent ?? "";
    expect(text()).toContain("Paws server");
    expect(text()).toContain("/tmp (memory)");
    expect(text()).toContain("9.0 GB used, 1.0 GB free of 10 GB");
    expect(text()).toContain("/tmp is more than 80% full on the server (90%)");
    expect(text()).toContain("could free 1.0 GB");
    expect(text()).toContain("Never deleted here");
    expect(text()).toContain("Delete after 24 hours");
    expect(text()).toContain("Update the runner to see disk use");
    const button = (name: string) =>
      [...root.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name)!;
    button("Preview cleanup").click();
    await settleReactWork();
    expect(root.querySelector("dialog")?.textContent).toContain("1.0 GB in 1 item");
    expect(root.querySelector("dialog")?.textContent).toContain("1 newer than 24 hours");
    button("Delete 1 item").click();
    await settleReactWork();
    await settleReactWork();
    expect(calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({ previewId: "p1" });
    expect(root.querySelector("dialog")).toBeNull();
    expect(text()).toContain("Deleted 1 items and freed 1.0 GB.");
    button("Show items").click();
    await settleReactWork();
    expect(text()).toContain("paws-new  newer than 24 hours");
    root.querySelector<HTMLInputElement>("#cleanup-hours")!.value = "48";
    root.querySelector<HTMLInputElement>("#cleanup-enabled")!.checked = true;
    root
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
    await settleReactWork();
    const put = calls.find((call) => call.method === "PUT")?.body as {
      schedule: { enabled: boolean };
      categories: { temporary: { olderThanHours: number } };
    };
    expect(put.schedule.enabled).toBe(true);
    expect(put.categories.temporary.olderThanHours).toBe(48);
  } finally {
    await settleReactWork();
    globalThis.fetch = realFetch;
    globals.forEach((name, index) => {
      (globalThis as Record<string, unknown>)[name] = saved[index];
    });
    await window.happyDOM.close();
  }
});
