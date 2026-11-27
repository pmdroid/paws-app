import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type Signal = "metrics" | "alerts" | "items" | "traces";
type Settings = {
  enabled: boolean;
  endpoint: string;
  protocol: string;
  headerName: string;
  environment: string;
} & Record<Signal, Record<string, string | number | boolean>>;
type Status = { error: string | null } & Record<
  "metrics" | "logs" | "traces",
  { lastExportAt: number | null; failuresLastHour: number }
>;
type View = Settings & { headerValue: "set" | "notSet"; status: Status };

const PROTOCOLS = [
  ["http/protobuf", "HTTP/protobuf"],
  ["http/json", "HTTP/JSON"],
  ["grpc", "gRPC"],
] as const;

const SIGNALS: [
  Signal,
  string,
  [string, string, [string | number, string][]][],
  [string, string][],
][] = [
  [
    "metrics",
    "Metrics",
    [
      [
        "intervalMinutes",
        "Export every",
        [
          [1, "1 minute"],
          [5, "5 minutes"],
          [15, "15 minutes"],
        ],
      ],
      [
        "temporality",
        "Temporality",
        [
          ["delta", "Delta"],
          ["cumulative", "Cumulative"],
        ],
      ],
      [
        "durations",
        "Durations as",
        [
          ["histogram", "Histogram"],
          ["average", "Average"],
        ],
      ],
    ],
    [],
  ],
  [
    "alerts",
    "Alerts",
    [
      [
        "minSeverity",
        "Lowest severity",
        [
          ["info", "Info"],
          ["warning", "Warning"],
          ["critical", "Critical"],
        ],
      ],
    ],
    [["sendCleared", "Send cleared alerts"]],
  ],
  [
    "items",
    "Item events",
    [
      [
        "scope",
        "Which events",
        [
          ["all", "Every state change"],
          ["final", "Final states only"],
          ["failures_and_questions", "Failures and questions"],
        ],
      ],
    ],
    [["includeRepositoryAndRunner", "Include repository and runner"]],
  ],
  [
    "traces",
    "Traces",
    [
      [
        "which",
        "Which runs",
        [
          ["all", "All runs"],
          ["failed_or_slow", "Failed or slow runs"],
          ["sample_25", "A 25% sample"],
        ],
      ],
      [
        "detail",
        "Detail",
        [
          ["stages_and_checks", "Stages and checks"],
          ["stages", "Stages only"],
        ],
      ],
      [
        "slowHours",
        "Slow after",
        [
          [4, "4 hours"],
          [8, "8 hours"],
          [24, "24 hours"],
        ],
      ],
    ],
    [],
  ],
];

const TEXT = ["endpoint", "headerName", "environment"] as const;

function statusLine(view: View): string {
  if (!view.enabled) return "Off";
  const kinds = [view.status.metrics, view.status.logs, view.status.traces];
  const last = Math.max(0, ...kinds.map((kind) => kind?.lastExportAt ?? 0));
  const failures = kinds.reduce((sum, kind) => sum + (kind?.failuresLastHour ?? 0), 0);
  const age =
    last === 0
      ? "no export yet"
      : `last export ${Math.max(0, Math.round((Date.now() - last) / 1000))} s ago`;
  return `Exporting · ${age} · ${failures} failure${failures === 1 ? "" : "s"} in the last hour`;
}

