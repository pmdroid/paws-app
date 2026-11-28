import type { Db } from "../db";
import { journalCaught } from "../journal";
import {
  TelemetrySettingsError,
  checkHeaderValue,
  parseTelemetrySettings,
  readTelemetrySettings,
  saveTelemetrySettings,
  telemetryHeader,
  type Telemetry,
} from "../telemetry";
import { isWorkspaceAdmin } from "../workspace";
import { isRecord, json, localRequest, readJson, sameToken } from "./handler";

export const TELEMETRY_SETTINGS_PATH = "/api/settings/telemetry";
export const TELEMETRY_CHECK_PATH = "/api/settings/telemetry/check";

export type TelemetrySettingsOptions = {
  home: string;
  store: Db;
  telemetry: Telemetry;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleTelemetrySettingsRequest(
  request: Request,
  options: TelemetrySettingsOptions,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== TELEMETRY_SETTINGS_PATH && path !== TELEMETRY_CHECK_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Telemetry settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can manage telemetry." }, 403);
  const allowed = path === TELEMETRY_CHECK_PATH ? ["POST"] : ["GET", "PUT"];
  if (!allowed.includes(request.method)) return json({ error: "Method not allowed" }, 405);
  const view = async () =>
    json({
      ...(await readTelemetrySettings(options.store)),
      headerValue: telemetryHeader.set(options.home) ? "set" : "notSet",
      status: options.telemetry.status(),
    });
  if (request.method === "GET") return view();
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  const body = await readJson(request).catch((error: unknown) => {
    journalCaught(error, "telemetry.handleTelemetrySettingsRequest.body", null);
    return null;
  });
  if (!isRecord(body)) return json({ error: "Expected a JSON object of at most 128 KiB" }, 400);
  let settings;
  let headerValue: string | undefined;
  try {
    const { headerValue: header, ...rest } = body;
    settings = parseTelemetrySettings(rest, await readTelemetrySettings(options.store));
    headerValue = header === undefined ? undefined : checkHeaderValue(header);
  } catch (error) {
    if (error instanceof TelemetrySettingsError) return json({ error: error.message }, 400);
    throw error;
  }
  if (request.method === "POST")
    return json(
      await options.telemetry.check(settings, headerValue ?? telemetryHeader.read(options.home)),
    );
  try {
    await saveTelemetrySettings(options.store, settings);
    if (headerValue !== undefined) await telemetryHeader.write(options.home, headerValue);
  } catch (error) {
    journalCaught(error, "telemetry.handleTelemetrySettingsRequest.save", null);
    return json({ error: "Telemetry settings could not be saved" }, 503);
  }
  await options.telemetry.apply(settings, telemetryHeader.read(options.home));
  const secret = headerValue === undefined ? "kept" : headerValue === "" ? "cleared" : "replaced";
  await options.audit(
    "settings.telemetry",
    `Set OTLP export ${settings.enabled ? "on" : "off"}${settings.endpoint === "" ? "" : ` to ${settings.endpoint} (${settings.protocol})`}, header value ${secret}`,
  );
  return view();
}
