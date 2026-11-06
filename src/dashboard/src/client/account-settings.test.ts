import { describe, expect, test } from "bun:test";
import type { AgentSettings } from "../agent-settings";
import {
  emptyAccountSettingsView,
  readinessMarkup,
  renderAccountSettings,
  type AgentAccounts,
  type Readiness,
} from "./account-settings";
import {
  accountOrderMarkup,
  moveAccount,
  renderAccountOrder,
  setAccountList,
} from "./account-order";
import { renderAgentSettings } from "./agent-settings";
import { render } from "./render";
import { renderSettingsPage } from "./settings-pages";
import { namedStatus, signInSlots } from "./agent-accounts";
import { accountUsageMarkup } from "./runners";

const A = "01J00000000000000000000AAA";
const B = "01J00000000000000000000BBB";
const LEGACY = "legacy_claude_W1";

const ready = (state: Readiness["state"], extra: Partial<Readiness> = {}): Readiness => ({
  state,
  reason: null,
  detail: state === "eligible" ? "Eligible." : "Agent account quota cooldown.",
  until: null,
  resetUnknown: false,
  low: false,
  ...extra,
});

function accounts(canManage = true): AgentAccounts {
  return {
    revision: "rev-1",
    canManage,
    agents: [
      { agent: "claude", name: "Claude", unsupported: null },
      { agent: "grok", name: "Grok", unsupported: "Grok keeps one global login" },
    ],
    runners: [
      { id: "R1", name: "box-one", ownedByYou: true },
      { id: "R2", name: "box-two", ownedByYou: false },
    ],
    accounts: [
      {
        id: LEGACY,
        agent: "claude",
        label: "Claude default sign-in",
        legacy: true,
        enabled: true,
        concurrency: null,
        running: 0,
        sharedLimit: false,
        bindings: [],
      },
      {
        id: A,
        agent: "claude",
        label: "Team <A>",
        legacy: false,
        enabled: true,
        concurrency: 2,
        running: 1,
        sharedLimit: true,
        bindings: [
          {
            id: "b1",
            runnerId: "R1",
            runnerName: "box-one",
            ownedByYou: true,
            legacy: false,
            quotaScope: "account",
            readiness: ready("cooling-down", { resetUnknown: true, reason: "exhausted" }),
          },
          {
            id: "b2",
            runnerId: "R2",
            runnerName: "box-two",
            ownedByYou: false,
            legacy: false,
            quotaScope: "account",
            readiness: ready("auth-required", { detail: "Sign in to this account on the runner." }),
          },
        ],
      },
      {
        id: B,
        agent: "claude",
        label: "Team B",
        legacy: false,
        enabled: false,
        concurrency: null,
        running: 0,
        sharedLimit: false,
        bindings: [],
      },
    ],
  };
}

