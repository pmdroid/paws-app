import { z } from "zod";
import type { AuthProvider } from "./codex";
export type OpencodeTokens = { access: string; refresh: string; expiresAt: number };
const CLIENT = "opencode-cli";
const PATH = ".local/share/opencode/auth.json";
const granted = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().finite().positive(),
});
const stored = z.object({
  opencode: z.object({ type: z.literal("oauth"), access: z.string(), refresh: z.string() }),
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
  function tokens(value: z.infer<typeof granted>): OpencodeTokens {
    return {
      access: value.access_token,
      refresh: value.refresh_token,
      expiresAt: now() + value.expires_in * 1000,
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
        return { state: "signed-in", tokens: tokens(success.data) };
      const error = z.object({ error: z.string() }).safeParse(body);
      if (!error.success) throw new Error("OpenCode device poll failed");
      if (["authorization_pending", "slow_down"].includes(error.data.error))
        return { state: "pending" };
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
      return tokens(granted.parse(await response.json()));
    },
    storedTokens(files) {
      const file = files.find((entry) => entry.path === PATH);
      const { opencode } = stored.parse(
        JSON.parse(Buffer.from(file?.data ?? "", "base64").toString()),
      );
      return { access: opencode.access, refresh: opencode.refresh };
    },
    credentialFiles(value) {
      const json = JSON.stringify({
        opencode: {
          type: "oauth",
          refresh: value.refresh,
          access: value.access,
          expires: value.expiresAt,
        },
      });
      return [{ path: PATH, data: Buffer.from(json).toString("base64") }];
    },
  };
}
