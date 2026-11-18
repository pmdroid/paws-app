import { z } from "zod";
import type { AuthProvider } from "./codex";
type GrokTokens = {
  access_token: string;
  refresh_token: string | null;
  user_id: string | null;
  email: string | null;
  create_time: string;
  expiresAt: number;
};
const ISSUER = "https://auth.x.ai";
const CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = `${ISSUER}::${CLIENT}`;
const SCOPES =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
const PATH = ".grok/auth.json";
const tokenShape = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().default(3600),
  id_token: z.string().optional(),
});
const stored = z.object({
  key: z.string().min(1),
  refresh_token: z.string().nullish(),
  user_id: z.string().nullish(),
  email: z.string().nullish(),
  create_time: z.string(),
});
function claims(token = "") {
  const value = z
    .object({ sub: z.string().min(1).optional(), email: z.string().min(1).optional() })
    .safeParse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}"));
  return value.success ? value.data : {};
}
export function createGrokProvider(issuer = ISSUER, now = Date.now): AuthProvider<GrokTokens> {
  async function post(path: string, body: Record<string, string>) {
    return fetch(issuer + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  }
  async function tokens(response: Response, previous?: GrokTokens): Promise<GrokTokens> {
    if (!response.ok) throw new Error("Grok token request failed");
    const value = tokenShape.parse(await response.json());
    const identity = claims(value.id_token);
    const expiresAt = now() + value.expires_in * 1000;
    return {
      access_token: value.access_token,
      refresh_token: value.refresh_token ?? previous?.refresh_token ?? null,
      user_id: identity.sub ?? previous?.user_id ?? null,
      email: identity.email ?? previous?.email ?? null,
      create_time: new Date(now()).toISOString(),
      expiresAt,
    };
  }
  return {
    async startDevice() {
      const response = await post("/oauth2/device/code", { client_id: CLIENT, scope: SCOPES });
      if (!response.ok) throw new Error("Grok device request failed");
      const value = z
        .object({
          device_code: z.string().min(1),
          user_code: z.string().min(1),
          verification_uri: z.string().url(),
          verification_uri_complete: z.string().url().optional(),
          expires_in: z.coerce.number().positive(),
          interval: z.coerce.number().int().min(1).max(900).optional(),
        })
        .parse(await response.json());
      return {
        deviceId: value.device_code,
        userCode: value.user_code,
        verificationUri: value.verification_uri_complete ?? value.verification_uri,
        interval: value.interval ?? 5,
        expiresAt: now() + value.expires_in * 1000,
      };
    },
    async pollDevice(device) {
      if (device.expiresAt <= now()) return { state: "expired" };
      const response = await post("/oauth2/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceId,
        client_id: CLIENT,
      });
      if (!response.ok) {
        const error = z
          .object({ error: z.string() })
          .safeParse(await response.json().catch(() => null));
        const code = error.success ? error.data.error : "";
        if (code === "slow_down")
          return { state: "pending", interval: Math.min(device.interval + 5, 900) };
        if (code === "authorization_pending") return { state: "pending" };
        if (code === "access_denied") return { state: "denied" };
        if (code === "expired_token") return { state: "expired" };
        throw new Error("Grok device poll failed");
      }
      return { state: "signed-in", tokens: await tokens(response) };
    },
    async refresh(previous) {
      if (!previous.refresh_token) throw new Error("Grok account has no refresh token");
      return tokens(
        await post("/oauth2/token", {
          grant_type: "refresh_token",
          refresh_token: previous.refresh_token,
          client_id: CLIENT,
        }),
        previous,
      );
    },
    storedTokens(files) {
      const file = files.find((entry) => entry.path === PATH);
      const map = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(Buffer.from(file?.data ?? "", "base64").toString()));
      const value = stored.parse(map[SCOPE]);
      return {
        access_token: value.key,
        refresh_token: value.refresh_token ?? null,
        user_id: value.user_id ?? null,
        email: value.email ?? null,
        create_time: value.create_time,
      };
    },
    credentialFiles(value) {
      const json = JSON.stringify({
        [SCOPE]: {
          key: value.access_token,
          auth_mode: "oidc",
          create_time: value.create_time,
          user_id: value.user_id,
          email: value.email,
          refresh_token: value.refresh_token,
          expires_at: new Date(value.expiresAt).toISOString(),
          oidc_issuer: ISSUER,
          oidc_client_id: CLIENT,
          coding_data_retention_opt_out: true,
          team_blocked_reasons: [],
        },
      });
      return [{ path: PATH, data: Buffer.from(json).toString("base64") }];
    },
  };
}
