import { expect, test } from "bun:test";
import { checkApiKey } from "./index";

test("each agent's API key is checked against its provider's endpoint", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let status = 200;
  const request = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  };
  for (const agent of ["claude", "codex", "grok", "opencode"] as const)
    expect(await checkApiKey(agent, "key-1", request)).toBe(true);
  expect(calls.map(({ url, init }) => [url, init?.headers])).toEqual([
    [
      "https://api.anthropic.com/v1/models",
      { "x-api-key": "key-1", "anthropic-version": "2023-06-01" },
    ],
    ["https://api.openai.com/v1/models", { Authorization: "Bearer key-1" }],
    ["https://api.x.ai/v1/models", { Authorization: "Bearer key-1" }],
    ["https://openrouter.ai/api/v1/key", { Authorization: "Bearer key-1" }],
  ]);
  expect(calls.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true);
  for (const rejected of [401, 403]) {
    status = rejected;
    expect(await checkApiKey("grok", "key-1", request)).toBe(false);
  }
  status = 500;
  const failed = await checkApiKey("grok", "key-1", request).catch((error: Error) => error);
  expect(String(failed)).toBe("Error: xAI key check failed with status 500");
  expect(String(failed)).not.toContain("key-1");
});
