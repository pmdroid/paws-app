import type { RunnerCodingAgent } from "../runner-protocol";

type Request = (url: string, init?: RequestInit) => Promise<Response>;

export const API_KEY_PROVIDER: Record<RunnerCodingAgent, string> = {
  claude: "Anthropic",
  codex: "OpenAI",
  grok: "xAI",
  opencode: "OpenRouter",
};

const CHECK: Record<RunnerCodingAgent, (key: string) => [string, Record<string, string>]> = {
  claude: (key) => [
    "https://api.anthropic.com/v1/models",
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
  ],
  codex: (key) => ["https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }],
  grok: (key) => ["https://api.x.ai/v1/models", { Authorization: `Bearer ${key}` }],
  opencode: (key) => ["https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` }],
};

export async function checkApiKey(
  agent: RunnerCodingAgent,
  key: string,
  request: Request = fetch,
): Promise<boolean> {
  const [url, headers] = CHECK[agent](key);
  const response = await request(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) return false;
  if (response.ok) return true;
  throw new Error(`${API_KEY_PROVIDER[agent]} key check failed with status ${response.status}`);
}

export function fakeApiKeyProvider(accepted: Iterable<string>) {
  const keys = new Set(accepted);
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let offline = false;
  const request: Request = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (offline) throw new TypeError("fetch failed");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers["x-api-key"] ?? headers.Authorization?.replace(/^Bearer /, "");
    return new Response(null, { status: key && keys.has(key) ? 200 : 401 });
  };
  return {
    calls,
    request,
    check: (agent: RunnerCodingAgent, key: string) => checkApiKey(agent, key, request),
    setOffline(value: boolean) {
      offline = value;
    },
  };
}
