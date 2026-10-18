import { expect, test } from "bun:test";
import { accountStatus } from "./agent-accounts";

const idle = { agent: "claude" as const, connected: false, updatedAt: null, session: null };

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
