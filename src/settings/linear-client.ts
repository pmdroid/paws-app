import { join } from "node:path";
import { envSetting, envSettingRefusal, settingSources } from "../config";
import { readSecretFile, saveSecret } from "../credentials";
import { checkLinearClient, type FetchLike } from "../linear";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const LINEAR_CLIENT_SETTINGS_PATH = "/api/settings/linear-client";
const FIELDS = ["clientId", "clientSecret", "webhookSecret"] as const;
type Field = (typeof FIELDS)[number];

function savedClient(dir: string): Partial<Record<Field, string>> {
  const parse = (name: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(readSecretFile(join(dir, name), false) ?? "null");
      return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const client = parse("linear-client.json") ?? parse("linear-browser-client.json") ?? {};
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    clientId: text(client["clientId"]),
    clientSecret: text(client["clientSecret"]),
    webhookSecret: text(readSecretFile(join(dir, "linear-webhook"), false)?.trim()),
  };
}

export async function handleLinearClientSettingsRequest(
  request: Request,
  options: {
    home: string;
    env: Record<string, string | undefined>;
    csrfToken: string;
    trustedOrigin?: string;
    role?: string;
    fetch?: FetchLike;
    audit: (action: string, subject: string) => Promise<void>;
  },
): Promise<Response | null> {
  if (new URL(request.url).pathname !== LINEAR_CLIENT_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Linear client settings are only available on the Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can rotate the Linear client." }, 403);
  const dir = join(options.home, "secrets");
  const saved = savedClient(dir);
  const sources = settingSources(options.env, "linear", saved);
  if (request.method === "GET") return json({ sources });
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  const body = await readJson(request).catch(() => null);
  const entries = body && typeof body === "object" ? Object.entries(body) : [];
  if (
    entries.length === 0 ||
    entries.some(
      ([key, value]) =>
        !FIELDS.includes(key as Field) ||
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 4096,
    )
  )
    return json({ error: "Enter the new values to rotate." }, 400);
  const next = Object.fromEntries(entries) as Partial<Record<Field, string>>;
  const fields = Object.keys(next) as Field[];
  const refusal = envSettingRefusal(options.env, "linear", fields);
  if (refusal !== null) return json({ error: refusal }, 409);
  if (fields.some((field) => sources[field].source !== "settings"))
    return json({ error: "Only values saved in Settings can be rotated here." }, 409);
  const value = (field: Field) =>
    next[field] ?? envSetting(options.env, "linear", field) ?? saved[field];
  if (next.clientId !== undefined || next.clientSecret !== undefined) {
    const check = await checkLinearClient({
      clientId: value("clientId")!,
      clientSecret: value("clientSecret")!,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (check !== "valid")
      return json(
        {
          error:
            check === "invalid"
              ? "Linear did not accept this client ID and secret. The old values still work."
              : "Linear could not be reached. The old values still work.",
        },
        check === "invalid" ? 400 : 503,
      );
    await saveSecret(
      join(dir, "linear-client.json"),
      JSON.stringify({
        clientId: next.clientId ?? saved.clientId,
        clientSecret: next.clientSecret ?? saved.clientSecret,
      }),
    );
  }
  if (next.webhookSecret !== undefined)
    await saveSecret(join(dir, "linear-webhook"), next.webhookSecret);
  await options.audit("settings.linear_client", `Rotated Linear ${fields.join(", ")}`);
  return json({ sources, restart: true });
}
