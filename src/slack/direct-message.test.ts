import { expect, test } from "bun:test";
import { openSlackDirectMessage, SlackDirectMessageError } from "./direct-message";
import type { SlackFetch } from "./oauth";

const token = "xoxb-secret-token-123";

function fake(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: SlackFetch = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function failure(promise: Promise<unknown>): Promise<SlackDirectMessageError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SlackDirectMessageError);
  expect((error as Error).message).not.toContain(token);
  return error as SlackDirectMessageError;
}

const signal = () => new AbortController().signal;

test("opens a direct message and returns the D channel id", async () => {
  const slack = fake(() => json({ ok: true, channel: { id: "D024BE91L" } }));
  const channel = await openSlackDirectMessage({
    token,
    userId: "U012AB3CD",
    fetch: slack.fetch,
    signal: signal(),
  });
  expect(channel).toBe("D024BE91L");
  expect(slack.calls).toHaveLength(1);
  const [call] = slack.calls;
  expect(call!.url).toBe("https://slack.com/api/conversations.open");
  expect(call!.init?.method).toBe("POST");
  expect(call!.init?.redirect).toBe("error");
  expect(new Headers(call!.init!.headers).get("authorization")).toBe(`Bearer ${token}`);
  expect(JSON.parse(String(call!.init?.body))).toEqual({ users: "U012AB3CD" });
});

test("refuses a user id that is not a Slack user before any request", async () => {
  for (const userId of ["C123", ""]) {
    const slack = fake(() => json({ ok: true, channel: { id: "D1" } }));
    const error = await failure(
      openSlackDirectMessage({ token, userId, fetch: slack.fetch, signal: signal() }),
    );
    expect(error.reason).toBe("recipient");
    expect(slack.calls).toHaveLength(0);
  }
});

test("refuses an answer whose channel is not a direct message", async () => {
  const slack = fake(() => json({ ok: true, channel: { id: "C123" } }));
  const error = await failure(
    openSlackDirectMessage({ token, userId: "U1", fetch: slack.fetch, signal: signal() }),
  );
  expect(error.reason).toBe("unavailable");
});

test("maps each Slack error code to its reason", async () => {
  const cases: [string, SlackDirectMessageError["reason"]][] = [
    ["invalid_auth", "credentials"],
    ["token_revoked", "credentials"],
    ["not_authed", "credentials"],
    ["account_inactive", "credentials"],
    ["missing_scope", "scope"],
    ["user_not_found", "recipient"],
    ["user_disabled", "recipient"],
    ["cannot_dm_bot", "recipient"],
    ["user_not_visible", "recipient"],
    ["ratelimited", "unavailable"],
    ["toString", "unavailable"],
  ];
  for (const [code, reason] of cases) {
    const slack = fake(() => json({ ok: false, error: code, detail: token }));
    const error = await failure(
      openSlackDirectMessage({ token, userId: "W1", fetch: slack.fetch, signal: signal() }),
    );
    expect(error.reason).toBe(reason);
    expect(error.message).not.toContain(code);
  }
});

test("a non-JSON body or an HTTP 500 is unavailable", async () => {
  for (const respond of [
    () => new Response("<html>oops</html>", { status: 200 }),
    () => json({ ok: true, channel: { id: "D1" } }, 500),
  ]) {
    const error = await failure(
      openSlackDirectMessage({ token, userId: "U1", fetch: fake(respond).fetch, signal: signal() }),
    );
    expect(error.reason).toBe("unavailable");
  }
});

test("a Slack that never answers times out as unavailable", async () => {
  const slack = fake(() => new Promise<Response>(() => {}));
  const error = await failure(
    openSlackDirectMessage({
      token,
      userId: "U1",
      fetch: slack.fetch,
      signal: signal(),
      timeoutMs: 100,
    }),
  );
  expect(error.reason).toBe("unavailable");
});

test("an aborted caller is unavailable", async () => {
  const controller = new AbortController();
  controller.abort();
  const slack = fake(() => new Promise<Response>(() => {}));
  const error = await failure(
    openSlackDirectMessage({ token, userId: "U1", fetch: slack.fetch, signal: controller.signal }),
  );
  expect(error.reason).toBe("unavailable");
});
