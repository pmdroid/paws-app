import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openSecretAt } from "../credentials";
import { secretRowsSteps, type Db } from "../db";
import type { RuntimeConfig } from "../config";

export function webhookFileDigest(dir: string): string | null {
  const path = join(dir, "linear-webhook");
  if (!existsSync(path)) return null;
  const stat = statSync(path, { bigint: true });
  return createHash("sha256")
    .update(readFileSync(path))
    .update(String(stat.ino))
    .update(String(stat.mtimeNs))
    .update(String(stat.ctimeNs))
    .digest("hex");
}

export async function browserSetupRuntime(
  db: Db,
  runtime: RuntimeConfig,
  source: Record<string, string | undefined> = {},
) {
  const dir = join(runtime.env.home, "secrets");
  const rows = await db.run(secretRowsSteps);
  const read = (name: string) => {
    const row = rows.find((entry) => entry.name === name);
    return row ? openSecretAt(join(dir, name), row.ciphertext) : null;
  };
  const saved = read("linear-browser-client.json");
  const client =
    saved === null
      ? null
      : (JSON.parse(saved) as {
          clientId: string;
          clientSecret: string;
          webhookFileDigest?: string | null;
        });
  const rotated = client && webhookFileDigest(dir) !== (client.webhookFileDigest ?? null);
  return {
    pending: read("linear-setup-pending") !== null,
    runtime: {
      ...runtime,
      linearClientId: runtime.linearClientId ?? client?.clientId ?? null,
      linearClientSecret:
        source.LINEAR_CLIENT_SECRET?.trim() ||
        (runtime.linearClientId === null && client
          ? client.clientSecret
          : runtime.linearClientSecret),
      env: {
        ...runtime.env,
        linearWebhookSecret:
          source.LINEAR_WEBHOOK_SECRET?.trim() ||
          (rotated ? runtime.env.linearWebhookSecret : null) ||
          (client ? read("linear-webhook") : null) ||
          runtime.env.linearWebhookSecret,
      },
    },
  };
}
