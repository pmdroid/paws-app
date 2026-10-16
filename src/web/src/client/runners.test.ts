import { describe, expect, test } from "bun:test";
import { agentConnectionReady, runnerActionsMarkup } from "./runners";

const seen = {
  lastSeenAt: 1,
  status: "active" as const,
  agent: "codex",
  accounts: [],
  checks: [],
};

test("runner actions share one row", () => {
  const html = runnerActionsMarkup(
    { id: "runner-1", status: "active" },
    { manages: true, busy: false, recent: true },
  );
  expect(html.startsWith('<div class="row">')).toBe(true);
  expect(html).toContain("View health");
  expect(html).toContain("Pause");
  expect(html).toContain("Drain");
  expect(html).toContain("Revoke access");
  expect(html.indexOf("View health")).toBeLessThan(html.indexOf("Pause"));
  expect(html.indexOf("Pause")).toBeLessThan(html.indexOf("Revoke access"));
});

describe("runner agent connection checks", () => {
  test("a connection check waits until the runner has checked in and the agent is signed in", () => {
    expect(agentConnectionReady(seen)).toBe(false);
    expect(
      agentConnectionReady({
        ...seen,
        lastSeenAt: null,
        accounts: [{ agent: "codex", connected: true }],
      }),
    ).toBe(false);
    expect(
      agentConnectionReady({
        ...seen,
        status: "revoked",
        accounts: [{ agent: "codex", connected: true }],
      }),
    ).toBe(false);
    expect(
      agentConnectionReady({ ...seen, accounts: [{ agent: "claude", connected: true }] }),
    ).toBe(false);
    expect(agentConnectionReady({ ...seen, accounts: [{ agent: "codex", connected: true }] })).toBe(
      true,
    );
    expect(
      agentConnectionReady({
        ...seen,
        accounts: [{ agent: "codex", connected: true }],
        checks: [
          {
            command: { type: "login_check", agent: "codex" },
            expiresAt: 5,
            receivedAt: 5,
            result: {
              stopReason: "end_turn",
              authRequired: false,
              agentExited: true,
              timedOut: false,
              cancelled: false,
              login: { authenticated: false, method: "none", agent: "codex" },
            },
          },
          {
            command: { type: "login_check", agent: "codex" },
            expiresAt: 2,
            receivedAt: 2,
            result: {
              stopReason: "end_turn",
              authRequired: false,
              agentExited: true,
              timedOut: false,
              cancelled: false,
              login: { authenticated: true, method: "subscription", agent: "codex" },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      agentConnectionReady({
        ...seen,
        checks: [
          {
            command: { type: "login_check", agent: "codex" },
            expiresAt: 2,
            receivedAt: 2,
            result: {
              stopReason: "end_turn",
              authRequired: false,
              agentExited: true,
              timedOut: false,
              cancelled: false,
              login: { authenticated: false, method: "none", agent: "codex" },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      agentConnectionReady({
        ...seen,
        checks: [
          {
            command: { type: "login_check", agent: "claude" },
            expiresAt: 3,
            receivedAt: 3,
            result: {
              stopReason: "end_turn",
              authRequired: false,
              agentExited: true,
              timedOut: false,
              cancelled: false,
              login: { authenticated: true, method: "subscription", agent: "claude" },
            },
          },
          {
            command: { type: "login_check", agent: "codex" },
            expiresAt: 2,
            receivedAt: 2,
            result: {
              stopReason: "end_turn",
              authRequired: false,
              agentExited: true,
              timedOut: false,
              cancelled: false,
              login: { authenticated: true, method: "subscription", agent: "codex" },
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