describe("agent accounts in Settings › Agents", () => {
  test("each readiness state reads as a word, with the reset or that it is unknown", () => {
    expect(readinessMarkup(ready("eligible"))).toContain('class="tag ok">Eligible');
    expect(readinessMarkup(ready("waiting"))).toContain(">Waiting<");
    expect(readinessMarkup(ready("auth-required"))).toContain(">Sign-in needed<");
    const unknown = readinessMarkup(ready("cooling-down", { resetUnknown: true }));
    expect(unknown).toContain(">Cooling down<");
    expect(unknown).toContain("Reset unknown");
    const known = readinessMarkup(ready("cooling-down", { until: Date.UTC(2026, 10, 3, 12) }));
    expect(known).toContain("Next check");
  });

  test("an admin sees shared limits, bindings, unsupported adapters and controls; labels are escaped", () => {
    const html = renderAccountSettings({ ...emptyAccountSettingsView(), data: accounts() });
    expect(html).toContain("Team &lt;A&gt;");
    expect(html).not.toContain("Team <A>");
    expect(html).toContain(
      "These 2 runners sign in to the same account, so they share one usage limit",
    );
    expect(html).toContain("Named Grok accounts are not supported: Grok keeps one global login");
    expect(html).toContain('id="account-create"');
    expect(html).not.toContain('<option value="grok">');
    expect(html).toContain('data-account-action="disable" data-account="' + A);
    expect(html).toContain('data-account-action="enable" data-account="' + B);
    expect(html).toContain("Sign in on box-one");
    expect(html).not.toContain("Sign in on box-two");
    expect(html).toContain("No runner is linked");
    expect(html).not.toContain(`data-account-action="disable" data-account="${LEGACY}"`);
  });

  test("a member links only their own runners and cannot manage accounts", () => {
    const html = renderAccountSettings({ ...emptyAccountSettingsView(), data: accounts(false) });
    expect(html).not.toContain('id="account-create"');
    expect(html).not.toContain('data-account-action="rename"');
    expect(html).toContain(
      'data-account-action="unlink" data-account="' + A + '" data-binding="b1"',
    );
    expect(html).not.toContain('data-binding="b2"');
    expect(html).toContain('<option value="R1">box-one</option>');
    expect(html).not.toContain('<option value="R2">');
  });

  test("a busy write disables the form so a repeated submit cannot send it twice", () => {
    const html = renderAccountSettings({
      ...emptyAccountSettingsView(),
      data: accounts(),
      busy: "Saving…",
    });
    expect(html).toContain('<fieldset class="col" disabled>');
  });

  test("the preview names the chosen account, the fallback reason and the policy revision", () => {
    const view = {
      ...emptyAccountSettingsView(),
      data: accounts(),
      preview: {
        role: "implementer" as const,
        repository: null,
        agent: "claude" as const,
        model: "opus",
        policyRevision: "pol-1",
        source: "defaults" as const,
        accounts: [],
        choice: {
          accountId: B,
          label: "Team B",
          bindingId: "b3",
          runnerId: "R1",
          runnerName: "box-one",
          position: 2,
          fallback: "Team A: agent account quota cooldown, reset unknown",
        },
        waiting: null,
      },
    };
    const html = renderAccountSettings(view);
    expect(html).toContain("would run as <b>Team B</b> (#2) on box-one");
    expect(html).toContain("Fallback because Team A: agent account quota cooldown, reset unknown");
    expect(html).toContain("revision pol-1");
    expect(html).toContain("It starts no work, reserves nothing and asks no provider");
    const waiting = renderAccountSettings({
      ...view,
      preview: { ...view.preview, choice: null, waiting: "No account in the order can run now." },
    });
    expect(waiting).toContain("No account in the order can run now.");
  });
});

