import { z } from "zod";
import type { AuthProvider } from "./codex";
const metadata = z.object({
  server: z.string(),
  accountID: z.string(),
  email: z.string(),
  orgID: z.string().optional(),
  orgName: z.string().optional(),
});
export type OpencodeTokens = {
  access: string;
  refresh: string;
  expiresAt: number;
  metadata: z.infer<typeof metadata>;
};
const CLIENT = "opencode-cli";
const PATH = ".paws/opencode-credential.json";
const granted = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().finite().positive(),
  org_id: z.string().min(1).nullish(),
});
const stored = z.object({
  type: z.literal("oauth"),
  access: z.string(),
  refresh: z.string(),
  metadata,
});
export function createOpencodeProvider(
  server = "https://opencode.ai/console",
  now = Date.now,
): AuthProvider<OpencodeTokens> {
  async function post(path: string, body: Record<string, string | boolean>) {
    return fetch(server + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function get(path: string, access: string) {
    const response = await fetch(server + path, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", authorization: `Bearer ${access}` },
    });
    if (!response.ok) throw new Error("OpenCode account lookup failed");
    return response.json();
  }
  async function signedIn(value: z.infer<typeof granted>): Promise<OpencodeTokens> {
    const user = z
      .object({ id: z.string().min(1), email: z.string() })
      .parse(await get("/api/user", value.access_token));
    const orgs = z
      .array(z.object({ id: z.string().min(1), name: z.string() }))
      .parse(await get("/api/orgs", value.access_token))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const org = orgs.find((entry) => entry.id === value.org_id) ?? orgs[0];
    return {
      access: value.access_token,
      refresh: value.refresh_token,
      expiresAt: now() + value.expires_in * 1000,
      metadata: {
        server,
        accountID: user.id,
        email: user.email,
        ...(org ? { orgID: org.id, orgName: org.name } : {}),
      },
    };
  }
  return {
    async startDevice() {
      const response = await post("/auth/device/code", {
        client_id: CLIENT,
        supports_org_scope: true,
      });
      if (!response.ok) throw new Error("OpenCode device request failed");
      const value = z
        .object({
          device_code: z.string().min(1),
          user_code: z.string().min(1),
          verification_uri_complete: z.string().min(1),
          expires_in: z.number().finite().positive(),
          interval: z.number().int().min(1).max(900),
        })
        .parse(await response.json());
      const url = new URL(value.verification_uri_complete, server + "/");
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("OpenCode returned an invalid verification URL");
      return {
        deviceId: value.device_code,
        userCode: value.user_code,
        verificationUri: url.href,
        interval: value.interval,
        expiresAt: now() + value.expires_in * 1000,
      };
    },
    async pollDevice(device) {
      if (device.expiresAt <= now()) return { state: "expired" };
      const response = await post("/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceId,
        client_id: CLIENT,
      });
      const body = await response.json().catch(() => null);
      const success = granted.safeParse(body);
      if (response.ok && success.success)
        return { state: "signed-in", tokens: await signedIn(success.data) };
      const error = z.object({ error: z.string() }).safeParse(body);
      if (!error.success) throw new Error("OpenCode device poll failed");
      if (error.data.error === "authorization_pending") return { state: "pending" };
      if (error.data.error === "slow_down")
        return { state: "pending", interval: Math.min(device.interval + 5, 900) };
      if (error.data.error === "access_denied") return { state: "denied" };
      if (error.data.error === "expired_token") return { state: "expired" };
      throw new Error("OpenCode device poll failed");
    },
    async refresh(previous) {
      const response = await post("/auth/device/token", {
        grant_type: "refresh_token",
        refresh_token: previous.refresh,
        client_id: CLIENT,
      });
      if (!response.ok) throw new Error("OpenCode token refresh failed");
      const value = granted.parse(await response.json());
      return {
        access: value.access_token,
        refresh: value.refresh_token,
        expiresAt: now() + value.expires_in * 1000,
        metadata: { ...previous.metadata, ...(value.org_id ? { orgID: value.org_id } : {}) },
      };
    },
    storedTokens(files) {
      const file = files.find((entry) => entry.path === PATH);
      const value = stored.parse(JSON.parse(Buffer.from(file?.data ?? "", "base64").toString()));
      return { access: value.access, refresh: value.refresh, metadata: value.metadata };
    },
    credentialFiles(value) {
      const json = JSON.stringify({
        type: "oauth",
        methodID: "device",
        access: value.access,
        refresh: value.refresh,
        expires: value.expiresAt,
        metadata: value.metadata,
      });
      return [{ path: PATH, data: Buffer.from(json).toString("base64") }];
    },
  };
}
