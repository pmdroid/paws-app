import { expect, test } from "bun:test";
import { checkClaudeToken } from "./index";

const answering = (status: number) => async () => new Response("{}", { status });

test("a setup token is refused only when Claude rejects it", async () => {
  expect(await checkClaudeToken("sk-ant-oat01-a", answering(200))).toBe(true);
  expect(await checkClaudeToken("sk-ant-oat01-a", answering(403))).toBe(true);
  expect(await checkClaudeToken("sk-ant-oat01-a", answering(401))).toBe(false);
  await expect(checkClaudeToken("sk-ant-oat01-a", answering(503))).rejects.toThrow();
});

test("the check sends the token as an OAuth bearer", async () => {
  let seen: Headers | undefined;
  await checkClaudeToken("sk-ant-oat01-b", async (_url, init) => {
    seen = new Headers(init?.headers);
    return new Response("{}", { status: 200 });
  });
  expect(seen?.get("authorization")).toBe("Bearer sk-ant-oat01-b");
  expect(seen?.get("anthropic-beta")).toBe("oauth-2025-04-20");
});
