import { createHash } from "node:crypto";

/** One step of the member's exe.dev VM setup, as the Runners page shows it. */
export type OnboardingVmStep = {
  step: "create" | "install" | "enroll" | "health";
  state: "done" | "running" | "failed" | "pending";
};

/** The runner that will run the task, or why there is none yet. */
export type OnboardingRunner =
  /** An eligible runner. `sharedBy` names the project lead who shares it, when it is not the member's. */
  | { state: "ready"; id: string; name: string; sharedBy?: string }
  /** The member's own runner, or the lead's shared one when `sharedBy` is set, is not reachable. */
  | { state: "offline" | "paused"; id?: string; name: string; sharedBy?: string }
  | { state: "setting-up"; name: string; steps: OnboardingVmStep[] }
  | { state: "failed"; name: string; failure: string; steps: OnboardingVmStep[] }
  /** Nothing is eligible. `reason` says why when Paws knows, such as an unshared lead runner. */
  | { state: "needed"; reason?: string };

export type OnboardingAgent = "connected" | "expired" | "waiting";

/** Runner and coding-agent state for one member. Reads SQLite only. */
export type OnboardingReadiness = {
  runner: OnboardingRunner;
  agents: { claude: OnboardingAgent; codex: OnboardingAgent };
  /** The member already has an exe.dev VM, so the page does not offer Create VM again. */
  memberVm: boolean;
};

export type OnboardingReadinessReader = (input: {
  workspaceId: string;
  /** The `workspace_user` id of the member. */
  userId: string;
  /** The Linear team of the issue. */
  teamId: string;
  /** Linear user ids of the leads of the issue's Linear projects, who may share a runner. */
  projectLeadIds: readonly string[];
  now: number;
}) => OnboardingReadiness;

export type OnboardingPageInput = {
  identifier: string;
  issueUrl: string | null;
  teamName: string | null;
  member: { name: string; email: string | null };
  /** Active, not an observer, and in the issue's team. */
  memberOfTeam: boolean;
  /** Observers cannot own a runner, so the page offers neither Create VM nor Add a host. */
  observer: boolean;
  readiness: OnboardingReadiness;
  github: { login: string } | null;
  /** Paws can create a VM for the member, so the runner step offers Create VM. */
  createVm: boolean;
  /** The CSRF token of the viewer's Paws session, for the Create VM and Add a host requests. */
  csrfToken: string;
  /**
   * The form that starts the consented GitHub credit link, or null when it cannot be offered
   * (already linked, an observer, or no GitHub App client metadata). `action` is this page's own
   * `/onboard/<id>/github`; `csrf` is the viewer's session token.
   */
  githubLink?: { action: string; csrf: string } | null;
};

type StepState = "done" | "needed" | "running" | "failed" | "later" | "optional";

/** A link, or a button the page script handles with an existing dashboard route. */
type Action =
  | { href: string; label: string }
  | { button: "create-vm" | "retry-vm" | "add-host"; label: string };

type Step = {
  title: string;
  state: StepState;
  label: string;
  detail: string;
  actions?: Action[];
  vmSteps?: OnboardingVmStep[];
  /** Trusted markup below the detail, such as a form. Built here from escaped values only. */
  form?: string;
};

/** The dashboard page that also has Create VM and Add a host. */
const RUNNERS_PAGE = "/status/runners";
/** How often the page re-reads itself while a VM is being set up, and otherwise. */
const VM_POLL_MS = 3_000;
const POLL_MS = 15_000;

