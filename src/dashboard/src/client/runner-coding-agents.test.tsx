import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  agentCatalogMarkup,
  codingAgentsBehind,
  codingAgentsButtonMarkup,
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
  pending: null,
  reportedAt: now,
};
const codex: RunnerCodingAgent = {
  agent: "codex",
  current: "0.9.0",
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
const view = { now, serverVersion: null, policy: null, userId: null, role: "admin", busy: false };

const modal = (runners: Runner[], manages = true, behind = 1) =>
  agentCatalogMarkup(catalog, runners, now, { manages, busy: false, behind });
const card = (codingAgents: RunnerCodingAgent[]) => modal([{ ...runner, codingAgents }]);

describe("coding agent versions", () => {
  test("the header button shows how many agents are behind", () => {
    expect(codingAgentsBehind([runner], catalog)).toBe(1);
    expect(
      codingAgentsBehind([{ ...runner, codingAgents: [pending("installing")] }], catalog),
    ).toBe(0);
    expect(codingAgentsButtonMarkup(1)).toContain(
      'Update coding agents <span class="cnt" aria-label="1 behind">1</span></button>',
    );
    expect(codingAgentsButtonMarkup(0)).toContain(">Coding agents up to date</button>");
  });

  test("the dialog lists each runner's version next to the newest eligible one", () => {
    const html = modal([runner]);
    expect(html).toStartWith('<dialog id="agents-dialog" aria-labelledby="agents-heading">');
    expect(html).toContain(
      '<b>goldbox</b><span class="mono">2.0.0</span><span class="muted">Newest eligible <span class="mono">2.1.0</span></span></span><span class="tag warn">Update available</span>',
    );
    expect(html).toContain(
      '<b>goldbox</b><span class="mono">0.9.0</span></span><span class="tag ok">Up to date</span>',
    );
    expect(html).toContain("1 coding agent on your runners is behind the newest eligible version.");
    expect(renderToStaticMarkup(<>{themedMarkup(html)}</>)).toContain("Update all runners");
  });

  test("an update in flight shows Installing, the sessions it waits for, or the error", () => {
    const installing = card([pending("installing")]);
    expect(installing).toContain('<span class="tag running">Installing</span>');
    expect(installing).toContain("Installing 2.1.0. Sessions use 2.0.0 until it is in place.");

    const waiting = card([pending("waiting", { sessions: 2 })]);
    expect(waiting).toContain('<span class="tag running">Waiting for 2 sessions to finish</span>');
    expect(waiting).toContain("Switches to 2.1.0 when they end. They keep 2.0.0.");

    const error =
      "Coding agent claude 2.1.0 was not installed: npm's integrity is not the one Paws sent";
    const failed = card([pending("failed", { error })]);
    expect(failed).toContain('<span class="tag bad">Install failed</span>');
    expect(failed).toContain(
      `<p class="runner-skill-error" role="note">${error.replace("'", "&#39;")}</p>`,
    );
  });

  test("Update all runners is the only action, for admins while an agent is behind", () => {
    const admin = modal([runner]);
    expect(admin.match(/<button[^>]*data-agents-update-all/g)).toHaveLength(1);
    expect(admin).not.toContain("data-agent-update=");
    const member = modal([runner], false);
    expect(member).not.toContain("Update all runners");
    expect(member).toContain('<span class="mono">2.0.0</span>');
    expect(modal([runner], true, 0)).not.toContain("Update all runners");
  });

  test("the runner page keeps one line of versions", () => {
    const detail = runnerDetailMarkup(runner, view);
    expect(detail).toContain(`<h3 id="runner-${owner.runnerId}-coding-agents">Coding agents</h3>`);
    expect(runnerCodingAgentsMarkup([claude, codex])).toBe(
      '<p class="runner-skill-name" data-coding-agents><span><b>Claude</b> <span class="mono">2.0.0</span></span><span aria-hidden="true">·</span><span><b>Codex</b> <span class="mono">0.9.0</span></span></p>',
    );
    expect(detail).not.toContain('<button class="btn" data-agent-update');
    expect(runnerDetailMarkup({ ...runner, codingAgents: [] }, view)).toContain(
      "This runner does not report its coding agent versions.",
    );
    const { codingAgents: _, ...older } = runner;
    expect(runnerDetailMarkup(older, view)).not.toContain("-coding-agents");
    expect(runnerDetailMarkup({ ...runner, status: "revoked" }, view)).not.toContain(
      "-coding-agents",
    );
  });
});
