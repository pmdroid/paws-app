import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { storedSecrets, useDatabaseSecrets } from "../src/credentials";
import { handleTelemetrySettingsRequest } from "../src/settings";
import {
  createTelemetry,
  prometheusSdToken,
  readTelemetrySettings,
  type ExporterConfig,
  type ExporterLoaders,
} from "../src/telemetry";
import { tempHome } from "./helpers";
import { describePglite } from "./pglite-fixtures";

const url = "http://127.0.0.1:8787/api/settings/telemetry";
const headers = { "content-type": "application/json", "x-paws-csrf": "csrf" };
const send = (method: string, body: unknown, path = url) =>
  new Request(path, { method, headers, body: JSON.stringify(body) });
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fakeLoaders(status: number | null) {
  const configs: ExporterConfig[] = [];
  const set = {
    metrics: (config: ExporterConfig) => {
      configs.push(config);
      return {
        export: (_: unknown, done: (result: { code: number; error?: Error }) => void) =>
          done(
            status === null
              ? { code: 0 }
              : { code: 1, error: Object.assign(new Error("refused"), { code: status }) },
          ),
        forceFlush: async () => {},
        shutdown: async () => {},
      };
    },
    logs: () => {
      throw new Error("not used");
    },
    traces: () => {
      throw new Error("not used");
    },
  };
  const load = async () => set as unknown as Awaited<ReturnType<ExporterLoaders["grpc"]>>;
  return { configs, loaders: { "http/protobuf": load, "http/json": load, grpc: load } };
}

describePglite((connect) => {
  test("PUT keeps the header value as a secret, GET never returns it, and members get 403", async () => {
    const before = process.env.PAWS_SECRET_KEY;
    process.env.PAWS_SECRET_KEY = randomBytes(32).toString("base64");
    const handle = await connect();
    const home = tempHome();
    homes.push(home);
    const secrets = await useDatabaseSecrets(handle.db, join(home, "secrets"));
    const fake = fakeLoaders(401);
    const telemetry = createTelemetry({ version: "v1", instanceId: "h", exporters: fake.loaders });
    const audits: string[] = [];
    const env: Record<string, string | undefined> = {};
    const call = async (request: Request, role = "admin") =>
      (await handleTelemetrySettingsRequest(request, {
        home,
        env,
        store: handle.db,
        telemetry,
        csrfToken: "csrf",
        role,
        audit: async (action, subject) => {
          audits.push(`${action}: ${subject}`);
        },
      }))!;
    try {
      const empty = (await (await call(new Request(url))).json()) as {
        status: { metrics: unknown };
      };
      expect(empty).toMatchObject({ enabled: false, headerValue: "notSet" });
      expect(empty.status.metrics).toEqual({ lastExportAt: null, failuresLastHour: 0 });
      const body = {
        enabled: false,
        endpoint: "https://otel.example.com",
        headerValue: "Bearer s3cret-value",
        traces: { enabled: true },
      };
      const saved = await call(send("PUT", body));
      const text = await saved.text();
      expect(saved.status).toBe(200);
      expect(text).not.toContain("s3cret-value");
      expect(JSON.parse(text)).toMatchObject({ headerValue: "set", traces: { enabled: true } });
      expect(storedSecrets()?.map((row) => row.name)).toContain("telemetry-otlp-header");
      expect((await readTelemetrySettings(handle.db)).endpoint).toBe("https://otel.example.com");
      await call(send("PUT", { protocol: "grpc" }));
      expect(audits).toEqual([
        "settings.telemetry: Set OTLP export off to https://otel.example.com (http/protobuf), header value replaced",
        "settings.telemetry: Set OTLP export off to https://otel.example.com (grpc), header value kept",
      ]);
      expect(audits.join("\n")).not.toContain("s3cret");
      expect((await call(send("PUT", { endpoint: "http://otel.example.com" }))).status).toBe(400);
      expect((await call(send("PUT", { metrics: { temporality: "both" } }))).status).toBe(400);
      expect((await call(new Request(url), "member")).status).toBe(403);
      expect((await call(send("PUT", { enabled: false }), "member")).status).toBe(403);
      expect((await call(send("POST", {}, `${url}/check`), "member")).status).toBe(403);
      const check = await call(send("POST", { endpoint: "http://localhost:4318" }, `${url}/check`));
      expect(await check.json()).toEqual({ ok: false, status: 401, error: "refused" });
      expect(fake.configs.at(-1)).toMatchObject({
        url: "http://localhost:4318",
        headers: { Authorization: "Bearer s3cret-value" },
      });
      await call(send("POST", { headerValue: "other" }, `${url}/check`));
      expect(fake.configs.at(-1)!.headers).toEqual({ Authorization: "other" });
      expect((await readTelemetrySettings(handle.db)).endpoint).toBe("https://otel.example.com");
      const token = await call(send("PUT", { prometheusToken: "sd-s3cret" }));
      expect(await token.json()).toMatchObject({ prometheusToken: "set" });
      expect(prometheusSdToken.read(home, env)).toBe("sd-s3cret");
      expect(audits.at(-1)).toEndWith("header value kept, Prometheus token replaced");
      env.PAWS_PROMETHEUS_SD_TOKEN = "from-env";
      expect(await (await call(new Request(url))).json()).toMatchObject({
        prometheusToken: "environment",
      });
      expect((await call(send("PUT", { prometheusToken: "other" }))).status).toBe(409);
      expect(prometheusSdToken.read(home, env)).toBe("from-env");
    } finally {
      await telemetry.shutdown();
      await secrets.close();
      await handle.close();
      if (before === undefined) delete process.env.PAWS_SECRET_KEY;
      else process.env.PAWS_SECRET_KEY = before;
    }
  });
});
