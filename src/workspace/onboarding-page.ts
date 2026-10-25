import { createHash } from "node:crypto";

/** The member's runner, as onboarding sees it. */
export type OnboardingRunner =
  | { state: "ready"; name: string }
  | { state: "offline" | "paused"; name: string }
  | { state: "setting-up"; name: string }
  | { state: "failed"; name: string; failure: string }
  | { state: "needed" };

export type OnboardingAgent = "connected" | "expired" | "waiting";

/** Runner and coding-agent state for one member. Reads SQLite only. */
export type OnboardingReadiness = {
  runner: OnboardingRunner;
  agents: { claude: OnboardingAgent; codex: OnboardingAgent };
};

export type OnboardingReadinessReader = (input: {
  workspaceId: string;
  /** The `workspace_user` id of the member. */
  userId: string;
  /** The Linear team of the issue. */
  teamId: string;
  now: number;
}) => OnboardingReadiness;

export type OnboardingPageInput = {
  identifier: string;
  issueUrl: string | null;
  teamName: string | null;
  member: { name: string; email: string | null };
  /** Active, not an observer, and in the issue's team. */
  memberOfTeam: boolean;
  readiness: OnboardingReadiness;
  github: { login: string } | null;
};

type StepState = "done" | "needed" | "running" | "failed" | "later" | "optional";

type Step = { title: string; state: StepState; label: string; detail: string };

const STYLE = `
:root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17151f;background:#c3b6f0}
body{margin:0;padding:48px 16px}
main{max-width:600px;margin:0 auto;background:#fdfcf8;border:2px solid #17151f;box-shadow:6px 6px 0 #17151f;padding:32px}
.brand{display:flex;gap:8px;align-items:center;font-weight:600;margin:0 0 16px}
.brand::before{content:"";width:16px;height:16px;border-radius:3px;background:#ff7a3d;border:1.5px solid #17151f}
h1{font-size:1.75rem;margin:0 0 8px}
.lead{margin:0 0 24px;color:#3b3748}
ol{list-style:none;margin:0;padding:0;display:grid;gap:12px}
li{display:grid;grid-template-columns:36px 1fr auto;gap:12px;align-items:start;border:2px solid #17151f;padding:14px}
li.later,li.optional{border-style:dashed}
li.failed{background:#fdeee7}
.mark{width:32px;height:32px;display:grid;place-items:center;border:2px solid #17151f;font-weight:700}
.done .mark{background:#bfe8c8}
.needed .mark,.failed .mark{background:#ff7a3d}
h2{font-size:1rem;margin:0 0 4px}
p{margin:0;line-height:1.4}
.detail{color:#3b3748;font-size:.9rem}
.label{font-size:.75rem;border:1.5px solid #17151f;padding:2px 8px;white-space:nowrap}
.done .label{background:#bfe8c8}
.needed .label{background:#ded6fb}
.failed .label{background:#f6c6b5}
nav{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0 0}
nav a{color:#17151f;font-weight:600;border:2px solid #17151f;padding:8px 14px;text-decoration:none;background:#fff}
nav a:first-child{background:#ff7a3d}
.note{margin:20px 0 0;font-size:.85rem;color:#3b3748}
`;
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");
const MARK: Record<StepState, string> = {
  done: "✓",
  needed: "",
  running: "…",
  failed: "!",
  later: "",
  optional: "+",
};

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The steps in the order the member goes through them. */
export function onboardingSteps(input: OnboardingPageInput): Step[] {
  const team = input.teamName ?? "the issue's team";
  const { runner, agents } = input.readiness;
  const steps: Step[] = [
    {
      title: "Linear",
      state: "done",
      label: "Done",
      detail: `Signed in as ${input.member.email ?? input.member.name}.`,
    },
    input.memberOfTeam
      ? { title: "Membership", state: "done", label: "Done", detail: `Member of ${team}.` }
      : {
          title: "Membership",
          state: "needed",
          label: "Needed",
          detail: `You are not a member of ${team} in Linear. Ask a team admin to add you.`,
        },
  ];
  switch (runner.state) {
    case "ready":
      steps.push({
        title: "Your runner",
        state: "done",
        label: "Ready",
        detail: `Paws runs ${input.identifier} on ${runner.name}.`,
      });
      break;
    case "offline":
    case "paused":
      steps.push({
        title: "Your runner",
        state: "needed",
        label: runner.state === "offline" ? "Offline" : "Paused",
        detail:
          runner.state === "offline"
            ? `${runner.name} is offline. Start it so Paws can reach it.`
            : `${runner.name} is paused. Resume it so Paws can use it.`,
      });
      break;
    case "setting-up":
      steps.push({
        title: "Your runner",
        state: "running",
        label: "In progress",
        detail: `Setting up ${runner.name}. The first setup takes a few minutes.`,
      });
      break;
    case "failed":
      steps.push({
        title: "Your runner",
        state: "failed",
        label: "Failed",
        detail: `Setting up ${runner.name} stopped: ${runner.failure}`,
      });
      break;
    case "needed":
      steps.push({
        title: "Your runner",
        state: "needed",
        label: "Needed",
        detail: "Pair a runner you own. Paws runs your issues there.",
      });
  }
  const names = { claude: "Claude", codex: "Codex" } as const;
  const missing = (["claude", "codex"] as const).filter((agent) => agents[agent] !== "connected");
  const expired = missing.filter((agent) => agents[agent] === "expired");
  if (runner.state !== "ready")
    steps.push({
      title: "Claude and Codex",
      state: "later",
      label: "After the runner",
      detail:
        "Sign in to both on your runner once it is ready. Claude writes the change; Codex reviews it.",
    });
  else if (missing.length === 0)
    steps.push({
      title: "Claude and Codex",
      state: "done",
      label: "Connected",
      detail: `Both are signed in on ${runner.name}.`,
    });
  else
    steps.push({
      title: "Claude and Codex",
      state: "needed",
      label: expired.length > 0 ? "Sign-in expired" : "Needed",
      detail: `Sign in to ${missing.map((agent) => names[agent]).join(" and ")} on ${runner.name}.${
        expired.length > 0
          ? ` The ${expired.map((agent) => names[agent]).join(" and ")} sign-in expired.`
          : ""
      }`,
    });
  steps.push(
    input.github
      ? {
          title: "GitHub credit",
          state: "done",
          label: "Linked",
          detail: `Linked as @${input.github.login}. Your commits credit you.`,
        }
      : {
          title: "GitHub credit",
          state: "optional",
          label: "Optional",
          detail: "Link GitHub so commits Paws makes for you credit you.",
        },
  );
  return steps;
}