const VM_STEPS: Record<OnboardingVmStep["step"], string> = {
  create: "Create the VM",
  install: "Install the runner",
  enroll: "Pair with Paws",
  health: "First heartbeat",
};
const VM_STATES: Record<OnboardingVmStep["state"], string> = {
  done: "Done",
  running: "Running",
  failed: "Failed",
  pending: "Waiting",
};

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
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}
.action{display:inline-block;font:inherit;cursor:pointer;color:#17151f;font-weight:600;border:2px solid #17151f;padding:6px 12px;text-decoration:none;background:#ff7a3d}
.action.quiet{background:#fff}
.action:disabled{opacity:.6;cursor:progress}
.vm{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:4px;font-size:.85rem}
.vm li{display:flex;justify-content:space-between;border:0;padding:0}
.vm .failed{color:#a1300b;background:none}
.host{margin:16px 0 0;border:2px solid #17151f;padding:14px;display:grid;gap:10px}
.host form{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
.host label{display:grid;gap:4px;font-size:.85rem;flex:1}
.host input{font:inherit;border:2px solid #17151f;padding:6px 8px}
pre{white-space:pre-wrap;word-break:break-all;background:#17151f;color:#fdfcf8;padding:12px;font-size:.8rem;margin:0}
.error{color:#a1300b;font-weight:600}
form[method="post"]{margin:10px 0 0;display:grid;gap:8px;font-size:.85rem}
form[method="post"] button{justify-self:start;font:inherit;font-weight:600;border:2px solid #17151f;padding:6px 12px;background:#ff7a3d;cursor:pointer}
`;

/**
 * Runs on the page. Create VM and Retry post to the existing member VM routes, and Add a host to
 * the existing enrollment route, with the session's CSRF token. The page then re-reads itself,
 * which reads SQLite only, and swaps in the new steps, so VM progress shows without a reload and
 * a shown enrollment command stays on screen. The token is only ever in this page's memory: a
 * reload shows the form again, not the token.
 */
const SCRIPT = String.raw`(() => {
  const main = document.querySelector("main");
  const csrf = document.querySelector('meta[name="paws-csrf"]')?.getAttribute("content") ?? "";
  let busy = false;
  let timer = null;
  const byId = (id) => document.getElementById(id);
  const say = (text) => {
    const error = byId("runner-error");
    if (!error) return;
    error.textContent = text;
    error.hidden = text === "";
  };
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = (enrollment) => {
    const config = JSON.stringify({ ...enrollment.config, concurrency: 2 });
    return [
      "curl -fsSL https://get.paws.boo | sudo sh",
      "printf '%s\\n' " + quote(enrollment.token) + " | sudo install -o root -g root -m 0600 /dev/stdin /etc/paws-runner/enrollment-token",
      "printf '%s\\n' " + quote(config) + " | sudo install -o root -g paws-runner -m 0640 /dev/stdin /etc/paws-runner/config.json",
      "sudo /opt/paws-runner/bin/paws-runner runner enroll --config /etc/paws-runner/config.json --name " + quote(enrollment.name) + " --token-file /etc/paws-runner/enrollment-token",
      "sudo rm -f /etc/paws-runner/enrollment-token",
      "sudo systemctl enable --now paws-runner.service",
    ].join(" && \\\n  ");
  };
  const post = async (path, body) => {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-paws-csrf": csrf },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "The request failed. Try again.");
    return value;
  };
  const schedule = () => {
    const ms = Number(main?.getAttribute("data-poll") || 0);
    if (ms > 0 && timer === null) timer = setTimeout(refresh, ms);
  };
  const refresh = async () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      const response = await fetch(location.pathname, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        headers: { accept: "text/html" },
      });
      if (response.ok) {
        const next = new DOMParser().parseFromString(await response.text(), "text/html");
        const lead = next.getElementById("lead");
        if (lead) byId("lead")?.replaceWith(document.importNode(lead, true));
        const fresh = next.getElementById("steps");
        const current = byId("steps");
        if (fresh && current) {
          const now = [...current.children];
          const then = [...fresh.children];
          // Step by step, so a form the member is filling in (the GitHub consent) stays as it is.
          if (now.length !== then.length) current.replaceWith(document.importNode(fresh, true));
          else
            now.forEach((item, index) => {
              if (!(item.querySelector("form") && then[index].querySelector("form")))
                item.replaceWith(document.importNode(then[index], true));
            });
        }
        main?.setAttribute("data-poll", next.querySelector("main")?.getAttribute("data-poll") ?? "");
        // Once a runner will run the task, the enrollment command has done its job.
        const host = byId("host");
        if (host && document.querySelector("#steps [data-runner].done")) host.hidden = true;
      }
    } catch {}
    schedule();
  };
  document.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("button[data-action]");
    if (!button || busy) return;
    const action = button.getAttribute("data-action");
    if (action === "add-host") {
      const host = byId("host");
      if (!host) return;
      host.hidden = false;
      host.querySelector("input")?.focus();
      return;
    }
    if (action === "copy") {
      const text = byId("host-command-text")?.textContent ?? "";
      navigator.clipboard?.writeText(text).then(
        () => (button.textContent = "Copied"),
        () => say("The command could not be copied. Select it and copy it by hand."),
      );
      return;
    }
    busy = true;
    button.disabled = true;
    say("");
    try {
      const value = await post(action === "retry-vm" ? "/api/runners/vm/retry" : "/api/runners/vm", {});
      if (value.available === false) say("Paws cannot create a VM right now. Add a host instead.");
    } catch (error) {
      say(error.message);
    } finally {
      busy = false;
      button.disabled = false;
    }
    await refresh();
  });
  byId("host-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const output = byId("host-command");
    const submit = form.querySelector("button");
    busy = true;
    if (submit) submit.disabled = true;
    say("");
    try {
      const enrollment = await post("/api/runners/enrollments", {
        name: form.querySelector("input").value,
      });
      output.replaceChildren();
      if (!enrollment.config) {
        const error = document.createElement("p");
        error.className = "error";
        error.textContent = "Paws has no public HTTPS address for hosts. Set PAWS_PUBLIC_URL and restart Paws.";
        output.append(error);
      } else {
        const intro = document.createElement("p");
        intro.className = "detail";
        intro.textContent = "Run this on the Linux host. It installs the runner, writes its config for this Paws and enrolls with a single-use token. This step completes when the runner pairs.";
        const pre = document.createElement("pre");
        pre.id = "host-command-text";
        pre.textContent = command(enrollment);
        const expires = document.createElement("p");
        expires.className = "detail";
        expires.textContent = "The token works once and expires at " + new Date(enrollment.expiresAt).toLocaleTimeString() + ".";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "action quiet";
        copy.setAttribute("data-action", "copy");
        copy.textContent = "Copy command";
        output.append(intro, pre, expires, copy);
      }
      if (submit) submit.textContent = "Create a new command";
    } catch (error) {
      say(error.message);
    } finally {
      busy = false;
      if (submit) submit.disabled = false;
    }
  });
  schedule();
})();
`;

const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");
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

/** Create VM, when Paws can make one and the member has none, and Add a host. Never for observers. */
function setupActions(input: OnboardingPageInput): Action[] {
  if (input.observer) return [];
  const actions: Action[] = [];
  if (input.createVm && !input.readiness.memberVm)
    actions.push({ button: "create-vm", label: "Create VM" });
  actions.push({ button: "add-host", label: "Add a host" });
  return actions;
}

/** What the member can do when no runner is eligible. */
function setupHint(input: OnboardingPageInput): string {
  if (input.observer)
    return "Observers cannot own a runner. Ask a workspace member to delegate this issue.";
  return input.createVm && !input.readiness.memberVm
    ? "Create a VM, or add a host with an enrollment token. This step completes when the runner is ready."
    : "Add a host with an enrollment token. This step completes when it pairs.";
}

function runnerStep(input: OnboardingPageInput): Step {
  const { runner } = input.readiness;
  const title = "Runner";
  switch (runner.state) {
    case "ready":
      return {
        title,
        state: "done",
        label: "Ready",
        detail:
          runner.sharedBy === undefined
            ? `${runner.name} will run this task.`
            : `${runner.sharedBy}'s shared runner ${runner.name} will run this task.`,
      };
    case "offline":
    case "paused": {
      if (runner.state === "paused" && runner.sharedBy === undefined)
        return {
          title,
          state: "needed",
          label: "Ready (paused)",
          detail: `${runner.name} is paused. Sign in the coding agents this runner should use, then turn it on.`,
          actions: [
            {
              href: runner.id ? `${RUNNERS_PAGE}/${encodeURIComponent(runner.id)}` : RUNNERS_PAGE,
              label: "Open Runners",
            },
          ],
        };
      const which =
        runner.sharedBy === undefined
          ? runner.name
          : `${runner.sharedBy}'s shared runner ${runner.name}`;
      const verb = runner.state === "offline" ? "start" : "resume";
      const fix =
        runner.sharedBy === undefined
          ? `${verb === "start" ? "Start" : "Resume"} it so Paws can use it`
          : `Ask ${runner.sharedBy} to ${verb} it`;
      return {
        title,
        state: "needed",
        label: runner.state === "offline" ? "Offline" : "Paused",
        detail: input.observer
          ? `${which} is ${runner.state}. ${fix}.`
          : `${which} is ${runner.state}. ${fix}, or set up a runner of your own.`,
        actions: [
          ...setupActions(input),
          ...(runner.sharedBy === undefined ? [{ href: RUNNERS_PAGE, label: "Open Runners" }] : []),
        ],
      };
    }
    case "setting-up":
      return {
        title,
        state: "running",
        label: "In progress",
        detail: `Setting up ${runner.name}. The first setup takes a few minutes.`,
        vmSteps: runner.steps,
      };
    case "failed":
      return {
        title,
        state: "failed",
        label: "Failed",
        detail: `Setting up ${runner.name} stopped: ${runner.failure} Retry resumes from the failed step.`,
        vmSteps: runner.steps,
        actions: input.observer ? [] : [{ button: "retry-vm", label: "Retry" }],
      };
    case "needed":
      return {
        title,
        state: "needed",
        label: "Needed",
        detail: `${runner.reason ?? "You have no runner Paws can use for this task."} ${setupHint(input)}`,
        actions: setupActions(input),
      };
  }
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
          detail: input.observer
            ? "You are an observer in Paws. Observers can view the dashboard but cannot own work. Ask a workspace member to delegate this issue."
            : `You are not a member of ${team} in Linear. Ask a team admin to add you.`,
        },
    runnerStep(input),
  ];
  const names = { claude: "Claude", codex: "Codex" } as const;
  const missing = (["claude", "codex"] as const).filter((agent) => agents[agent] !== "connected");
  const expired = missing.filter((agent) => agents[agent] === "expired");
  const list = (values: readonly ("claude" | "codex")[]) =>
    values.map((agent) => names[agent]).join(" and ");
  if (runner.state !== "ready")
    steps.push({
      title: "Claude and Codex",
      state: "later",
      label: "After the runner",
      detail:
        "Sign in to both on the runner, then turn it on. Claude writes the change; Codex reviews it.",
    });
  else if (missing.length === 0)
    steps.push({
      title: "Claude and Codex",
      state: "done",
      label: "Connected",
      detail: `Both are signed in on ${runner.name}.`,
    });
  else {
    const note = expired.length > 0 ? ` The ${list(expired)} sign-in expired.` : "";
    // Only the runner's owner can sign agents in on it.
    steps.push({
      title: "Claude and Codex",
      state: "needed",
      label: expired.length > 0 ? "Sign-in expired" : "Needed",
      ...(runner.sharedBy === undefined
        ? {
            detail: `Sign in to ${list(missing)} on ${runner.name}.${note}`,
            actions: [
              {
                href: `${RUNNERS_PAGE}/${encodeURIComponent(runner.id)}`,
                label: `Sign in on ${runner.name}`,
              },
            ],
          }
        : {
            detail: `Ask ${runner.sharedBy} to sign in to ${list(missing)} on ${runner.name}.${note}`,
          }),
    });
  }
  steps.push(
    input.github
      ? {
          title: "GitHub credit",
          state: "done",
          label: "Linked",
          detail: `Commits will credit @${input.github.login}.`,
        }
      : {
          title: "GitHub credit",
          state: "optional",
          label: "Optional",
          detail: "Link GitHub to get credit on commits and pull requests (optional).",
          ...(input.githubLink
            ? {
                // Skipping is fine: Paws starts without it, and commits are by the Paws App.
                form: `<form method="post" action="${escape(
                  input.githubLink.action,
                )}"><input type="hidden" name="csrf" value="${escape(
                  input.githubLink.csrf,
                )}"><label><input type="checkbox" name="consent" value="yes" required> I consent to public commit and pull request credit using my verified GitHub identity.</label><button type="submit">Link GitHub</button></form>`,
              }
            : {}),
        },
  );
  return steps;
}

