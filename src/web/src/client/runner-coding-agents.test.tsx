import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  agentCatalogMarkup,
  codingAgentsBehind,
  runnerCodingAgentsMarkup,
  runnerDetailMarkup,
  type AgentCatalogEntry,
  type Runner,
  type RunnerCodingAgent,
} from "./runners";
import { themedMarkup } from "./theme";

const now = 1_000_000_000;
const catalog: AgentCatalogEntry[] = [
  { agent: "claude", offered: "2.1.0", refused: [], checkedAt: now },
  { agent: "codex", offered: "0.9.0", refused: [], checkedAt: now },
];
const claude: RunnerCodingAgent = {
  agent: "claude",
  current: "2.0.0",
  previous: "1.8.0",
  pending: null,
  reportedAt: now,
};
const codex: RunnerCodingAgent = {
  agent: "codex",
  current: "0.9.0",
  previous: null,
  pending: null,
  reportedAt: now,
};
const pending = (
  status: NonNullable<RunnerCodingAgent["pending"]>["status"],
  extra: Partial<NonNullable<RunnerCodingAgent["pending"]>> = {},
): RunnerCodingAgent => ({
  ...claude,
  pending: {
    version: "2.1.0",
    rollback: false,
    status,
    sessions: null,
    error: null,
    requestedAt: now,
    ...extra,
  },
});
const owner = { runnerId: "01JRUNNER0000000000000000A", catalog, manages: true, busy: false };
const runner: Runner = {
  id: owner.runnerId,
  name: "goldbox",
  ownerUserId: "owner",
  status: "active",
  metrics: null,
  os: null,
  version: "1.2.0",
  idle: true,
  codingAgents: [claude, codex],
};
const view = { now, serverVersion: null, policy: null, userId: null, role: "owner", busy: false };

describe("runner card coding agents", () => {
  test("shows each installed version, the newest eligible one, and Update and Roll back", () => {
    const html = runnerCodingAgentsMarkup([claude, codex], owner);
    expect(html).toContain(
      '<b>Claude</b><span class="mono">2.0.0</span><span class="muted">Newest eligible <span class="mono">2.1.0</span></span></span><span class="tag warn">Update available</span>',
    );
    expect(html).toContain(
      `<button class="btn" data-agent-update="claude" data-runner="${owner.runnerId}" data-version="2.1.0"`,
    );
    expect(html).toContain(">Update to 2.1.0</button>");
    expect(html).toContain('data-agent-rollback="claude"');
    expect(html).toContain(">Roll back to 1.8.0</button>");
    expect(html).toContain(
      '<b>Codex</b><span class="mono">0.9.0</span></span><span class="tag ok">Up to date</span>',
    );
    expect(html).not.toContain('data-agent-update="codex"');
    expect(html).not.toContain('data-agent-rollback="codex"');
  });

  test("only an eligible version is offered, and members who do not manage runners get no buttons", () => {
    const ineligible = runnerCodingAgentsMarkup([claude], {
      ...owner,
      catalog: [{ agent: "claude", offered: null, refused: [], checkedAt: now }],
    });
    expect(ineligible).toContain("No eligible version yet");
    expect(ineligible).not.toContain("data-agent-update");
    // An older version than the one installed is never offered as an update.
    expect(
      runnerCodingAgentsMarkup([claude], {
        ...owner,
        catalog: [{ agent: "claude", offered: "1.9.0", refused: [], checkedAt: now }],
      }),
    ).not.toContain("data-agent-update");
    const member = runnerCodingAgentsMarkup([claude], { ...owner, manages: false });
    expect(member).not.toContain("<button");
    expect(member).toContain("Update available");
  });

  test("an update in flight shows Installing, the sessions it waits for, or the error", () => {
    const installing = runnerCodingAgentsMarkup([pending("installing")], owner);
    expect(installing).toContain('<span class="tag running">Installing</span>');
    expect(installing).toContain("Installing 2.1.0. Sessions use 2.0.0 until it is in place.");
    expect(installing).not.toContain("data-agent-update");
    expect(installing).not.toContain("data-agent-rollback");

    const waiting = runnerCodingAgentsMarkup([pending("waiting", { sessions: 2 })], owner);
    expect(waiting).toContain('<span class="tag running">Waiting for 2 sessions to finish</span>');
    expect(waiting).toContain("Switches to 2.1.0 when they end. They keep 2.0.0.");

    const error =
      "Coding agent claude 2.1.0 was not installed: npm's integrity is not the one Paws sent";
    const failed = runnerCodingAgentsMarkup([pending("failed", { error })], owner);
    expect(failed).toContain('<span class="tag bad">Install failed</span>');
    expect(failed).toContain(
      `<p class="runner-skill-error" role="note">${error.replace("'", "&#39;")}</p>`,
    );
    // After a failure the person can try again or roll back.
    expect(failed).toContain(">Update to 2.1.0</button>");
    expect(failed).toContain(">Roll back to 1.8.0</button>");

    const rollback = runnerCodingAgentsMarkup(
      [pending("waiting", { version: "1.8.0", rollback: true, sessions: 1 })],
      owner,
    );
    expect(rollback).toContain("Waiting for 1 session to finish");
    expect(rollback).toContain("Switches back to 1.8.0 when they end.");
  });

  test("the runner card has a Coding agents block, and older runners say how to get one", () => {
    const detail = runnerDetailMarkup(runner, { ...view, catalog });
    expect(detail).toContain(`<h3 id="runner-${owner.runnerId}-coding-agents">Coding agents</h3>`);
    expect(detail).toContain(">Update to 2.1.0</button>");
    expect(renderToStaticMarkup(<>{themedMarkup(detail)}</>)).toContain("Update to 2.1.0");
    expect(runnerDetailMarkup({ ...runner, codingAgents: [] }, view)).toContain(
      "This runner does not report its coding agent versions.",
    );
    const { codingAgents: _, ...older } = runner;
    expect(runnerDetailMarkup(older, view)).not.toContain("-coding-agents");
    expect(runnerDetailMarkup({ ...runner, status: "revoked" }, view)).not.toContain(
      "-coding-agents",
    );
  });

  test("Update all runners appears for owners and admins while an agent is behind", () => {
    expect(codingAgentsBehind([runner], catalog)).toBe(1);
    expect(
      codingAgentsBehind([{ ...runner, codingAgents: [pending("installing")] }], catalog),
    ).toBe(0);
    const list = agentCatalogMarkup(catalog, now, { manages: true, busy: false, behind: 1 });
    expect(list).toContain(">Update all runners</button>");
    expect(list).toContain("1 coding agent on your runners is behind the newest eligible version.");
    expect(
      agentCatalogMarkup(catalog, now, { manages: false, busy: false, behind: 1 }),
    ).not.toContain("Update all runners");
    expect(
      agentCatalogMarkup(catalog, now, { manages: true, busy: false, behind: 0 }),
    ).not.toContain("Update all runners");
  });
});
