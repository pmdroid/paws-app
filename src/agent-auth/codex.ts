import { z } from "zod";

export type Tokens = {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expiresAt: number;
};
export type Device = {
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
  deviceId: string;
};
export type DeviceResult =
  | { state: "pending" | "denied" | "expired" }
  | { state: "signed-in"; tokens: Tokens };
export interface AuthProvider {
  startDevice(): Promise<Device>;
  pollDevice(device: Device): Promise<DeviceResult>;
  refresh(tokens: Tokens): Promise<Tokens>;
  credentialFiles(tokens: Tokens): { path: string; data: string }[];
}
const CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const shape = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});
function claims(token: string) {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()));
}
export function createCodexProvider(
  issuer = "https://auth.openai.com",
  now = Date.now,
): AuthProvider {
  async function post(path: string, body: Record<string, string>, form = false) {
    return fetch(issuer + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
    });
  }
  async function tokens(response: Response, previous?: Tokens): Promise<Tokens> {
    if (!response.ok) throw new Error("Codex token request failed");
    const parsed = shape.parse({ ...previous, ...((await response.json()) as object) });
    const expiresAt = z.number().finite().positive().parse(claims(parsed.access_token).exp) * 1000;
    if (expiresAt <= now()) throw new Error("Codex returned an expired token");
    return { ...parsed, expiresAt };
  }
  return {
    async startDevice() {
      const response = await post("/api/accounts/deviceauth/usercode", { client_id: CLIENT });
      if (!response.ok) throw new Error("Codex device request failed");
      const value = z
        .object({
          device_auth_id: z.string().min(1),
          user_code: z.string().optional(),
          usercode: z.string().optional(),
          interval: z.coerce.number().int().min(1).max(900),
        })
        .parse(await response.json());
      return {
        deviceId: value.device_auth_id,
        userCode: z
          .string()
          .min(1)
          .parse(value.user_code ?? value.usercode),
        verificationUri: issuer + "/codex/device",
        interval: value.interval,
        expiresAt: now() + 900_000,
      };
    },
    async pollDevice(device) {
      if (device.expiresAt <= now()) return { state: "expired" };
      const response = await post("/api/accounts/deviceauth/token", {
        device_auth_id: device.deviceId,
        user_code: device.userCode,
      });
      if ([403, 404].includes(response.status)) return { state: "pending" };
      if (!response.ok) {
        const error = z
          .object({ error: z.string() })
          .safeParse(await response.json().catch(() => null));
        if (error.success && error.data.error === "access_denied") return { state: "denied" };
        if (error.success && error.data.error === "expired_token") return { state: "expired" };
        throw new Error("Codex device poll failed");
      }
      const code = z
        .object({ authorization_code: z.string(), code_verifier: z.string() })
        .parse(await response.json());
      return {
        state: "signed-in",
        tokens: await tokens(
          await post(
            "/oauth/token",
            {
              grant_type: "authorization_code",
              client_id: CLIENT,
              code: code.authorization_code,
              code_verifier: code.code_verifier,
              redirect_uri: issuer + "/deviceauth/callback",
            },
            true,
          ),
        ),
      };
    },
    async refresh(previous) {
      return tokens(
        await post("/oauth/token", {
          grant_type: "refresh_token",
          client_id: CLIENT,
          refresh_token: previous.refresh_token,
        }),
        previous,
      );
    },
    credentialFiles(value) {
      const auth = claims(value.id_token)["https://api.openai.com/auth"] as
        | { chatgpt_account_id?: string }
        | undefined;
      return [
        {
          path: ".codex/auth.json",
          data: Buffer.from(
            JSON.stringify({
              auth_mode: "chatgpt",
              OPENAI_API_KEY: null,
              tokens: {
                id_token: value.id_token,
                access_token: value.access_token,
                refresh_token: value.refresh_token,
                account_id: auth?.chatgpt_account_id ?? null,
              },
              last_refresh: new Date(now()).toISOString(),
            }),
          ).toString("base64"),
        },
      ];
    },
  };
}
