import { expect, test } from "bun:test";
import { SlackApiError, slackCaller, slackChannelMembers, type SlackCall } from "./api";

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

test("channel members page through conversations.members and keep private and archived channels", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const call: SlackCall = async (method, body) => {
    calls.push([method, body]);
    if (method === "conversations.info")
      return { ok: true, channel: { id: "C1", name: "ops", is_private: true, is_archived: true } };
    return body.cursor === "next"
      ? { ok: true, members: ["U2"] }
      : { ok: true, members: ["U1"], response_metadata: { next_cursor: "next" } };
  };
  const members = await slackChannelMembers(call, "C1", AbortSignal.timeout(1000));
  expect(members).toEqual({ slackUserIds: new Set(["U1", "U2"]), name: "ops" });
  expect(calls.map(([method]) => method)).toEqual([
    "conversations.info",
    "conversations.members",
    "conversations.members",
  ]);
  const refused: SlackCall = async (method) => {
    throw new SlackApiError(method, "channel_not_found");
  };
  expect(await slackChannelMembers(refused, "C1", AbortSignal.timeout(1000))).toBeNull();
});
