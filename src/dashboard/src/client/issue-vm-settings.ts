import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { settingsAreEditable } from "./settings-pages";
import { renderMarkup } from "./theme";

type Limits = { perMember: number; workspaceMax: number; deleteAfterDays: number };
type Grant = { id: string; memberUserId: string; limit: number; endsAt: number };
type Member = {
  userId: string;
  name: string | null;
  role: string;
  inUse: { total: number };
  limit: number;
  grant: Grant | null;
};
type HostSize = {
  vmVcpus: number;
  vmMemoryGb: number;
  vmDiskGb: number;
  reserveVcpus: number;
  reserveMemoryGb: number;
  slotCap: number | null;
};
type Host = {
  runnerId: string;
  vmHost: boolean;
  settings: HostSize;
  slots: { slots: number; reason: string };
};
type Note = { text: string; failed: boolean };

const LIMITS: [keyof Limits, string, number, number][] = [
  ["perMember", "Issues per member at once", 0, 50],
  ["workspaceMax", "Workspace ceiling", 1, 500],
  ["deleteAfterDays", "Delete after days asleep", 1, 60],
];
const SIZE: [keyof HostSize, string, number, number][] = [
  ["vmVcpus", "vCPUs per VM", 1, 32],
  ["vmMemoryGb", "Memory per VM (GB)", 1, 128],
  ["vmDiskGb", "Disk per VM (GB)", 10, 500],
  ["reserveVcpus", "Host reserve vCPUs", 0, 64],
  ["reserveMemoryGb", "Host reserve memory (GB)", 0, 256],
  ["slotCap", "Slot cap", 1, 64],
];
const REASON: Record<string, string> = {
  cpu: "limited by vCPUs",
  memory: "limited by memory",
  disk: "limited by disk",
  cap: "limited by the slot cap",
  unknown: "the runner has not reported its CPUs and memory yet",
};
const DAY = 86_400_000;