describe("account order on the Runners page", () => {
  function settings(): AgentSettings {
    return {
      defaults: {
        implementer: { agent: "claude", model: null },
        reviewer: { agent: "codex", model: null },
        accounts: { implementer: [A, B] },
      },
      projects: [{ repo: "acme/app" }],
      revision: "cfg-1",
    };
  }
  const choices = accounts().accounts;

  test("reorder, add and remove keep the list bounded and drop empty lists", () => {
    expect(moveAccount([A, B], 1, -1)).toEqual([B, A]);
    expect(moveAccount([A, B], 0, -1)).toEqual([A, B]);
    const data = settings();
    setAccountList(data, "defaults", "implementer", []);
    expect(data.defaults.accounts).toBeUndefined();
    setAccountList(data, "0", "implementer", [B]);
    expect(data.projects[0]!.accounts).toEqual({ implementer: [B] });
  });

  test("the order shows disabled and unknown accounts and offers only accounts of the profile's agent", () => {
    const html = accountOrderMarkup(
      "defaults-implementer",
      "defaults",
      "implementer",
      "claude",
      [A, B, "01J00000000000000000000ZZZ"],
      choices,
      "",
    );
    expect(html).toContain("1. Team &lt;A&gt;");
    expect(html).toContain("Disabled, skipped");
    expect(html).toContain("Unknown or removed");
    expect(html).toContain(`<option value="${LEGACY}">`);
    expect(html).toContain('aria-label="Move Team &lt;A&gt; up" disabled');
    const codex = accountOrderMarkup(
      "defaults-reviewer",
      "defaults",
      "reviewer",
      "codex",
      [],
      choices,
      "No order.",
    );
    expect(codex).not.toContain("<option");
    expect(codex).toContain("No order.");
  });

  test("the Runners order renders each role's order, the reviewer fallback and inheritance", () => {
    const data = settings();
    data.defaults.reviewerFallback = { agent: "claude", model: "opus" };
    const html = renderAccountOrder({
      data,
      busy: null,
      error: null,
      saved: false,
      accounts: choices,
    });
    expect(html).toContain('data-account-order="defaults-implementer"');
    expect(html).toContain('data-account-order="defaults-reviewer"');
    expect(html).toContain('data-account-order="defaults-reviewerFallback"');
    expect(html).toContain('data-account-order="0-implementer"');
    expect(html).toContain("Uses the global order.");
    expect(html).toContain('data-order="save"');
    expect(
      renderAccountOrder({ data: null, busy: null, error: null, saved: false, denied: true }),
    ).toContain("Only workspace admins can change the account order.");
  });

  test("the Runners list holds the Agent accounts section and the Agents page no longer does", () => {
    const runners = render({
      route: { view: "runners", id: null },
      phase: "loading",
      error: null,
      engineUrl: "http://localhost:8787",
    }).content;
    expect(runners.indexOf('id="runner-settings"')).toBeLessThan(
      runners.indexOf('id="agent-accounts"'),
    );
    expect(runners).toContain('id="account-settings"');
    expect(runners).toContain('id="account-order-settings"');
    const detail = render({
      route: { view: "runners", id: "runner-1" },
      phase: "loading",
      error: null,
      engineUrl: "http://localhost:8787",
    }).content;
    expect(detail).not.toContain('id="agent-accounts"');
    const agents = renderSettingsPage("agents");
    expect(agents).not.toContain("account-settings");
    expect(agents).toContain("Accounts and their order are on the Runners page.");
    const form = renderAgentSettings({ data: settings(), busy: null, error: null, saved: false });
    expect(form).not.toContain("data-account-order");
    expect(form).not.toContain("Account order");
  });
});

describe("runner sign-in dialog and history", () => {
  test("named bindings get their own sign-in rows after the agent's default sign-in", () => {
    const slots = signInSlots(
      [{ agent: "claude", connected: true, session: null }],
      [
        {
          bindingId: "b1",
          accountId: A,
          agent: "claude",
          label: "Team A",
          enabled: false,
          held: false,
          session: null,
        },
      ],
    );
    expect(slots.map((slot) => [slot.key, slot.title])).toEqual([
      ["claude", "Claude default sign-in"],
      ["claude:b1", "Claude: Team A"],
    ]);
    expect(
      namedStatus({
        bindingId: "b1",
        accountId: A,
        agent: "claude",
        label: "Team A",
        enabled: false,
        held: false,
        session: {
          id: "s",
          agent: "claude",
          state: "cancelled",
          expiresAt: 0,
          terminal: "",
          authorization: null,
        },
      }),
    ).toBe(
      "Sign-in not finished. The previous sign-in, if any, is kept. Disabled: new work skips this account.",
    );
  });

  test("execution history names the account, the order revision and why it fell back", () => {
    const html = accountUsageMarkup({
      commandId: "c",
      runnerId: "R1",
      runnerName: "box-one",
      runId: null,
      agent: "claude",
      resolvedModel: null,
      purpose: "work",
      outcome: null,
      startedAt: 0,
      endedAt: null,
      accountLabel: "Team B",
      accountNamed: true,
      accountPolicyRevision: "abcdef0123456789",
      accountFallback: "Team A: agent account quota cooldown",
    });
    expect(html).toContain("Account: Team B · order abcdef01");
    expect(html).toContain("Fell back because Team A: agent account quota cooldown");
    expect(
      accountUsageMarkup({
        commandId: "c",
        runnerId: "R1",
        runnerName: "box-one",
        runId: null,
        agent: "claude",
        resolvedModel: null,
        purpose: "work",
        outcome: null,
        startedAt: 0,
        endedAt: null,
      }),
    ).toBe("");
  });
});
