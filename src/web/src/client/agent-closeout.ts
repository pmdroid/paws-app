import type {
  StatusAgentCloseout,
  StatusCheck,
  StatusCloseoutAttempt,
  StatusVerdict,
} from "../contract";
import { renderCloseoutChecks, shownAttempt, type CloseoutView } from "./closeout";
import { durationLabel, esc, utcClock } from "./format";

const AGENT_KEY = "agent:";

export function agentCloseoutKey(runId: string): string {
  return `${AGENT_KEY}${runId}`;
}

export function agentCloseoutRun(key: string): string | null {
  return key.startsWith(AGENT_KEY) ? key.slice(AGENT_KEY.length) : null;
}

export function agentVerdict(agent: StatusAgentCloseout): StatusVerdict {
  const latest = agent.attempts.at(-1);
  return {
    itemId: agentCloseoutKey(agent.runId),
    decision: latest?.decision ?? "running",
    attempt: latest?.number ?? 1,
    maxAttempts: Math.max(agent.attempts.length, 1),
    summary: "",
    failingCheck: null,
    baseSha: null,
    headSha: latest?.headSha ?? null,
    sealed: false,
    checks: latest?.checks ?? [],
    links: [],
    attempts: agent.attempts,
  };
}

export function findAgentCloseout(
  agents: readonly StatusAgentCloseout[] | undefined,
  runId: string,
): StatusAgentCloseout | undefined {
  return agents?.find((entry) => entry.runId === runId);
}

export function agentProgress(agent: StatusAgentCloseout): string {
  const checks = agent.attempts.at(-1)?.checks ?? [];
  return `${checks.filter((check) => check.state === "passed").length} of ${checks.length} passed`;
}

export function agentSectionKey(runId: string): string {
  return `section\n${agentCloseoutKey(runId)}`;
}

export function renderAgentCloseout(
  agent: StatusAgentCloseout,
  view: CloseoutView,
  engineUrl: string | null,
  collapsed: boolean,
): string {
  const verdict = agentVerdict(agent);
  const key = agentSectionKey(agent.runId);
  const open = view.open[key] ?? !collapsed;
  const progress = agentProgress(agent);
  const toggle = collapsed
    ? `<button class="chk agent-closeout-toggle${open ? " on" : ""}" type="button" data-action="agent-closeout-toggle" data-item="${esc(verdict.itemId)}" data-attempt="${verdict.attempt}" data-open="${open}" aria-expanded="${open}"><h2>Agent Closeout</h2><span class="muted">${esc(progress)}</span><span class="check-chevron" aria-hidden="true">${open ? "⌄" : "›"}</span></button>`
    : "";
  const body = open
    ? renderCloseoutChecks(verdict, view, engineUrl, null, undefined, {
        heading: collapsed ? null : "Agent Closeout",
        result: agentResult(agent, shownAttempt(verdict, view)),
        checkAttempts: agent.maxAttempts,
      })
    : "";
  return `<section class="closeout-section agent-closeout" aria-label="Agent Closeout">${toggle}${body}</section>`;
}

function agentResult(
  agent: StatusAgentCloseout,
  attempt: StatusCloseoutAttempt,
): {
  title: string;
  description: string;
  icon: string;
} {
  const checks = attempt.checks;
  const head = attempt.headSha;
  const later = attempt.number < agent.attempts.length;
  const on = head ? ` on head ${head.slice(0, 7)}` : "";
  const passed = checks.filter((check) => check.state === "passed").length;
  const pending = checks.filter((check) => check.state === "pending").length;
  const tally = `${passed} of ${checks.length} passed${pending ? `, ${pending} pending` : ""}.`;
  const of = (check: StatusCheck) =>
    `attempt ${check.attempt ?? 1}${agent.maxAttempts === null ? "" : ` of ${agent.maxAttempts}`}`;
  const running = checks.find((check) => check.state === "running");
  if (running)
    return {
      icon: "…",
      title: esc(`${running.id} is running · ${of(running)}`),
      description: esc(
        `${(running.attempt ?? 1) > 1 ? "The agent fixed the failing check and is running it again" : "The agent is running it"}${on}${typeof running.elapsedMs === "number" ? ` for ${durationLabel(running.elapsedMs)}` : ""}. ${tally}`,
      ),
    };
  const stopped = checks.find((check) => check.state === "stopped");
  if (stopped)
    return {
      icon: "■",
      title: "Stopped: the run ended before this check finished",
      description: esc(
        `${stopped.id} ran${typeof stopped.elapsedMs === "number" ? ` for ${durationLabel(stopped.elapsedMs)}` : ""} until the run ended${agent.endedAt ? ` at ${utcClock(agent.endedAt)} UTC` : ""}${on}. ${tally}`,
      ),
    };
  const exhausted = checks.find((check) => check.state === "exhausted");
  if (exhausted)
    return {
      icon: "✕",
      title: esc(`${exhausted.id} is exhausted · ${of(exhausted)}`),
      description: esc(
        `The agent stopped retrying${on}. Paws asks the team how to continue. ${tally}`,
      ),
    };
  const failed = checks.find((check) => check.state === "failed");
  if (failed)
    return {
      icon: "✕",
      title: esc(`${failed.id} failed · ${of(failed)}`),
      description: esc(
        `${later ? `The agent ran it again in attempt ${attempt.number + 1}` : "The agent is fixing the cause"}${on}. ${tally}`,
      ),
    };
  if (checks.length === 0)
    return {
      icon: "✓",
      title: "No checks required",
      description: esc("get_closeout found no required checks for these changes."),
    };
  if (passed === checks.length)
    return {
      icon: "✓",
      title: esc(`All ${checks.length} checks passed`),
      description: esc(`The agent's Closeout passed${on}.`),
    };
  return {
    icon: "…",
    title: esc(`${checks.length} checks required`),
    description: esc(`The agent has not run them all yet${on}. ${tally}`),
  };
}
