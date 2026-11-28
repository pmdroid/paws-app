import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createTelemetrySettings } from "./telemetry-settings";
import { settleReactWork } from "./settle-react";

const view = {
  enabled: true,
  endpoint: "https://otel.example.test",
  protocol: "http/protobuf",
  headerName: "Authorization",
  environment: "",
  metrics: { enabled: true, intervalMinutes: 1, temporality: "delta", durations: "histogram" },
  alerts: { enabled: false, minSeverity: "warning", sendCleared: true },
  items: { enabled: true, scope: "all", includeRepositoryAndRunner: true },
  traces: { enabled: false, which: "all", detail: "stages_and_checks", slowHours: 4 },
  headerValue: "set",
  prometheusToken: "notSet",
  status: {
    error: null,
    metrics: { lastExportAt: null, failuresLastHour: 2 },
    logs: { lastExportAt: null, failuresLastHour: 0 },
    traces: { lastExportAt: null, failuresLastHour: 0 },
  },
};

test("loads, saves without replacing the stored header, and shows the test result", async () => {
  const window = new Window({ url: "http://127.0.0.1:8787/dashboard/workspace/telemetry" });
  const globals = ["window", "document", "Element", "HTMLElement", "Event"] as const;
  const saved = globals.map((name) => globalThis[name]);
  const realFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  try {
    for (const name of globals)
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return Response.json(
        String(url).endsWith("/check")
          ? { ok: false, status: 401, error: "Unauthorized" }
          : {
              ...view,
              ...bodies.at(-1),
              headerValue: "set",
              prometheusToken: bodies.at(-1)?.prometheusToken ? "set" : "notSet",
            },
      );
    }) as typeof fetch;
    const root = window.document.createElement("div") as unknown as HTMLElement;
    window.document.body.appendChild(root as never);
    createTelemetrySettings().mount(root, "http://127.0.0.1:8787");
    await settleReactWork();
    expect(root.querySelector("[data-telemetry-status]")?.textContent).toBe(
      "Exporting · no export yet · 2 failures in the last hour",
    );
    expect(root.querySelector("#telemetry-headerValue")?.getAttribute("placeholder")).toBe(
      "Stored as a secret",
    );
    expect(root.querySelector('[data-telemetry-signal="alerts"] select')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-telemetry-switch="traces.enabled"]')!.click();
    await settleReactWork();
    expect(root.querySelector("#telemetry-traces-slowHours")).not.toBeNull();
    root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settleReactWork();
    expect(bodies[0]).not.toHaveProperty("headerValue");
    expect((bodies[0]!.traces as { enabled: boolean }).enabled).toBe(true);
    expect(root.textContent).toContain("Telemetry settings saved.");
    root.querySelector<HTMLInputElement>("#telemetry-endpoint")!.value = "https://edited.test";
    root.querySelector<HTMLInputElement>("#telemetry-headerValue")!.value = "Bearer edited";
    root.querySelector<HTMLButtonElement>('[data-telemetry="discard"]')!.click();
    await settleReactWork();
    expect(root.querySelector<HTMLInputElement>("#telemetry-endpoint")!.value).toBe(
      "https://otel.example.test",
    );
    root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settleReactWork();
    expect(bodies[1]).toMatchObject({ endpoint: "https://otel.example.test" });
    expect(bodies[1]).not.toHaveProperty("headerValue");
    root.querySelector<HTMLButtonElement>('[data-telemetry="check"]')!.click();
    await settleReactWork();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      "Test export failed (401): Unauthorized",
    );
    expect(bodies.at(-1)).not.toHaveProperty("prometheusToken");
    root.querySelector<HTMLInputElement>("#telemetry-prometheusToken")!.value = "sd-secret";
    root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settleReactWork();
    expect(bodies.at(-1)).toMatchObject({ prometheusToken: "sd-secret" });
    expect(root.querySelector("[data-telemetry-sd-token]")?.textContent).toBe(
      "Set. Leave empty to keep it.",
    );
    root.querySelector<HTMLButtonElement>('[data-telemetry="clear-token"]')!.click();
    await settleReactWork();
    expect(bodies.at(-1)).toMatchObject({ prometheusToken: "" });
    expect(root.querySelector('[data-telemetry="clear-token"]')).toBeNull();
  } finally {
    await settleReactWork();
    globalThis.fetch = realFetch;
    globals.forEach((name, index) => {
      (globalThis as Record<string, unknown>)[name] = saved[index];
    });
    await window.happyDOM.close();
  }
});