export function createTelemetrySettings() {
  let root: HTMLElement;
  let engine: string | null;
  let data: View | null = null;
  let draft: Settings | null = null;
  let headerValue = "";
  let busy = false;
  let message = "";
  let error = false;
  let generation = 0;
  const switchButton = (key: string, on: boolean, label: string) =>
    `<label class="settings-inherit"><button type="button" role="switch" aria-checked="${on}" data-telemetry-switch="${key}" aria-label="${label}" class="${on ? "primary" : ""}">${on ? "On" : "Off"}</button><span class="min-w-0 flex-1">${label}</span></label>`;
  const paint = () => {
    const d = draft;
    const dim = d && !d.enabled ? " opacity-60" : "";
    const signals = d
      ? SIGNALS.map(([signal, label, choices, toggles]) => {
          const block = d[signal];
          const options = block.enabled
            ? `<div class="settings-controls">${choices
                .map(
                  ([key, name, values]) =>
                    `<div class="settings-field"><label for="telemetry-${signal}-${key}">${name}</label><select id="telemetry-${signal}-${key}" name="${signal}.${key}">${values.map(([value, text]) => `<option value="${value}"${block[key] === value ? " selected" : ""}>${text}</option>`).join("")}</select></div>`,
                )
                .join(
                  "",
                )}</div>${toggles.map(([key, name]) => switchButton(`${signal}.${key}`, block[key] === true, name)).join("")}`
            : "";
          return `<div class="col" data-telemetry-signal="${signal}">${switchButton(`${signal}.enabled`, block.enabled === true, label)}${options}</div>`;
        }).join("")
      : "";
    renderMarkup(
      root,
      `<section class="settings-section"><div class="settings-label"><h2>Telemetry</h2></div><div class="col">
      ${
        d && data
          ? `<form id="telemetry-form" class="col" novalidate><fieldset class="col" ${busy ? "disabled" : ""}>
        ${switchButton("enabled", d.enabled, "Export to OpenTelemetry")}
        <p class="sub" role="status" data-telemetry-status>${esc(statusLine(data))}</p>
        ${data.status.error ? `<p class="settings-message err">${esc(data.status.error)}</p>` : ""}
        <div class="card col${dim}"><h3>Destination</h3>
          <div class="settings-controls">
            <div class="settings-field"><label for="telemetry-endpoint">Endpoint</label><input id="telemetry-endpoint" name="endpoint" type="url" autocomplete="off" placeholder="https://otel.example.com:4318" value="${esc(d.endpoint)}"></div>
            <div class="settings-field"><label for="telemetry-headerName">Header name</label><input id="telemetry-headerName" name="headerName" type="text" autocomplete="off" value="${esc(d.headerName)}"></div>
            <div class="settings-field"><label for="telemetry-headerValue">Header value</label><input id="telemetry-headerValue" name="headerValue" type="password" autocomplete="new-password" value="${esc(headerValue)}"${data.headerValue === "set" ? ' placeholder="Stored as a secret"' : ""}><small class="sub">${data.headerValue === "set" ? "Set. Leave empty to keep it." : "Not set"}</small></div>
            <div class="settings-field"><label for="telemetry-environment">Environment</label><input id="telemetry-environment" name="environment" type="text" autocomplete="off" placeholder="production" value="${esc(d.environment)}"></div>
          </div>
          <div class="col" role="radiogroup" aria-labelledby="telemetry-protocol-title"><p id="telemetry-protocol-title">Protocol</p>${PROTOCOLS.map(([value, label]) => `<label><input type="radio" name="protocol" value="${value}"${d.protocol === value ? " checked" : ""}> ${label}</label>`).join("")}</div>
          <p class="sub">Sent as <span class="mono">service.name=paws</span>, <span class="mono">service.version</span>, <span class="mono">service.instance.id</span>${d.environment ? `, <span class="mono">deployment.environment=${esc(d.environment)}</span>` : ""}</p>
          <div class="row"><button class="btn" type="button" data-telemetry="check">Send test</button></div>
        </div>
        <div class="card col${dim}"><h3>What to export</h3>${signals}</div>
        <div class="row sticky bottom-0 z-10 border-t border-border bg-background py-3"><button class="btn" type="button" data-telemetry="discard">Discard</button><button class="btn primary" type="submit">Save</button></div>
      </fieldset></form>`
          : ""
      }
      ${message ? `<p class="settings-message${error ? " err" : ""}" role="${error ? "alert" : "status"}">${esc(message)}</p>` : ""}
    </div></section>`,
    );
  };
  const read = () => {
    if (!draft) return;
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input, select",
    )) {
      const name = input.name;
      if (name === "headerValue") headerValue = input.value;
      else if ((TEXT as readonly string[]).includes(name))
        draft[name as (typeof TEXT)[number]] = input.value;
      else if (name === "protocol") {
        if ((input as HTMLInputElement).checked) draft.protocol = input.value;
      } else if (name.includes(".")) {
        const [signal, key] = name.split(".") as [Signal, string];
        draft[signal][key] = /^\d+$/.test(input.value) ? Number(input.value) : input.value;
      }
    }
  };
  const reset = (view: View) => {
    data = view;
    draft = structuredClone({
      enabled: view.enabled,
      endpoint: view.endpoint,
      protocol: view.protocol,
      headerName: view.headerName,
      environment: view.environment,
      metrics: view.metrics,
      alerts: view.alerts,
      items: view.items,
      traces: view.traces,
    });
    headerValue = "";
  };
  const run = async (action: "reload" | "save" | "check") => {
    if (!engine || busy) return;
    const started = generation;
    const payload =
      action === "reload" || !draft
        ? undefined
        : { ...draft, ...(headerValue ? { headerValue } : {}) };
    busy = true;
    error = false;
    message =
      action === "check"
        ? "Sending a test export…"
        : action === "save"
          ? "Saving…"
          : "Loading telemetry…";
    paint();
    try {
      const response = await fetch(
        new URL(`/api/settings/telemetry${action === "check" ? "/check" : ""}`, engine),
        {
          method: action === "reload" ? "GET" : action === "save" ? "PUT" : "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }
              : {}),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        },
      );
      const result = await response.json();
      if (started !== generation) return;
      if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
      if (action === "check" && result.ok !== true)
        throw new Error(
          `Test export failed${typeof result.status === "number" ? ` (${result.status})` : ""}: ${result.error ?? "no response"}`,
        );
      if (action !== "check") reset(result as View);
      message =
        action === "check"
          ? "Test export sent."
          : action === "save"
            ? "Telemetry settings saved."
            : "";
    } catch (cause) {
      if (started !== generation) return;
      error = true;
      message = cause instanceof Error ? cause.message : "Could not load telemetry settings.";
    }
    busy = false;
    paint();
  };
  const change = (event: Event) => {
    read();
    const target = event.target as HTMLInputElement;
    if (target.tagName === "SELECT" || target.type === "radio" || target.name === "environment")
      paint();
  };
  const click = (event: Event) => {
    const target = event.target as Element;
    const toggle = target.closest<HTMLElement>("[data-telemetry-switch]")?.dataset.telemetrySwitch;
    if (toggle && draft && !busy) {
      read();
      const [first, key] = toggle.split(".") as [string, string | undefined];
      if (key) draft[first as Signal][key] = draft[first as Signal][key] !== true;
      else draft.enabled = !draft.enabled;
      paint();
    }
    const action = target.closest<HTMLElement>("[data-telemetry]")?.dataset.telemetry;
    if (action === "discard" && data) {
      reset(data);
      message = "";
      paint();
    }
    if (action === "check") {
      read();
      void run("check");
    }
  };
  const submit = (event: Event) => {
    event.preventDefault();
    read();
    void run("save");
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("change", change);
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      generation++;
      busy = false;
      data = null;
      draft = null;
      root = next;
      engine = nextEngine;
      root.addEventListener("change", change);
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      if (engine) void run("reload");
      else {
        message = "Connect to your Paws dashboard to manage telemetry.";
        paint();
      }
    },
  };
}
