import { renderMarkup } from "./theme";
import { esc } from "./format";
import { readCsrfToken } from "./github-auth";

type Runner = {
  id: string;
  name: string;
  ownerUserId: string;
  status: "active" | "paused" | "draining" | "revoked";
};
type Session = { userId: string; role: string; authenticatedAt: number };
type HostPolicy = {
  ownerUserId: string;
  hostOwner?: string;
  sharing?: number;
  fallback?: number;
  agents: {
    agent: string;
    seat: string;
    ready: number;
    authExpired: number;
    quotaState: string;
    resetsAt: number | null;
    cooldownUntil: number;
  }[];
};
type WorkspacePolicy = { fallbackAllowed: boolean; personalOrganizationHost: boolean };
type Usage = {
  commandId: string;
  runnerName: string;
  agent: string | null;
  resolvedModel: string | null;
  purpose: string;
  outcome: string | null;
  startedAt: number;
  endedAt: number | null;
};
type Inspection = {
  code: string;
  name: string;
  requestFingerprint: string;
  verifierFingerprint?: string;
  expiresAt: number;
};
type Health = {
  lastSeenAt: number | null;
  checks: {
    command: { type: string; agent?: string; profile?: { agent: string } };
    expiresAt: number;
    receivedAt: number | null;
    result: {
      stopReason: string;
      authRequired: boolean;
      agentExited: boolean;
      timedOut: boolean;
      cancelled: boolean;
      errorMessage?: string;
      identity?: { model: string; provider: string };
      models?: { id: string; name: string }[];
      efforts?: { id: string; name: string }[];
      login?: { authenticated: boolean; method: string; agent: string };
    } | null;
  }[];
};
type SignedInAccount = { agent: string; connected: boolean };

export function agentConnectionReady(input: {
  lastSeenAt: number | null;
  status: Runner["status"];
  agent: string;
  accounts: SignedInAccount[];
  checks: Health["checks"];
}): boolean {
  if (input.status === "revoked" || input.lastSeenAt === null) return false;
  const login = input.checks.find(
    (check) =>
      check.command.type === "login_check" &&
      check.command.agent === input.agent &&
      check.result?.login !== undefined,
  )?.result?.login;
  if (login) return login.authenticated === true;
  return input.accounts.some((account) => account.agent === input.agent && account.connected);
}

