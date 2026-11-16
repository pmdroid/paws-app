import { expect, test } from "bun:test";
import { checkClaudeToken } from "./index";

const answering = (status: number) => async () => new Response("{}", { status });

test("a setup token is accepted on 200 from the model list and refused on 401", async () => {
  expect(await checkClaudeToken("sk-ant-oat01-a", answering(200))).toBe(true);
  expect(await checkClaudeToken("sk-ant-oat01-a", answering(401))).toBe(false);
  await expect(checkClaudeToken("sk-ant-oat01-a", answering(503))).rejects.toThrow();
});

test("the check lists models with the token as an OAuth bearer", async () => {
  let seen: { url: string; headers: Headers } | undefined;
  await checkClaudeToken("sk-ant-oat01-b", async (url, init) => {
    seen = { url, headers: new Headers(init?.headers) };
    return new Response("{}", { status: 200 });
  });
  expect(seen?.url).toBe("https://api.anthropic.com/v1/models");
  expect(seen?.headers.get("authorization")).toBe("Bearer sk-ant-oat01-b");
  expect(seen?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
  expect(seen?.headers.get("anthropic-version")).toBe("2023-06-01");
});
