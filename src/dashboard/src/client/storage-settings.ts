import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type Storage = {
  kind: "local" | "s3";
  source: string;
  bucket: string | null;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  hasSecretAccessKey: boolean;
  hasSessionToken: boolean;
  closeoutLogRetentionDays?: number;
  restartRequired?: boolean;
};

const fields = [
  ["bucket", "Bucket"],
  ["endpoint", "Endpoint"],
  ["region", "Region"],
  ["accessKeyId", "Access key ID"],
  ["secretAccessKey", "Secret access key"],
  ["sessionToken", "Session token (optional)"],
] as const;

export function createStorageSettings() {
  let root: HTMLElement;
  let engine: string | null;
  let data: Storage | null = null;
  let draft: Record<string, string> = {};
  let busy = false;
  let message = "";
  let error = false;
  let generation = 0;
  let restart = false;
  const paint = () => {
    const locked = data?.source === "environment";
    const field = (key: string, label: string, secret = false) => {
      const saved = key === "secretAccessKey" ? data?.hasSecretAccessKey : data?.hasSessionToken;
      return `<div class="settings-field"><label for="storage-${key}">${label}</label><input id="storage-${key}" name="${key}" type="${secret ? "password" : "text"}" value="${esc(draft[key] ?? "")}" autocomplete="${secret ? "new-password" : "off"}"${secret && saved ? ' placeholder="Saved, enter a new one to replace it"' : ""}${!secret && key !== "sessionToken" ? " required" : ""}></div>`;
    };
    renderMarkup(
      root,
      `<section class="settings-section"><div class="settings-label"><h2>Storage</h2></div><div class="col">
      ${locked ? '<p class="sub">Set by PAWS_S3_* on this host</p>' : ""}
      ${
        data
          ? `<form id="storage-form" class="col"><fieldset class="col" ${locked || busy ? "disabled" : ""}>
        <div class="settings-field"><label for="storage-kind">Storage kind</label><select id="storage-kind" name="kind"><option value="local"${draft.kind === "local" ? " selected" : ""}>Local</option><option value="s3"${draft.kind === "s3" ? " selected" : ""}>S3</option></select></div>
        ${draft.kind === "s3" ? fields.map(([key, label]) => field(key, label, key === "secretAccessKey" || key === "sessionToken")).join("") : ""}
        ${data.closeoutLogRetentionDays !== undefined ? `<div class="settings-field"><label for="storage-days">Delete Closeout logs of finished issues after N days</label><input id="storage-days" name="days" type="number" min="0" max="3650" step="1" required value="${esc(draft.days ?? "0")}"><small class="sub">0 = keep forever</small></div>` : ""}
        <div class="row"><button class="btn" type="submit">Save storage settings</button><button class="btn" type="button" data-storage="check">Check connection</button></div>
      </fieldset></form>`
          : ""
      }
      ${message ? `<p class="settings-message${error ? " err" : ""}" role="${error ? "alert" : "status"}">${esc(message)}</p>` : ""}
      ${restart ? '<p role="status">Restart Paws to apply the storage settings.</p>' : ""}
      <div class="row"><button class="btn" type="button" data-storage="reload" ${busy ? "disabled" : ""}>Reload</button></div>
    </div></section>`,
    );
  };
  const read = () => {
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input, select",
    ))
      draft[input.name] = input.value;
  };
  const body = (retention: boolean) => ({
    kind: draft.kind,
    ...(draft.kind === "s3"
      ? Object.fromEntries(
          fields.flatMap(([key]) =>
            (key === "secretAccessKey" || key === "sessionToken") && !draft[key]
              ? []
              : [[key, draft[key] ?? ""]],
          ),
        )
      : {}),
    ...(retention && data?.closeoutLogRetentionDays !== undefined
      ? { closeoutLogRetentionDays: Number(draft.days) }
      : {}),
  });
  const run = async (action: "reload" | "save" | "check") => {
    if (!engine || busy) return;
    const started = generation;
    const payload = action === "reload" ? undefined : body(action === "save");
    busy = true;
    error = false;
    message =
      action === "check"
        ? "Checking connection…"
        : action === "save"
          ? "Saving…"
          : "Loading storage…";
    paint();
    try {
      const response = await fetch(
        new URL(`/api/settings/storage${action === "check" ? "/check" : ""}`, engine),
        {
          method: action === "reload" ? "GET" : action === "save" ? "PUT" : "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }
              : {}),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        },
      );
      const result = await response.json();
      if (started !== generation) return;
      if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
      if (action !== "check") {
        data = result as Storage;
        restart ||= !!data.restartRequired;
        draft = { kind: data.kind, days: String(data.closeoutLogRetentionDays ?? 0) };
        for (const [key] of fields)
          draft[key] = key === "secretAccessKey" || key === "sessionToken" ? "" : (data[key] ?? "");
      }
      message =
        action === "check" ? "Connection OK." : action === "save" ? "Storage settings saved." : "";
    } catch (cause) {
      if (started !== generation) return;
      error = true;
      message = cause instanceof Error ? cause.message : "Could not load storage settings.";
    }
    busy = false;
    paint();
  };
  const change = (event: Event) => {
    read();
    if ((event.target as HTMLElement).tagName === "SELECT") paint();
  };
  const click = (event: Event) => {
    const action = (event.target as Element).closest<HTMLElement>("[data-storage]")?.dataset
      .storage;
    if (action === "reload") void run("reload");
    if (action === "check" && data?.source !== "environment") {
      read();
      if (root.querySelector<HTMLFormElement>("form")?.reportValidity()) void run("check");
    }
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (data?.source === "environment") return;
    read();
    void run("save");
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("change", change);
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      generation++;
      busy = false;
      data = null;
      draft = {};
      root = next;
      engine = nextEngine;
      root.addEventListener("change", change);
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      if (engine) void run("reload");
      else {
        message = "Connect to your Paws dashboard to manage storage.";
        paint();
      }
    },
  };
}
