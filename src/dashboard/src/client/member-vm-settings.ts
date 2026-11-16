import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import type { MemberVmSize } from "./runners";
import { renderMarkup } from "./theme";

const PATH = "/api/settings/member-vm";
const FIELDS = [
  ["cpu", "CPUs"],
  ["memoryGb", "Memory (GB)"],
  ["diskGb", "Disk (GB)"],
  ["image", "Image"],
  ["pool", "Default pool"],
] as const;
const NUMBERS = new Set<string>(["cpu", "memoryGb", "diskGb"]);

async function memberVmRequest(engine: string, body?: Record<string, string | number>) {
  const response = await fetch(new URL(PATH, engine), {
    method: body ? "PUT" : "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body
        ? { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch((error: unknown) => {
    journalCaught(error, "member-vm-settings.memberVmRequest.json", null);
    return {};
  });
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
    );
  return data as MemberVmSize;
}

export function createMemberVmSettings() {
  let root: HTMLElement | undefined;
  let engine: string | null = null;
  let size: MemberVmSize | null = null;
  let draft: Record<string, string> = {};
  let busy = false;
  let message = "";
  let failed = false;
  const paint = () => {
    const fields = FIELDS.map(
      ([key, label]) =>
        `<div class="settings-field"><label for="vm-size-${key}">${label}</label><input id="vm-size-${key}" name="${key}" value="${esc(draft[key] ?? "")}" placeholder="exe.dev default"${busy ? " disabled" : ""}></div>`,
    ).join("");
    const note = message
      ? `<p class="settings-message${failed ? " err" : ""}" role="${failed ? "alert" : "status"}">${esc(message)}</p>`
      : "";
    if (!root) return;
    renderMarkup(
      root,
      `<section class="settings-section"><div class="settings-label"><h2>Member VM size</h2></div><div class="col"><p class="sub">Applies to VMs created with Create VM on the Runners page. Leave a field blank to use exe.dev's default. Existing VMs keep their size.</p>${size ? `<form data-vm-size class="col"><div class="col">${fields}</div><div class="row"><button class="btn" type="submit"${busy ? " disabled" : ""}>Save VM size</button></div></form>` : ""}${note}</div></section>`,
    );
  };
  const fill = (next: MemberVmSize) => {
    size = next;
    draft = Object.fromEntries(
      FIELDS.map(([key]) => [key, next[key] === undefined ? "" : String(next[key])]),
    );
  };
  const load = async () => {
    if (!engine) return;
    try {
      fill(await memberVmRequest(engine));
    } catch (error) {
      journalCaught(error, "member-vm-settings.load", null);
      message = error instanceof Error ? error.message : "Member VM size is unavailable.";
      failed = true;
    }
    paint();
  };
  const save = async (form: HTMLFormElement) => {
    for (const input of form.querySelectorAll<HTMLInputElement>("input"))
      draft[input.name] = input.value;
    const body: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(draft)) {
      const trimmed = value.trim();
      if (trimmed) body[key] = NUMBERS.has(key) ? Number(trimmed) : trimmed;
    }
    busy = true;
    message = "";
    paint();
    try {
      fill(await memberVmRequest(engine!, body));
      message = "Member VM size saved.";
      failed = false;
    } catch (error) {
      journalCaught(error, "member-vm-settings.save", null);
      message = error instanceof Error ? error.message : "Try again.";
      failed = true;
    }
    busy = false;
    paint();
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches("[data-vm-size]")) return;
    event.preventDefault();
    void save(form);
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("submit", submit);
      root = next;
      engine = nextEngine;
      size = null;
      message = "";
      root.addEventListener("submit", submit);
      paint();
      void load();
    },
  };
}
