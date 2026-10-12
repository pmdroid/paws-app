import { esc } from "./format";
import { readCsrfToken } from "./github-auth";

type Runner = { id: string; name: string; status: "active" | "paused" | "draining" | "revoked" };
type Session = { role: string; authenticatedAt: number };
type Inspection = {
  code: string;
  name: string;
  requestFingerprint: string;
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

export function createRunners() {
  let root: HTMLElement | null = null;
  let runners: Runner[] = [];
  let session: Session | null = null;
  let selected: string | null = null;
  let health: Health | null = null;
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
      const [list, identity] = await Promise.all([
        api<{ runners: Runner[] }>("/api/runners"),
        api<Session>("/api/auth/session"),
      ]);
      if (current !== generation) return;
      runners = list.runners;
      session = identity;
      if (!manages()) inspection = null;
      const details =
        selected === null
          ? null
          : await api<Health>(`/api/runners/${encodeURIComponent(selected)}/health`);
      if (current === generation) health = details;
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
  async function change(action: () => Promise<void>) {
    if (busy) return;
    if (!manages() || !recent()) {
      error = "Sign in again as a workspace administrator to manage runners.";
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
    return `<section class="runner-section"><h2 id="runner-health-heading" tabindex="-1">${esc(runner.name)} health</h2><p class="muted">Last seen: ${health?.lastSeenAt ? esc(new Date(health.lastSeenAt).toLocaleString()) : "Not reported"}</p>${manages() ? `<form id="runner-health"><fieldset${disabled}><label class="field"><span>Agent</span><select name="agent" aria-label="Agent">${["claude", "codex", "grok"].map((value) => `<option${value === agent ? " selected" : ""}>${value}</option>`).join("")}</select></label><label class="field"><span>Model, optional</span><input name="model" maxlength="256" value="${esc(model)}"></label><label class="field"><span>Effort, optional</span><input name="effort" maxlength="64" value="${esc(effort)}"></label><div class="row"><button class="btn" type="submit" name="check" value="probe">Check connection</button><button class="btn" type="submit" name="check" value="login_check">Check sign-in</button></div></fieldset></form>` : ""}<ul class="runner-checks">${
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
  function paint() {
    if (!root?.isConnected) return;
    if (!available) {
      root.innerHTML = "<h1>Runners</h1><p>Connect to your Paws dashboard to see runners.</p>";
      return;
    }
    const disabled = busy || !recent() ? " disabled" : "";
    root.innerHTML = `<div class="between"><h1>Runners</h1><button class="btn" data-runners-refresh${busy ? " disabled" : ""}>Refresh runners</button></div><p class="sub">Manage the Linux hosts that execute work delegated in Linear.</p>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}<p role="status">${busy ? "Loading runners…" : esc(feedback)}</p>${manages() && !recent() ? '<p><a href="/auth/linear">Sign in again</a> to manage runners.</p>' : ""}${manages() ? `<section class="runner-section"><h2>Pair a host</h2><form id="runner-pairing"><label class="field"><span>Pairing code from the host</span><input name="code" required pattern="[A-Fa-f0-9]{16}" maxlength="16" autocomplete="off" spellcheck="false" value="${esc(code)}"${disabled}></label><button class="btn" type="submit"${disabled}>Inspect host</button></form>${inspection ? `<div id="runner-inspection"><h3>${esc(inspection.name)}</h3><p>Compare this request fingerprint with the host before approving.</p><code>${esc(inspection.requestFingerprint)}</code><p class="muted">Expires ${esc(new Date(inspection.expiresAt).toLocaleTimeString())}</p><button class="btn primary" data-runner-approve${busy || !recent() ? " disabled" : ""}>Approve runner</button></div>` : ""}</section>` : ""}<ul class="runner-list">${runners.map((runner) => `<li><div class="between"><h2>${esc(runner.name)}</h2><span class="tag">${esc(runner.status)}</span></div><p class="muted"><code>${esc(runner.id)}</code></p><button class="btn" data-runner-health="${esc(runner.id)}"${busy ? " disabled" : ""}>View health</button>${controls(runner)}</li>`).join("")}</ul>${!busy && !runners.length && !error ? "<p>No runners are paired. Install the daemon on a Linux host and enter its pairing code.</p>" : ""}${healthView()}`;
    bind();
  }
  function bind() {
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
        if (selected !== button.dataset.runnerHealth) health = null;
        selected = button.dataset.runnerHealth!;
        void load().then(() => root?.querySelector<HTMLElement>("#runner-health-heading")?.focus());
      });
    root!.querySelector<HTMLFormElement>("#runner-health")?.addEventListener("input", (event) => {
      const data = new FormData(event.currentTarget as HTMLFormElement);
      agent = String(data.get("agent"));
      model = String(data.get("model"));
      effort = String(data.get("effort"));
    });
    root!.querySelector<HTMLFormElement>("#runner-health")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      agent = String(data.get("agent"));
      model = String(data.get("model")).trim();
      effort = String(data.get("effort")).trim();
      const type = (event as SubmitEvent).submitter?.getAttribute("value");
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
        selected = null;
        element.innerHTML = "<h1>Runners</h1><p>Connect to your Paws dashboard to see runners.</p>";
        return;
      }
      void load();
    },
    refresh() {
      if (!busy) return load();
    },
  };
}
