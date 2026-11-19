import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type KeyName = "exeDev" | "tailscale";
const KEYS: [KeyName, string, string][] = [
  ["exeDev", "exe.dev API token", "Create VM uses it to make runner VMs on exe.dev."],
  [
    "tailscale",
    "Tailscale auth key",
    'Runner VMs join your tailnet with it. Make it reusable and pre-authorized, tagged <code>tag:paws-runner</code>. In the tailnet policy, add <code>"tagOwners": { "tag:paws-runner": ["autogroup:admin"] }</code> and <code>{ "action": "accept", "src": ["tag:paws-runner"], "dst": ["paws:8787,8788"] }</code>.',
  ],
];

export function createRunnerVmKeys() {
  let root: HTMLElement | undefined;
  let engine = "";
  let status: Record<KeyName, boolean> | null = null;
  let message = "";
  let failed = false;
  const paint = () => {
    const forms = KEYS.map(([key, label, help]) =>
      status
        ? `<form class="col" data-runner-vm-key="${key}"><div class="settings-field"><label for="runner-vm-${key}">${label}</label><input id="runner-vm-${key}" name="${key}" type="password" required autocomplete="off" spellcheck="false"></div><p class="sub" data-key-state>${status[key] ? "Set" : "Not set"}</p><p class="muted">${help}</p><div class="row"><button class="btn" type="submit">Save</button>${status[key] ? `<button class="btn" type="button" data-clear="${key}">Clear</button>` : ""}</div></form>`
        : "",
    ).join("");
    const note = message
      ? `<p class="settings-message${failed ? " err" : ""}" role="${failed ? "alert" : "status"}">${esc(message)}</p>`
      : "";
    if (root)
      renderMarkup(
        root,
        `<section class="settings-section"><div class="settings-label"><h2>Runner VM keys</h2></div><div class="col">${forms}${note}</div></section>`,
      );
  };
  const request = async (done: string, method = "GET", query = "", body?: unknown) => {
    try {
      const response = await fetch(new URL(`/api/settings/runner-vm-keys${query}`, engine), {
        method,
        cache: "no-store",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
      status = data;
      message = done;
      failed = false;
    } catch (error) {
      journalCaught(error, "runner-vm-keys.request", null);
      message = error instanceof Error ? error.message : "Try again.";
      failed = true;
    }
    paint();
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    const key = form.dataset.runnerVmKey;
    if (!key) return;
    event.preventDefault();
    void request("Saved.", "PUT", "", { [key]: form.querySelector("input")!.value });
  };
  const click = (event: Event) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>("[data-clear]")?.dataset.clear;
    if (key) void request("Cleared.", "DELETE", `?key=${key}`);
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if ((root === next && engine === nextEngine) || !nextEngine) return;
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("click", click);
      root = next;
      engine = nextEngine;
      status = null;
      message = "";
      root.addEventListener("submit", submit);
      root.addEventListener("click", click);
      void request("");
    },
  };
}
