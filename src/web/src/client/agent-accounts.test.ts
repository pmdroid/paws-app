import { expect, test } from "bun:test";
import { accountStatus, loginChallenge, runningNotice, terminalMarkup } from "./agent-accounts";

const idle = { agent: "claude" as const, connected: false, session: null };

test("the dialog reports the runner's own sign-in that the card shows", () => {
  expect(accountStatus(idle, "signed_in")).toBe("Signed in on this runner");
  expect(accountStatus(idle, "signed_out")).toBe("Not connected");
  expect(accountStatus(idle, undefined)).toBe("Not connected");
  expect(accountStatus({ ...idle, connected: true }, "signed_out")).toBe(
    "Connected to your account",
  );
});

test("a sign-in in progress wins over the runner's status", () => {
  expect(
    accountStatus(
      {
        ...idle,
        session: {
          id: "login",
          agent: "claude",
          state: "starting",
          expiresAt: 0,
          terminal: "",
          authorization: null,
        },
      },
      "signed_in",
    ),
  ).toBe("Starting sign-in…");
});

test("the dialog says before a sign-in that the agent's running tasks switch accounts", () => {
  expect(runningNotice("Claude", 0)).toBe("");
  expect(runningNotice("Claude", undefined)).toBe("");
  expect(runningNotice("Claude", 1)).toBe(
    "Claude is running 1 task on this runner. Signing in switches it to the new account from its next request.",
  );
  expect(runningNotice("Codex", 3)).toBe(
    "Codex is running 3 tasks on this runner. Signing in switches them to the new account from their next request.",
  );
});

const AUTHORIZE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=abc";
const CLAUDE_TERMINAL = `Opening browser to sign in\u2026\r\nIf the browser didn't open, visit: \u001b]8;;${AUTHORIZE}\u0007\u001b[94m${AUTHORIZE}\u001b[39m\u001b]8;;\u0007\r\nPaste code here if prompted > `;

test("Claude's sign-in link in the terminal becomes an open button", () => {
  expect(loginChallenge("claude", null, CLAUDE_TERMINAL)).toEqual({
    url: AUTHORIZE,
    message: "Sign in to Claude, then paste the code it shows below.",
  });
  expect(loginChallenge("claude", null, "Opening browser to sign in")).toBeNull();
  expect(loginChallenge("claude", null, "visit: https://evil.example/cai/oauth")).toBeNull();
  const given = { url: "https://auth.openai.com/codex/device", message: "Enter 1234" };
  expect(loginChallenge("codex", given, CLAUDE_TERMINAL)).toEqual(given);
});

test("the sign-in terminal shows text without escape sequences", () => {
  const html = terminalMarkup(CLAUDE_TERMINAL);
  expect(html).not.toContain("\u001b");
  expect(html).not.toContain("]8;;");
  expect(html).toContain("Paste code here if prompted &gt;");
});