export function createRunners() {
  let root: HTMLElement | null = null;
  let runners: Runner[] = [];
  let session: Session | null = null;
  let selected: string | null = null;
  let health: Health | null = null;
  let accounts: SignedInAccount[] = [];
  let hostPolicy: HostPolicy | null = null;
  let workspacePolicy: WorkspacePolicy | null = null;
  let setupRequired = false;
  let workspaceReady = false;
  let usage: Usage[] = [];
  let policyAgent = "claude";
  let inspection: Inspection | null = null;
  let code = "";
  let agent = "claude";
  let model = "";
  let effort = "";
  let busy = false;
  let feedback = "";
  let error = "";
  let generation = 0;
  let connection = "";
  let available = false;

  function manages() {
    return session !== null && ["owner", "admin"].includes(session.role);
  }
  function recent() {
    return (
      session !== null &&
      session.authenticatedAt <= Date.now() &&
      Date.now() - session.authenticatedAt <= 15 * 60_000
    );
  }
  async function api<T>(path: string, body?: unknown): Promise<T> {
    if (!available) throw new Error("Connect to your Paws dashboard to see runners.");
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers:
        body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "x-paws-csrf": readCsrfToken(document),
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok)
      throw Object.assign(new Error(data?.error ?? `Runner request failed (${response.status}).`), {
        status: response.status,
      });
    return data as T;
  }
  async function load() {
    const current = ++generation;
    busy = true;
    error = "";
    paint();
    try {
      const list = await api<{
        runners: Runner[];
        setupRequired?: boolean;
        workspaceReady?: boolean;
      }>("/api/runners");
      if (current !== generation) return;
      setupRequired = list.setupRequired === true;
      workspaceReady = list.workspaceReady === true;
      if (setupRequired) {
        session = null;
        runners = [];
        selected = null;
        health = null;
        accounts = [];
        hostPolicy = null;
        workspacePolicy = null;
        usage = [];
        inspection = null;
        return;
      }
      const [identity, policy, activity] = await Promise.all([
        api<Session>("/api/auth/session"),
        api<WorkspacePolicy>("/api/runners/policy"),
        api<{ usage: Usage[] }>("/api/runners/usage"),
      ]);
      if (current !== generation) return;
      runners = list.runners;
      session = identity;
      workspacePolicy = policy;
      usage = activity.usage;
      if (!manages()) inspection = null;
      const details =
        selected === null
          ? null
          : await Promise.all([
              api<Health>(`/api/runners/${encodeURIComponent(selected)}/health`),
              api<HostPolicy>(`/api/runners/${encodeURIComponent(selected)}/policy`),
              api<{ accounts: SignedInAccount[] }>(
                `/api/runners/${encodeURIComponent(selected)}/accounts`,
              ).catch(() => ({ accounts: [] as SignedInAccount[] })),
            ]);
      if (current === generation) {
        health = details?.[0] ?? null;
        hostPolicy = details?.[1] ?? null;
        accounts = details?.[2]?.accounts ?? [];
      }
    } catch (caught) {
      if (current !== generation) return;
      error = caught instanceof Error ? caught.message : "Runners could not be loaded.";
      if (
        caught instanceof Error &&
        "status" in caught &&
        [401, 403].includes(Number(caught.status))
      ) {
        session = null;
        inspection = null;
      }
    } finally {
      if (current === generation) {
        busy = false;
        paint();
      }
    }
  }
  async function change(action: () => Promise<void>, administrator = true) {
    if (busy) return;
    if (
      (administrator ? !manages() : session === null || session.role === "observer") ||
      !recent()
    ) {
      error = "Sign in again with permission to update these runner settings.";
      paint();
      return;
    }
    const active =
      document.activeElement instanceof HTMLButtonElement
        ? {
            text: document.activeElement.textContent,
            runner: document.activeElement.dataset.runner,
          }
        : null;
    busy = true;
    error = "";
    feedback = "";
    paint();
    try {
      await action();
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The runner change failed.";
    } finally {
      busy = false;
      paint();
      const target =
        active === null
          ? null
          : [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
              (button) =>
                button.textContent === active.text && button.dataset.runner === active.runner,
            );
      (target ?? root?.querySelector<HTMLButtonElement>("[data-runners-refresh]"))?.focus({
        preventScroll: true,
      });
    }
  }
  function controls(runner: Runner) {
    if (!manages() || runner.status === "revoked") return "";
    const disabled = busy || !recent() ? " disabled" : "";
    return `<div class="row">${runner.status === "active" ? `<button class="btn" data-runner-status="paused" data-runner="${esc(runner.id)}"${disabled}>Pause</button>` : `<button class="btn" data-runner-status="active" data-runner="${esc(runner.id)}"${disabled}>Resume</button>`}${runner.status !== "draining" ? `<button class="btn" data-runner-status="draining" data-runner="${esc(runner.id)}"${disabled}>Drain</button>` : ""}<details><summary>Revoke access</summary><p>Disconnect this runner and stop accepting its work.</p><button class="btn" data-runner-status="revoked" data-runner="${esc(runner.id)}"${disabled}>Revoke runner</button></details></div>`;
  }
  function healthView() {
    const runner = runners.find((entry) => entry.id === selected);
    if (!runner) return "";
    const disabled = busy || !recent() || runner.status === "revoked" ? " disabled" : "";
    const ready = agentConnectionReady({
      lastSeenAt: health?.lastSeenAt ?? null,
      status: runner.status,
      agent,
      accounts,
      checks: health?.checks ?? [],
    });
    const connectionNote =
      disabled || ready
        ? ""
        : health?.lastSeenAt == null
          ? '<p class="muted">Install and start this runner, then sign in before checking the connection.</p>'
          : '<p class="muted">Sign in to this agent on the runner and check sign-in before checking the connection.</p>';
    return `<section class="runner-section"><h2 id="runner-health-heading" tabindex="-1">${esc(runner.name)} health</h2><p class="muted">Last seen: ${health?.lastSeenAt ? esc(new Date(health.lastSeenAt).toLocaleString()) : "Not reported"}</p>${manages() ? `<form id="runner-health"><fieldset${disabled}><label class="field"><span>Agent</span><select name="agent" aria-label="Agent">${["claude", "codex", "grok"].map((value) => `<option${value === agent ? " selected" : ""}>${value}</option>`).join("")}</select></label><label class="field"><span>Model, optional</span><input name="model" maxlength="256" value="${esc(model)}"></label><label class="field"><span>Effort, optional</span><input name="effort" maxlength="64" value="${esc(effort)}"></label><div class="row"><button class="btn" type="submit" name="check" value="probe"${ready ? "" : " disabled"}>Check connection</button><button class="btn" type="submit" name="check" value="login_check">Check sign-in</button></div>${connectionNote}</fieldset></form>` : ""}<ul class="runner-checks">${
      health?.checks
        .map((check) => {
          const result = check.result;
          const name = check.command.type === "login_check" ? "Sign-in" : "Connection";
          const provider = check.command.agent ?? check.command.profile?.agent ?? "Agent";
          const status =
            result === null
              ? check.expiresAt <= Date.now()
                ? "Expired"
                : "Pending"
              : result.login
                ? result.login.authenticated
                  ? `Signed in via ${result.login.method.replaceAll("_", " ")}`
                  : "Not signed in"
                : result.errorMessage ||
                    !result.agentExited ||
                    result.authRequired ||
                    result.timedOut ||
                    result.cancelled ||
                    result.stopReason !== "end_turn"
                  ? "Check failed"
                  : "Connection complete";
          return `<li><b>${esc(provider)} · ${name}</b><p>${esc(status)}</p>${result?.identity ? `<p>${esc(result.identity.provider)} · ${esc(result.identity.model)}</p>` : ""}${result?.models?.length ? `<p>Models: ${result.models.map((entry) => esc(entry.name)).join(", ")}</p>` : ""}${result?.efforts?.length ? `<p>Efforts: ${result.efforts.map((entry) => esc(entry.name)).join(", ")}</p>` : ""}${result?.errorMessage ? `<p class="err">${esc(result.errorMessage)}</p>` : ""}</li>`;
        })
        .join("") ?? ""
    }</ul>${health && !health.checks.length ? '<p class="muted">No health checks yet.</p>' : ""}</section>`;
  }
  function policyView() {
    if (!selected || !hostPolicy) return "";
    const own = session?.userId === hostPolicy.ownerUserId && session.role !== "observer";
    const agentPolicy = hostPolicy.agents.find((value) => value.agent === policyAgent);
    const disabled = !own || busy || !recent() ? " disabled" : "";
    const options = (values: readonly [string, string][], current: string) =>
      values
        .map(
          ([value, label]) =>
            `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`,
        )
        .join("");
    return `<details class="runner-section" id="runner-sharing"><summary>Work sharing and account type</summary><p>Choose how this host can accept work from your Linear projects.</p><form id="runner-policy"><fieldset${disabled}><label class="field"><span>Agent account</span><select name="agent">${options(
      [
        ["claude", "Claude"],
        ["codex", "Codex"],
        ["grok", "Grok"],
      ],
      policyAgent,
    )}</select></label><label class="field"><span>Host owner</span><select name="hostOwner">${options(
      [
        ["unknown", "Not declared"],
        ["member", "Me"],
        ["workspace", "My workspace"],
      ],
      hostPolicy.hostOwner ?? "unknown",
    )}</select></label><label class="field"><span>Account type</span><select name="seat">${options(
      [
        ["unknown", "Not declared"],
        ["personal", "Personal subscription"],
        ["organization", "Organization account"],
        ["api", "API account"],
      ],
      agentPolicy?.seat ?? "unknown",
    )}</select></label><label class="runner-consent"><input type="checkbox" name="sharing"${hostPolicy.sharing ? " checked" : ""}><span>Share this host with members of the same Linear project</span></label><label class="runner-consent"><input type="checkbox" name="fallback"${hostPolicy.fallback ? " checked" : ""}><span>Use this workspace API host as a fallback</span></label><button class="btn" type="submit">Save host settings</button></fieldset></form>${!own ? '<p class="muted">The host owner controls its sharing settings.</p>' : !recent() ? '<p><a href="/auth/linear">Sign in again</a> to change these settings.</p>' : ""}<p class="muted">${agentPolicy?.authExpired ? "Agent sign-in needs attention." : agentPolicy?.ready ? "Agent connection verified." : "Agent connection has not been checked."}${agentPolicy?.quotaState === "exhausted" ? ` Usage limit reached.${agentPolicy.resetsAt ? ` Resets ${esc(new Date(agentPolicy.resetsAt).toLocaleString())}.` : agentPolicy.cooldownUntil > Date.now() ? ` Next check ${esc(new Date(agentPolicy.cooldownUntil).toLocaleString())}.` : ""}` : agentPolicy?.quotaState === "low" ? " Remaining usage is low." : ""}</p></details>`;
  }
  function workspacePolicyView() {
    if (session?.role !== "owner" || !workspacePolicy) return "";
    return `<details class="runner-section"><summary>Workspace execution permission</summary><form id="workspace-runner-policy"><fieldset${busy || !recent() ? " disabled" : ""}><label class="runner-consent"><input name="fallbackAllowed" type="checkbox"${workspacePolicy.fallbackAllowed ? " checked" : ""}><span>Allow configured API hosts to take over when another account is unavailable</span></label><label class="runner-consent"><input name="personalOrganizationHost" type="checkbox"${workspacePolicy.personalOrganizationHost ? " checked" : ""}><span>Allow personal subscriptions on workspace hosts</span></label><button class="btn" type="submit">Save workspace permission</button></fieldset></form></details>`;
  }
  function usageView() {
    return `<details class="runner-section"><summary>Recent execution</summary>${
      usage.length
        ? `<ul class="runner-checks">${usage
            .slice(0, 30)
            .map(
              (entry) =>
                `<li><b>${esc(entry.runnerName)} · ${esc(entry.purpose)}</b><p>${esc(entry.agent ?? "Checks")}${entry.resolvedModel ? ` · ${esc(entry.resolvedModel)}` : ""} · ${esc(entry.outcome?.replaceAll("_", " ") ?? "Running")}</p><p class="muted">${esc(new Date(entry.startedAt).toLocaleString())}${entry.endedAt === null ? "" : ` · ${Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1000))} seconds`}</p></li>`,
            )
            .join("")}</ul>`
        : '<p class="muted">No execution has been recorded yet.</p>'
    }</details>`;
  }
  function paint() {
    if (!root?.isConnected) return;
    if (!available) {
      renderMarkup(
        root,
        '<h1 class="sr-only">Runners</h1><p>Connect to your Paws dashboard to see runners.</p>',
      );
      return;
    }
    if (setupRequired) {
      renderMarkup(
        root,
        `<h1 class="sr-only">Runners</h1><p class="sub">Connect a Linux host to execute work delegated in Linear.</p><section class="runner-section" aria-labelledby="runner-setup-heading"><h2 id="runner-setup-heading">Set up remote runners</h2><p>Enable secure runner access on your Paws server to pair a host.</p><ol>${workspaceReady ? "" : '<li>Configure workspace sign-in over HTTPS. <a href="https://github.com/pmdroid/paws-app/blob/main/docs/workspace-access.md" target="_blank" rel="noopener noreferrer">Open the workspace setup guide</a>.</li>'}<li>Initialize the runner identity once on the Paws server: <code>bun run paws runner-authority init</code>.</li><li>Enable the runner listener with <code>PAWS_RUNNER_HOST</code>, then restart Paws with your HTTPS workspace configuration.</li><li>On the Linux host, install the runner: <code>curl -fsSL https://get.paws.boo | sudo sh</code>.</li></ol><p>Sign in as a workspace owner or admin to approve the host's pairing code.</p><button class="btn" data-runners-refresh${busy ? " disabled" : ""}>${busy ? "Checking setup…" : "Check setup"}</button>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}</section>`,
      );
      root.querySelector("[data-runners-refresh]")?.addEventListener("click", () => void load());
      return;
    }
    const disabled = busy || !recent() ? " disabled" : "";
    renderMarkup(
      root,
      `<div class="between"><h1 class="sr-only">Runners</h1><button class="btn" data-runners-refresh${busy ? " disabled" : ""}>Refresh runners</button></div><p class="sub">Manage the Linux hosts that execute work delegated in Linear.</p>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}<p role="status">${busy ? "Loading runners…" : esc(feedback)}</p>${manages() && !recent() ? '<p><a href="/auth/linear">Sign in again</a> to manage runners.</p>' : ""}${manages() ? `<section class="runner-section"><h2>Pair a host</h2><p>On the Linux host, run <code>curl -fsSL https://get.paws.boo | sudo sh</code>.</p><form id="runner-pairing"><label class="field"><span>Pairing code from the host</span><input name="code" required pattern="[A-Fa-f0-9]{16}" maxlength="16" autocomplete="off" spellcheck="false" value="${esc(code)}"${disabled}></label><button class="btn" type="submit"${disabled}>Inspect host</button></form>${inspection ? `<div id="runner-inspection"><h3>${esc(inspection.name)}</h3><p>${inspection.verifierFingerprint ? "Compare both fingerprints with the host before approving." : "Compare this request fingerprint with the host before approving."}</p>${inspection.verifierFingerprint ? "<p>Connection fingerprint</p>" : ""}<code>${esc(inspection.requestFingerprint)}</code>${inspection.verifierFingerprint ? `<p>Verification key fingerprint</p><code>${esc(inspection.verifierFingerprint)}</code>` : ""}<p class="muted">Expires ${esc(new Date(inspection.expiresAt).toLocaleTimeString())}</p><button class="btn primary" data-runner-approve${busy || !recent() ? " disabled" : ""}>Approve runner</button></div>` : ""}</section>` : ""}<ul class="runner-list">${runners.map((runner) => `<li><div class="between"><h2>${esc(runner.name)}</h2><span class="tag">${esc(runner.status)}</span></div><p class="muted"><code>${esc(runner.id)}</code></p><button class="btn" data-runner-health="${esc(runner.id)}"${busy ? " disabled" : ""}>View health</button>${controls(runner)}</li>`).join("")}</ul>${!busy && !runners.length && !error ? "<p>No runners are paired. On the Linux host, run <code>curl -fsSL https://get.paws.boo | sudo sh</code> and enter its pairing code.</p>" : ""}${healthView()}${policyView()}${workspacePolicyView()}${usageView()}`,
    );
    bind();
  }
  function bind() {
    root!
      .querySelector<HTMLSelectElement>('#runner-policy select[name="agent"]')
      ?.addEventListener("change", (event) => {
        policyAgent = (event.target as HTMLSelectElement).value;
        paint();
        const details = root!.querySelector<HTMLDetailsElement>("#runner-sharing");
        if (details) details.open = true;
        root!.querySelector<HTMLSelectElement>('#runner-policy select[name="agent"]')?.focus();
      });
    root!.querySelector<HTMLFormElement>("#runner-policy")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      void change(async () => {
        await api(`/api/runners/${encodeURIComponent(selected!)}/policy`, {
          agent: String(data.get("agent")),
          hostOwner: String(data.get("hostOwner")),
          seat: String(data.get("seat")),
          sharing: data.has("sharing"),
          fallback: data.has("fallback"),
        });
        feedback = "Host settings saved.";
      }, false);
    });
    root!
      .querySelector<HTMLFormElement>("#workspace-runner-policy")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        void change(async () => {
          await api("/api/runners/policy", {
            fallbackAllowed: data.has("fallbackAllowed"),
            personalOrganizationHost: data.has("personalOrganizationHost"),
          });
          feedback = "Workspace execution permission saved.";
        });
      });
    root!.querySelector("[data-runners-refresh]")?.addEventListener("click", () => void load());
    root!
      .querySelector<HTMLInputElement>('input[name="code"]')
      ?.addEventListener("input", (event) => {
        code = (event.target as HTMLInputElement).value.toUpperCase();
        inspection = null;
        root!.querySelector("#runner-inspection")?.remove();
      });
    root!.querySelector("#runner-pairing")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void change(async () => {
        const result = await api<Omit<Inspection, "code">>("/api/runners/pairings/inspect", {
          code,
        });
        inspection = { ...result, code };
      });
    });
    root!.querySelector("[data-runner-approve]")?.addEventListener(
      "click",
      () =>
        void change(async () => {
          if (inspection === null) return;
          await api("/api/runners/pairings/approve", {
            code: inspection.code,
            ...(inspection.verifierFingerprint
              ? { verifierFingerprint: inspection.verifierFingerprint }
              : {}),
          });
          inspection = null;
          code = "";
          feedback = "Runner approved. The host can complete pairing.";
        }),
    );
    for (const button of root!.querySelectorAll<HTMLElement>("[data-runner-status]"))
      button.addEventListener(
        "click",
        () =>
          void change(async () => {
            await api(`/api/runners/${encodeURIComponent(button.dataset.runner!)}/status`, {
              status: button.dataset.runnerStatus,
            });
            feedback = "Runner status updated.";
          }),
      );
    for (const button of root!.querySelectorAll<HTMLElement>("[data-runner-health]"))
      button.addEventListener("click", () => {
        if (selected !== button.dataset.runnerHealth) {
          health = null;
          accounts = [];
        }
        selected = button.dataset.runnerHealth!;
        void load().then(() => root?.querySelector<HTMLElement>("#runner-health-heading")?.focus());
      });
    root!.querySelector<HTMLFormElement>("#runner-health")?.addEventListener("input", (event) => {
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const nextAgent = String(data.get("agent"));
      model = String(data.get("model"));
      effort = String(data.get("effort"));
      if (nextAgent === agent) return;
      agent = nextAgent;
      paint();
      root?.querySelector<HTMLSelectElement>('#runner-health select[name="agent"]')?.focus();
    });
    root!.querySelector<HTMLFormElement>("#runner-health")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      agent = String(data.get("agent"));
      model = String(data.get("model")).trim();
      effort = String(data.get("effort")).trim();
      const type = (event as SubmitEvent).submitter?.getAttribute("value");
      const runner = runners.find((entry) => entry.id === selected);
      if (
        type !== "login_check" &&
        !agentConnectionReady({
          lastSeenAt: health?.lastSeenAt ?? null,
          status: runner?.status ?? "revoked",
          agent,
          accounts,
          checks: health?.checks ?? [],
        })
      ) {
        error = "Sign in on this installed runner before checking the connection.";
        paint();
        return;
      }
      void change(async () => {
        const body =
          type === "login_check"
            ? { type, agent }
            : {
                type: "probe",
                profile: { agent, model: model || null, ...(effort ? { effort } : {}) },
              };
        await api(`/api/runners/${encodeURIComponent(selected!)}/health`, body);
        feedback = "Health check queued. Refresh runners to read the result.";
      });
    });
  }
  return {
    mount(element: HTMLElement, engine: string | null, source: string | undefined) {
      const nextConnection = `${engine}:${source}`;
      if (root === element && connection === nextConnection) return;
      root = element;
      connection = nextConnection;
      available =
        engine !== null && new URL(engine).origin === location.origin && source === "live";
      if (!available) {
        generation++;
        session = null;
        runners = [];
        inspection = null;
        health = null;
        accounts = [];
        hostPolicy = null;
        workspacePolicy = null;
        usage = [];
        selected = null;
        setupRequired = false;
        workspaceReady = false;
        renderMarkup(
          element,
          '<h1 class="sr-only">Runners</h1><p>Connect to your Paws dashboard to see runners.</p>',
        );
        return;
      }
      void load();
    },
    refresh() {
      if (!busy) return load();
    },
  };
}