/** The onboarding page for the member who started the session. */
export function onboardingPage(input: OnboardingPageInput): Response {
  const steps = onboardingSteps(input);
  const remaining = steps.filter((step) => !["done", "optional"].includes(step.state)).length;
  const first = input.member.name.trim().split(/\s+/)[0] || input.member.name;
  const id = `<strong>${escape(input.identifier)}</strong>`;
  const lead =
    remaining === 0
      ? `You're set up. Paws runs ${id} on your runner.`
      : `${remaining === 1 ? "One more step" : `${remaining} more steps`} before Paws starts ${id}.`;
  const items = steps
    .map(
      (step, index) =>
        `<li class="${step.state}"><span class="mark" aria-hidden="true">${
          MARK[step.state] || String(index + 1)
        }</span><div><h2>${escape(step.title)}</h2><p class="detail">${escape(
          step.detail,
        )}</p></div><span class="label">${escape(step.label)}</span></li>`,
    )
    .join("");
  const links = [
    input.issueUrl
      ? `<a href="${escape(input.issueUrl)}">Open ${escape(input.identifier)} in Linear</a>`
      : "",
    `<a href="/status/issues/${escape(encodeURIComponent(input.identifier))}">Open dashboard</a>`,
  ].join("");
  // While something is still moving, the page reloads itself. Each reload reads only SQLite.
  const refresh = remaining === 0 ? "" : '<meta http-equiv="refresh" content="15">';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>Paws · ${escape(
    input.identifier,
  )}</title><style>${STYLE}</style></head><body><main><p class="brand">Paws</p><h1>Welcome, ${escape(
    first,
  )}</h1><p class="lead">${lead}</p><ol>${items}</ol><nav>${links}</nav><p class="note">You can close this tab. Onboarding continues without it, and this page shows where it is when you come back.</p></main></body></html>\n`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}