async function request<T>(engine: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(new URL(path, engine), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(method === "GET"
        ? {}
        : { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch((error: unknown) => {
    journalCaught(error, "issue-vm-settings.request.json", null);
    return {};
  });
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
    );
  return data as T;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function field(id: string, name: string, label: string, value: string, min: number, max: number) {
  return `<div class="settings-field"><label for="${id}">${label}</label><input id="${id}" name="${name}" type="number" inputmode="numeric" min="${min}" max="${max}" value="${esc(value)}"><p class="sub">${min} to ${max}</p></div>`;
}

export function createIssueVmSettings() {
  let root: HTMLElement | undefined;
  let engine: string | null = null;
  let limits: Limits | null = null;
  let members: Member[] = [];
  let me: string | null = null;
  let runners: { id: string; name: string }[] = [];
  let hosts = new Map<string, Host>();
  let notes: Record<string, Note> = {};
  let busy = false;
  const admin = () => settingsAreEditable();
  const note = (key: string) => {
    const entry = notes[key];
    return entry
      ? `<p class="settings-message${entry.failed ? " err" : ""}" role="${entry.failed ? "alert" : "status"}" data-note="${key}">${esc(entry.text)}</p>`
      : "";
  };
  const section = (title: string, body: string) =>
    `<section class="settings-section"><div class="settings-label"><h2>${title}</h2></div><div class="col min-w-0">${body}</div></section>`;
  const off = () => (busy ? " disabled" : "");
  const limitsSection = () =>
    section(
      "Limits",
      `${
        limits
          ? `<form data-limits class="col" novalidate>${LIMITS.map(([key, label, min, max]) => field(`issue-vm-${key}`, key, label, String(limits![key]), min, max)).join("")}<div class="row"><button class="btn" type="submit"${off()}>Save limits</button></div></form>`
          : ""
      }${note("limits")}`,
    );
  const grantCell = (member: Member) =>
    member.grant
      ? `${member.grant.limit} until ${day(member.grant.endsAt)}${admin() ? ` <button class="btn secondary" type="button" data-revoke="${esc(member.grant.id)}"${off()}>Revoke</button>` : ""}`
      : "None";
  const grantsSection = () => {
    const shown = admin() ? members : members.filter((member) => member.userId === me);
    const rows = shown
      .map(
        (member) =>
          `<tr><td>${esc(member.name ?? member.userId)}</td><td>${member.inUse.total}</td><td>${member.limit}</td><td>${grantCell(member)}</td></tr>`,
      )
      .join("");
    const table = shown.length
      ? `<div class="min-w-0 overflow-x-auto [overflow-wrap:normal] [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap"><table aria-label="Issue VM limits per member"><thead><tr><th scope="col">Member</th><th scope="col">In use</th><th scope="col">Limit</th><th scope="col">Extra usage</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : "";
    const now = Date.now();
    const form =
      admin() && members.length
        ? `<form data-grant class="col" novalidate><div class="settings-field"><label for="issue-vm-grant-member">Member</label><select id="issue-vm-grant-member" name="memberUserId">${members.map((member) => `<option value="${esc(member.userId)}">${esc(member.name ?? member.userId)}</option>`).join("")}</select></div>${field("issue-vm-grant-limit", "limit", "Issues at once", "", 1, 50)}<div class="settings-field"><label for="issue-vm-grant-ends">Ends on</label><input id="issue-vm-grant-ends" name="endsAt" type="date" min="${day(now + DAY)}" max="${day(now + 89 * DAY)}"><p class="sub">At most 90 days ahead</p></div><div class="row"><button class="btn" type="submit"${off()}>Add grant</button></div></form>`
        : "";
    return section(
      "Extra usage",
      `<p class="sub">A grant replaces a member's limit until it ends.</p>${table}${form}${note("grants")}`,
    );
  };
  const hostForm = (host: Host) => {
    const name = runners.find((runner) => runner.id === host.runnerId)?.name ?? host.runnerId;
    const slots = `<p data-slots="${host.runnerId}"><strong>${host.slots.slots} slots</strong>, ${REASON[host.slots.reason] ?? host.slots.reason}</p>`;
    return `<form data-host="${host.runnerId}" class="col" novalidate><h3>${esc(name)}</h3>${slots}${SIZE.map(([key, label, min, max]) => field(`vm-host-${host.runnerId}-${key}`, key, label, host.settings[key] === null ? "" : String(host.settings[key]), min, max)).join("")}<div class="row"><button class="btn" type="submit"${off()}>Save VM size</button><button class="btn secondary" type="button" data-unhost="${host.runnerId}"${off()}>Stop hosting VMs</button></div></form>`;
  };
  const hostsSection = () => {
    const shown = [...hosts.values()].filter((host) => host.vmHost);
    const others = runners.filter((runner) => hosts.get(runner.id)?.vmHost === false);
    const add = others.length
      ? `<form data-add-host class="row"><label class="sr-only" for="vm-host-add">Runner</label><select id="vm-host-add" name="runnerId">${others.map((runner) => `<option value="${runner.id}">${esc(runner.name)}</option>`).join("")}</select><button class="btn secondary" type="submit"${off()}>Host microVMs</button></form>`
      : "";
    return section(
      "VM hosts",
      `<p class="sub">Each VM host runs issue VMs of one size. Leave the slot cap blank for no cap.</p>${shown.length ? shown.map(hostForm).join("") : '<p class="sub">No runner hosts microVMs yet.</p>'}${add}${note("hosts")}`,
    );
  };
  const paint = () => {
    if (!root) return;
    renderMarkup(
      root,
      admin()
        ? `${limitsSection()}${grantsSection()}${hostsSection()}`
        : `${grantsSection()}${note("member")}`,
    );
  };
  const attempt = async <T>(key: string, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      journalCaught(error, `issue-vm-settings.${key}`, null);
      notes[key] = { text: error instanceof Error ? error.message : "Try again.", failed: true };
      return null;
    }
  };
  const fetchMembers = async () => {
    members = (await request<{ members: Member[] }>(engine!, "/api/settings/issue-vm/members"))
      .members;
  };
  const loadMembers = () => attempt("grants", fetchMembers);
  const refreshMembers = async (done: string) => {
    try {
      await fetchMembers();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Try again.";
      throw new Error(`${done} The member list could not be reloaded: ${reason}`, {
        cause: error,
      });
    }
  };
  const loadHosts = async () => {
    const listed = await attempt("hosts", () =>
      request<{ runners: { id: string; name: string }[] }>(engine!, "/api/runners"),
    );
    runners = listed?.runners ?? [];
    const views = await Promise.all(
      runners.map((runner) =>
        attempt("hosts", () => request<Host>(engine!, `/api/runners/${runner.id}/vm-host`)),
      ),
    );
    hosts = new Map(views.flatMap((host) => (host ? [[host.runnerId, host]] : [])));
  };
  const load = async () => {
    if (!engine) return;
    if (admin()) {
      await Promise.all([
        attempt("limits", () => request<Limits>(engine!, "/api/settings/issue-vm")).then((next) => {
          if (next) limits = next;
        }),
        loadMembers(),
        loadHosts(),
      ]);
    } else {
      const session = await attempt("member", () =>
        request<{ userId: string }>(engine!, "/api/auth/session"),
      );
      me = session?.userId ?? null;
      const listed = await attempt("member", () =>
        request<{ members: Member[] }>(engine!, "/api/settings/issue-vm/members"),
      );
      if (listed) members = listed.members;
    }
    paint();
  };
  const run = async (key: string, done: string, work: () => Promise<unknown>) => {
    busy = true;
    delete notes[key];
    paint();
    if ((await attempt(key, work)) !== null) notes[key] = { text: done, failed: false };
    busy = false;
    paint();
  };
  const numbers = (form: HTMLFormElement) =>
    Object.fromEntries(
      [...form.querySelectorAll<HTMLInputElement>("input")].map((input) => [
        input.name,
        input.value.trim() === "" ? null : Number(input.value),
      ]),
    );
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    if (!engine || busy) return;
    event.preventDefault();
    if (form.matches("[data-limits]"))
      void run("limits", "Limits saved.", async () => {
        limits = await request<Limits>(engine!, "/api/settings/issue-vm", "PUT", numbers(form));
        await refreshMembers("Limits saved.");
      });
    else if (form.matches("[data-grant]")) {
      const member = form.querySelector<HTMLSelectElement>("select")!.value;
      const limit = form.querySelector<HTMLInputElement>("[name=limit]")!.value;
      const ends = form.querySelector<HTMLInputElement>("[name=endsAt]")!.value;
      void run("grants", "Grant added.", async () => {
        await request(engine!, "/api/settings/issue-vm/grants", "POST", {
          memberUserId: member,
          limit: limit.trim() === "" ? null : Number(limit),
          endsAt: ends === "" ? null : `${ends}T23:59:59Z`,
        });
        await refreshMembers("Grant added.");
      });
    } else if (form.matches("[data-host]")) {
      const id = form.dataset.host!;
      void run("hosts", "VM size saved.", async () => {
        const body = numbers(form);
        if (body.slotCap === null) delete body.slotCap;
        hosts.set(id, await request<Host>(engine!, `/api/runners/${id}/vm-host`, "PUT", body));
      });
    } else if (form.matches("[data-add-host]")) {
      const id = form.querySelector<HTMLSelectElement>("select")!.value;
      void run("hosts", "Runner now hosts microVMs.", async () => {
        hosts.set(id, await request<Host>(engine!, `/api/runners/${id}/vm-host`, "PUT", {}));
      });
    }
  };
  const click = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-revoke],[data-unhost]",
    );
    if (!button || !engine || busy) return;
    const revoke = button.dataset.revoke;
    const unhost = button.dataset.unhost;
    if (revoke)
      void run("grants", "Grant revoked.", async () => {
        await request(engine!, `/api/settings/issue-vm/grants/${revoke}`, "DELETE");
        await refreshMembers("Grant revoked.");
      });
    else if (unhost)
      void run("hosts", "Runner no longer hosts microVMs.", async () => {
        hosts.set(unhost, await request<Host>(engine!, `/api/runners/${unhost}/vm-host`, "DELETE"));
      });
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("click", click);
      root = next;
      engine = nextEngine;
      limits = null;
      members = [];
      hosts = new Map();
      notes = {};
      root.addEventListener("submit", submit);
      root.addEventListener("click", click);
      paint();
      void load();
    },
  };
}