function actionMarkup(action: Action): string {
  return "href" in action
    ? `<a class="action quiet" href="${escape(action.href)}">${escape(action.label)}</a>`
    : `<button type="button" class="action" data-action="${action.button}">${escape(action.label)}</button>`;
}

function vmMarkup(steps: readonly OnboardingVmStep[]): string {
  return `<ul class="vm" aria-label="VM setup steps">${steps
    .map(
      (entry) =>
        `<li class="${entry.state}" data-vm-step="${entry.step}" data-vm-state="${entry.state}"><span>${escape(
          VM_STEPS[entry.step],
        )}</span><span>${VM_STATES[entry.state]}</span></li>`,
    )
    .join("")}</ul>`;
}

/** The onboarding page for the member who started the session. */
export function onboardingPage(input: OnboardingPageInput): Response {
  const steps = onboardingSteps(input);
  const remaining = steps.filter((step) => !["done", "optional"].includes(step.state)).length;
  const first = input.member.name.trim().split(/\s+/)[0] || input.member.name;
  const id = `<strong>${escape(input.identifier)}</strong>`;
  const { runner } = input.readiness;
  const lead =
    remaining === 0 && runner.state === "ready"
      ? `You're set up. Paws runs ${id} on ${escape(runner.name)}.`
      : `${remaining === 1 ? "One more step" : `${remaining} more steps`} before Paws starts ${id}.`;
  const items = steps
    .map(
      (step, index) =>
        `<li class="${step.state}"${step.title === "Runner" ? ` data-runner="${runner.state}"` : ""}><span class="mark" aria-hidden="true">${
          MARK[step.state] || String(index + 1)
        }</span><div><h2>${escape(step.title)}</h2><p class="detail">${escape(step.detail)}</p>${
          step.vmSteps ? vmMarkup(step.vmSteps) : ""
        }${
          step.actions?.length
            ? `<div class="actions">${step.actions.map(actionMarkup).join("")}</div>`
            : ""
        }${step.form ?? ""}</div><span class="label">${escape(step.label)}</span></li>`,
    )
    .join("");
  const links = [
    input.issueUrl
      ? `<a href="${escape(input.issueUrl)}">Open ${escape(input.identifier)} in Linear</a>`
      : "",
    `<a href="/status/issues/${escape(encodeURIComponent(input.identifier))}">Open dashboard</a>`,
  ].join("");
  // Add a host lives outside the steps, so a refresh of the steps keeps a shown command.
  const host = input.observer
    ? ""
    : `<section class="host" id="host" hidden aria-labelledby="host-heading"><h2 id="host-heading">Add a host</h2><form id="host-form"><label>Host name<input name="host-name" required maxlength="80" autocomplete="off" spellcheck="false" value="${escape(
        `${first.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "my"}-host`,
      )}"></label><button type="submit" class="action">Create command</button></form><div id="host-command" aria-live="polite"></div></section>`;
  // While something is still moving, the page re-reads itself: every few seconds while a VM is
  // being set up, otherwise every 15 s. Each read is this page, which reads only SQLite.
  const poll = remaining === 0 ? "" : String(runner.state === "setting-up" ? VM_POLL_MS : POLL_MS);
  const refresh =
    remaining === 0 ? "" : '<noscript><meta http-equiv="refresh" content="15"></noscript>';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="paws-csrf" content="${escape(
    input.csrfToken,
  )}">${refresh}<title>Paws · ${escape(
    input.identifier,
  )}</title><style>${STYLE}</style></head><body><main data-poll="${poll}"><p class="brand">Paws</p><h1>Welcome, ${escape(
    first,
  )}</h1><p class="lead" id="lead">${lead}</p><ol id="steps">${items}</ol><p class="error" id="runner-error" role="alert" hidden></p>${host}<nav>${links}</nav><p class="note">You can close this tab. Onboarding continues without it, and this page shows where it is when you come back.</p></main><script>${SCRIPT}</script></body></html>\n`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action ${
        // The credit form posts here, and its answer redirects to GitHub's authorize page.
        steps.some((step) => step.form) ? "'self' https://github.com" : "'none'"
      }`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}
