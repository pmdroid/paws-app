import { join } from "node:path";
import { pawsPaths } from "../config";
import { readSecretFile, removeSecret, saveSecret, secretFileExists } from "../credentials";
import { readSetting, updateSetting, type Db } from "../db";
import { journalCaught } from "../journal";

export const PROTOCOLS = ["http/protobuf", "http/json", "grpc"] as const;
export type TelemetryProtocol = (typeof PROTOCOLS)[number];

const CHOICES = {
  metrics: {
    intervalMinutes: [1, 5, 15],
    temporality: ["delta", "cumulative"],
    durations: ["histogram", "average"],
  },
  alerts: { minSeverity: ["info", "warning", "critical"] },
  items: { scope: ["all", "final", "failures_and_questions"] },
  traces: {
    which: ["all", "failed_or_slow", "sample_25"],
    detail: ["stages_and_checks", "stages"],
    slowHours: [4, 8, 24],
  },
} as const;

type Choice<
  S extends keyof typeof CHOICES,
  K extends keyof (typeof CHOICES)[S],
> = (typeof CHOICES)[S][K] extends readonly (infer V)[] ? V : never;

export type TelemetrySettings = {
  enabled: boolean;
  endpoint: string;
  protocol: TelemetryProtocol;
  headerName: string;
  environment: string;
  metrics: {
    enabled: boolean;
    intervalMinutes: Choice<"metrics", "intervalMinutes">;
    temporality: Choice<"metrics", "temporality">;
    durations: Choice<"metrics", "durations">;
  };
  alerts: { enabled: boolean; minSeverity: Choice<"alerts", "minSeverity">; sendCleared: boolean };
  items: {
    enabled: boolean;
    scope: Choice<"items", "scope">;
    includeRepositoryAndRunner: boolean;
  };
  traces: {
    enabled: boolean;
    which: Choice<"traces", "which">;
    detail: Choice<"traces", "detail">;
    slowHours: Choice<"traces", "slowHours">;
  };
};

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = {
  enabled: false,
  endpoint: "",
  protocol: "http/protobuf",
  headerName: "Authorization",
  environment: "",
  metrics: { enabled: true, intervalMinutes: 1, temporality: "delta", durations: "histogram" },
  alerts: { enabled: true, minSeverity: "warning", sendCleared: true },
  items: { enabled: true, scope: "all", includeRepositoryAndRunner: true },
  traces: { enabled: false, which: "all", detail: "stages_and_checks", slowHours: 4 },
};

export class TelemetrySettingsError extends Error {}

const SIGNAL_BOOLEANS = {
  metrics: [],
  alerts: ["sendCleared"],
  items: ["includeRepositoryAndRunner"],
  traces: [],
} as const;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

function fail(message: string): never {
  throw new TelemetrySettingsError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function pick<T>(value: unknown, fallback: T, name: string, check: (value: unknown) => boolean): T {
  if (value === undefined) return fallback;
  if (!check(value)) fail(`${name} is not valid.`);
  return value as T;
}

export function checkEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    fail("endpoint must be a URL.");
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !local)
    fail("endpoint must use https, or http only for localhost.");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    fail("endpoint must not carry credentials, a query or a fragment.");
}

export function parseTelemetrySettings(
  body: unknown,
  base: TelemetrySettings = DEFAULT_TELEMETRY_SETTINGS,
): TelemetrySettings {
  const input = record(body, "settings");
  const text = (key: "endpoint" | "headerName" | "environment", max: number) =>
    pick(input[key], base[key], key, (v) => typeof v === "string" && v.length <= max).trim();
  const next = {
    enabled: pick(input.enabled, base.enabled, "enabled", (v) => typeof v === "boolean"),
    endpoint: text("endpoint", 2048).replace(/\/+$/, ""),
    protocol: pick(input.protocol, base.protocol, "protocol", (v) =>
      (PROTOCOLS as readonly unknown[]).includes(v),
    ),
    headerName: text("headerName", 256) || DEFAULT_TELEMETRY_SETTINGS.headerName,
    environment: text("environment", 200),
  } as TelemetrySettings;
  for (const signal of Object.keys(CHOICES) as (keyof typeof CHOICES)[]) {
    const block = record(input[signal], signal);
    const stored = base[signal] as Record<string, unknown>;
    const out: Record<string, unknown> = {
      enabled: pick(
        block.enabled,
        stored.enabled,
        `${signal}.enabled`,
        (v) => typeof v === "boolean",
      ),
    };
    for (const key of SIGNAL_BOOLEANS[signal])
      out[key] = pick(block[key], stored[key], `${signal}.${key}`, (v) => typeof v === "boolean");
    for (const [key, values] of Object.entries(CHOICES[signal]))
      out[key] = pick(block[key], stored[key], `${signal}.${key}`, (v) =>
        (values as readonly unknown[]).includes(v),
      );
    (next as Record<string, unknown>)[signal] = out;
  }
  if (!HEADER_NAME.test(next.headerName)) fail("headerName is not a valid header name.");
  if (next.endpoint !== "") checkEndpoint(next.endpoint);
  else if (next.enabled) fail("Set an endpoint before turning export on.");
  return next;
}

export function checkHeaderValue(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value))
    fail("headerValue must be one line of text.");
  return value.trim();
}

const SETTINGS_KEY = "telemetry.otlp";
const headerPath = (home: string) => join(pawsPaths(home).secretsDir, "telemetry-otlp-header");

export async function readTelemetrySettings(store: Db): Promise<TelemetrySettings> {
  const stored = await readSetting(store, SETTINGS_KEY);
  if (stored === null) return DEFAULT_TELEMETRY_SETTINGS;
  try {
    return parseTelemetrySettings(JSON.parse(stored));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TelemetrySettingsError)
      return DEFAULT_TELEMETRY_SETTINGS;
    throw error;
  }
}

export async function saveTelemetrySettings(store: Db, settings: TelemetrySettings): Promise<void> {
  await updateSetting(store, SETTINGS_KEY, () => JSON.stringify(settings));
}

export const telemetryHeader = {
  read(home: string): string | null {
    try {
      return readSecretFile(headerPath(home));
    } catch (error) {
      journalCaught(error, "telemetry.header.read", null);
      return null;
    }
  },
  set: (home: string) => secretFileExists(headerPath(home)),
  async write(home: string, value: string): Promise<void> {
    if (value === "") await removeSecret(headerPath(home));
    else await saveSecret(headerPath(home), value);
  },
};
