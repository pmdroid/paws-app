import { esc } from "./format";
import { renderMarkup } from "./theme";

type DoctorCheck = { name: string; ok: boolean; detail: string; fix?: string; note?: boolean };

export function renderDoctorChecks(checks: readonly DoctorCheck[] | null, error = ""): string {
  const heading =
    '<div class="between"><div><h2>Prerequisites</h2><p class="sub">What Paws needs on this host: tools, Linear, the GitHub App, agents, Closeout and webhooks.</p></div><button class="btn" type="button" data-doctor-refresh>Check again</button></div>';
  const body =
    error !== ""
      ? `<p class="text-state-failed" role="alert">${esc(error)}</p>`
      : checks === null
        ? '<p class="muted">Checking…</p>'
        : `<ul class="m-0 list-none p-0" aria-label="Prerequisites" data-doctor-checks>${checks
            .map((check) => {
              const [tone, label] = check.note
                ? ["warn", "Note"]
                : check.ok
                  ? ["ok", "OK"]
                  : ["err", "Missing"];
              return `<li class="flex flex-col gap-1 border-t border-border py-2 first:border-t-0" data-doctor-check="${esc(check.name)}"><span class="row"><span class="pill ${tone}">${label}</span><b>${esc(check.name)}</b><span class="muted min-w-0">${esc(check.detail)}</span></span>${!check.ok && check.fix ? `<span class="text-sm">${esc(check.fix)}</span>` : ""}</li>`;
            })
            .join("")}</ul>`;
  return `<section class="settings-section" data-settings-page="integrations">${heading}${body}</section>`;
}

export function createDoctorChecks() {
  let root: HTMLElement | undefined;
  let engine: string | null = null;
  let generation = 0;

  const load = async () => {
    const current = ++generation;
    const target = root!;
    renderMarkup(target, renderDoctorChecks(null));
    let html: string;
    try {
      const response = await fetch(new URL("/api/settings/doctor", engine!), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const result = (await response.json().catch(() => ({}))) as {
        checks?: DoctorCheck[];
        error?: string;
      };
      html = response.ok
        ? renderDoctorChecks(result.checks ?? [])
        : renderDoctorChecks(null, result.error ?? `Request failed (${response.status}).`);
    } catch (error) {
      html = renderDoctorChecks(null, error instanceof Error ? error.message : String(error));
    }
    if (current === generation && root === target) renderMarkup(target, html);
  };

  const click = (event: Event) => {
    if ((event.target as Element | null)?.closest("[data-doctor-refresh]")) void load();
  };

  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      if (engine) void load();
    },
  };
}
