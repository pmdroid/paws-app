import { expect, test } from "bun:test";
import { slackCaller } from "./api";

test("Slack calls are form-encoded, so read methods like conversations.info get their arguments", async () => {
  const sent: { url: string; type: string | null; body: string }[] = [];
  const call = slackCaller(async (url, init) => {
    sent.push({
      url,
      type: new Headers(init?.headers).get("content-type"),
      body: String(init?.body),
    });
    return Response.json({ ok: true });
  }, "xoxb-test");
  await call("conversations.info", { channel: "C123", limit: 5 }, AbortSignal.timeout(1000));
  await call(
    "chat.postMessage",
    { channel: "C123", unfurl_links: false, blocks: [{ type: "divider" }], skipped: undefined },
    AbortSignal.timeout(1000),
  );
  expect(sent.map((request) => request.type)).toEqual([
    "application/x-www-form-urlencoded; charset=utf-8",
    "application/x-www-form-urlencoded; charset=utf-8",
  ]);
  expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({
    channel: "C123",
    limit: "5",
  });
  expect(Object.fromEntries(new URLSearchParams(sent[1]!.body))).toEqual({
    channel: "C123",
    unfurl_links: "false",
    blocks: '[{"type":"divider"}]',
  });
});
