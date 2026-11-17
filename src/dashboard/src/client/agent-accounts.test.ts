import { expect, test } from "bun:test";
import {
  accountStatus,
  dialogAccount,
  loginChallenge,
  openCodeCode,
  runningNotice,
  terminalMarkup,
  terminalOutput,
} from "./agent-accounts";

const idle = { agent: "claude" as const, connected: false, session: null };

test("the dialog reports only the account's own sign-in", () => {
  expect(accountStatus(idle, "agentbox", 0)).toBe("Not connected");
  expect(accountStatus({ ...idle, connected: true }, "agentbox", 0)).toBe(
    "Connected to your account",
  );
});

test("a starting sign-in names the runner it waits for and the time since the click", () => {
  expect(
    accountStatus(
      {
        ...idle,
        session: {
          id: "login",
          agent: "claude",
          state: "starting",
          startedAt: 1_000,
          expiresAt: 601_000,
          terminal: "",
          authorization: null,
        },
      },
      "agentbox",
      96_000,
    ),
  ).toBe(
    "Waiting for agentbox to start the sign-in (it's finishing a check). 1m 35s since you asked.",
  );
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

test("a dialog follows its binding's sign-in", () => {
  const login = { id: "b", agent: "claude" as const, state: "waiting" as const, startedAt: 0 };
  const session = { ...login, expiresAt: 1, terminal: "", authorization: null };
  const bound = { bindingId: "B1", agent: "claude" as const, session };
  const result = { bindings: [{ ...bound, bindingId: "B0" }, bound] };
  expect(dialogAccount(result, "claude", "B1")).toEqual({ ...bound, connected: false });
  expect(dialogAccount(result, "codex", "B1")).toBeNull();
  expect(dialogAccount({}, "claude", "B1")).toBeNull();
});

test("a bound account whose sign-in finished without a stored credential shows as not signed in", () => {
  const session = {
    id: "b",
    agent: "claude" as const,
    state: "connected" as const,
    startedAt: 0,
    expiresAt: 1,
    terminal: "",
    authorization: null,
  };
  const bound = { bindingId: "B1", agent: "claude" as const, signedIn: false, session };
  const account = dialogAccount({ bindings: [bound] }, "claude", "B1")!;
  expect(account.connected).toBe(false);
  expect(accountStatus(account, "agentbox", 0)).toBe(
    "Not signed in. Paws has not stored this sign-in yet.",
  );
  const stored = dialogAccount({ bindings: [{ ...bound, signedIn: true }] }, "claude", "B1")!;
  expect(accountStatus(stored, "agentbox", 0)).toBe("Connected to your account");
});

const OPENCODE_DEVICE =
  "https://opencode.ai/console/device?user_code=PJNS-PWFC&client_id=opencode-cli";
const OPENCODE_TERMINAL = [
  "\u001b[90m┌\u001b[39m  Connect an integration\r\n",
  "\u001b[35m◒\u001b[39m  Starting authorization\u001b[999D\u001b[J",
  "\u001b[35m◐\u001b[39m  Starting authorization\u001b[999D\u001b[J",
  "\u001b[32m◇\u001b[39m  Authorization started\r\n",
  "\u001b[90m│\u001b[39m\r\n\u001b[34m●\u001b[39m  Enter code: PJNS-PWFC\r\n",
  `\u001b[34m●\u001b[39m  ${OPENCODE_DEVICE}\r\n`,
  "\u001b[32m◇\u001b[39m  Waiting for authorization...\r\n",
].join("");

test("OpenCode's device link and code in the terminal become an open button", () => {
  expect(loginChallenge("opencode", null, OPENCODE_TERMINAL)).toEqual({
    url: OPENCODE_DEVICE,
    message: "Enter code PJNS-PWFC at OpenCode, then approve.",
  });
  expect(openCodeCode(OPENCODE_TERMINAL)).toBe("PJNS-PWFC");
  expect(loginChallenge("opencode", null, `●  ${OPENCODE_DEVICE}`)).toEqual({
    url: OPENCODE_DEVICE,
    message: "Approve the sign-in at OpenCode.",
  });
  expect(
    loginChallenge(
      "opencode",
      null,
      "Enter code: PJNS-PWFC\nhttps://evil.example/console/device?user_code=PJNS-PWFC",
    ),
  ).toBeNull();
  expect(
    loginChallenge(
      "opencode",
      null,
      "Enter code: PJNS-PWFC\nhttps://opencode.ai.evil.example/console/device?user_code=PJNS-PWFC",
    ),
  ).toBeNull();
  expect(
    loginChallenge("opencode", null, "https://opencode.ai/other?user_code=PJNS-PWFC"),
  ).toBeNull();
});

test("a failed sign-in shows why in the terminal", () => {
  const session = {
    id: "f",
    agent: "opencode" as const,
    startedAt: 0,
    expiresAt: 1,
    authorization: null,
  };
  const failed = { ...session, state: "failed" as const, terminal: "Error: device code expired" };
  expect(terminalMarkup(terminalOutput(failed))).toContain("Error: device code expired");
  expect(terminalOutput({ ...failed, terminal: "" })).toBe("");
  expect(terminalOutput({ ...failed, state: "cancelled" })).toBe("");
  expect(terminalOutput({ ...failed, state: "waiting", terminal: "live" })).toBe("live");
  expect(terminalOutput(null)).toBe("");
});
