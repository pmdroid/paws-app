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
type HostSize = Record<string, number | null>;
type Host = {
  runnerId: string;
  vmHost: boolean;
  settings: HostSize;
  slots: { slots: number; reason: string };
};
type Note = { text: string; failed: boolean };
type Provider = "boat" | "instabox";
type Spend = {
  month: string;
  spentUsd: number;
  monthlyLimitUsd: number;
  prices: Record<Provider, number | null>;
};

const LIMITS: [keyof Limits, string, number, number][] = [
  ["perMember", "Issues per member at once", 0, 50],
  ["workspaceMax", "Workspace ceiling", 1, 500],
  ["deleteAfterDays", "Delete after days asleep", 1, 60],
];
const SIZE: [string, string, number, number][] = [
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
const PROVIDERS: [Provider, string][] = [
  ["boat", "boat"],
  ["instabox", "InstaBox"],
];
const NO_PRICE = "No cloud issue VMs until a price is set";
const usd = (value: number) => `$${value.toFixed(2)}`;

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
  let spend: Spend | null = null;
  let members: Member[] = [];
  let runners: { id: string; name: string }[] = [];
  let hosts = new Map<string, Host>();
  let notes: Record<string, Note> = {};
  let busy = false;
  let recipient = "";
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
  const money = (id: string, name: string, label: string, value: number | null, hint: string) =>
    `<div class="settings-field"><label for="${id}">${label}</label><input id="${id}" name="${name}" type="number" inputmode="decimal" min="0" max="1000000" step="0.01" value="${value === null ? "" : String(value)}"><p class="sub">${hint}</p></div>`;
  const spendSection = () => {
    if (!spend) return admin() ? section("Spend", note("spend")) : "";
    const { spentUsd, monthlyLimitUsd: limit, prices } = spend;
    const share = limit > 0 ? spentUsd / limit : 1;
    const text = `${usd(spentUsd)} of ${usd(limit)} spent in ${spend.month}`;
    const bar = `<div class="col"><div class="between"><span>This month</span><span class="mono">${text}</span></div><progress class="${share >= 1 ? "full" : share >= 0.8 ? "high" : ""}" max="${limit > 0 ? limit : 1}" value="${limit > 0 ? Math.min(spentUsd, limit) : 1}" aria-label="${text}"></progress></div>`;
    const price = (value: number | null) => (value === null ? NO_PRICE : `${usd(value)} an hour`);
    const body = admin()
      ? `<form data-spend class="col" novalidate>${money("issue-vm-spend-limit", "monthlyLimitUsd", "Monthly limit (US dollars)", limit, "Cloud issue VMs stop starting once this month's spend reaches it.")}${PROVIDERS.map(([key, label]) => money(`issue-vm-price-${key}`, key, `${label} price per VM hour (US dollars)`, prices[key], prices[key] === null ? NO_PRICE : "0 to 1000000")).join("")}<div class="row"><button class="btn" type="submit"${off()}>Save spend</button></div></form>`
      : `<ul class="col" aria-label="Hourly prices">${PROVIDERS.map(([key, label]) => `<li data-price="${key}">${label}: ${price(prices[key])}</li>`).join("")}</ul>`;
    return section("Spend", `${bar}${body}${note("spend")}`);
  };
  const grantCell = (member: Member) =>
    member.grant
      ? `${member.grant.limit} until ${day(member.grant.endsAt)}${admin() ? ` <button class="btn secondary" type="button" data-revoke="${esc(member.grant.id)}"${off()}>Revoke</button>` : ""}`
      : "None";
  const grantsSection = () => {
    const rows = members
      .map(
        (member) =>
          `<tr><td>${esc(member.name ?? member.userId)}</td><td>${member.inUse.total}</td><td>${member.limit}</td><td>${grantCell(member)}</td></tr>`,
      )
      .join("");
    const table = members.length
      ? `<div class="min-w-0 overflow-x-auto [overflow-wrap:normal] [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap"><table aria-label="Issue VM limits per member"><thead><tr><th scope="col">Member</th><th scope="col">In use</th><th scope="col">Limit</th><th scope="col">Extra usage</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : "";
    const now = Date.now();
    const open = members.filter((member) => member.grant === null);
    const option = (member: Member) =>
      `<option value="${esc(member.userId)}"${member.userId === recipient ? " selected" : ""}>${esc(member.name ?? member.userId)}</option>`;
    const form =
      admin() && open.length
        ? `<form data-grant class="col" novalidate><div class="settings-field"><label for="issue-vm-grant-member">Member</label><select id="issue-vm-grant-member" name="memberUserId">${open.map(option).join("")}</select><p class="sub">Revoke a member's grant before giving them a new one.</p></div>${field("issue-vm-grant-limit", "limit", "Issues at once", "", 1, 50)}<div class="settings-field"><label for="issue-vm-grant-ends">Ends on</label><input id="issue-vm-grant-ends" name="endsAt" type="date" min="${day(now + DAY)}" max="${day(now + 89 * DAY)}"><p class="sub">At most 90 days ahead</p></div><div class="row"><button class="btn" type="submit"${off()}>Add grant</button></div></form>`
        : "";
    return section(
      "Extra usage",
      `<p class="sub">A grant replaces a member's limit until it ends.</p>${table}${form}${note("grants")}`,
    );
  };
  const hostForm = (host: Host) => {
    const name = runners.find((runner) => runner.id === host.runnerId)?.name ?? host.runnerId;
    const slots = `<p data-slots="${host.runnerId}"><strong>${host.slots.slots} slots</strong>, ${REASON[host.slots.reason] ?? host.slots.reason}</p>`;
    return `<form data-host="${host.runnerId}" class="col" novalidate><h3>${esc(name)}</h3>${slots}${SIZE.map(([key, label, min, max]) => field(`vm-host-${host.runnerId}-${key}`, key, label, host.settings[key] === null ? "" : String(host.settings[key]), min, max)).join("")}<div class="row"><button class="btn" type="submit"${off()}>Save VM size</button></div></form>`;
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
        ? `${limitsSection()}${spendSection()}${grantsSection()}${hostsSection()}`
        : `${spendSection()}${grantsSection()}`,
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
    const limitsLoad = () =>
      attempt("limits", () => request<Limits>(engine!, "/api/settings/issue-vm"));
    const spendLoad = async () => {
      try {
        spend = await request<Spend>(engine!, "/api/settings/issue-vm/spend");
      } catch (error) {
        journalCaught(error, "issue-vm-settings.spend", null);
        if (admin())
          notes.spend = {
            text: error instanceof Error ? error.message : "Try again.",
            failed: true,
          };
      }
    };
    await Promise.all(
      admin()
        ? [
            limitsLoad().then((next) => (limits = next ?? limits)),
            spendLoad(),
            loadMembers(),
            loadHosts(),
          ]
        : [spendLoad(), loadMembers()],
    );
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
        const body = numbers(form);
        if (Object.values(body).some((value) => value === null || Number.isNaN(value)))
          throw new Error("Enter a whole number for each limit.");
        limits = await request<Limits>(engine!, "/api/settings/issue-vm", "PUT", body);
        await refreshMembers("Limits saved.");
      });
    else if (form.matches("[data-spend]"))
      void run("spend", "Spend settings saved.", async () => {
        const { monthlyLimitUsd, ...entered } = numbers(form);
        const prices = Object.fromEntries(
          Object.entries(entered).filter(([, value]) => value !== null),
        );
        if (
          monthlyLimitUsd === null ||
          [monthlyLimitUsd, ...Object.values(prices)].some((value) => Number.isNaN(value))
        )
          throw new Error("Enter the monthly limit and each price in US dollars.");
        spend = await request<Spend>(engine!, "/api/settings/issue-vm/spend", "PUT", {
          monthlyLimitUsd,
          prices,
        });
      });
    else if (form.matches("[data-grant]")) {
      const member = form.querySelector<HTMLSelectElement>("select")!.value;
      const limit = form.querySelector<HTMLInputElement>("[name=limit]")!.value;
      const ends = form.querySelector<HTMLInputElement>("[name=endsAt]")!.value;
      recipient = member;
      void run("grants", "Grant added.", async () => {
        await request(engine!, "/api/settings/issue-vm/grants", "POST", {
          memberUserId: member,
          limit: limit.trim() === "" ? null : Number(limit),
          endsAt: ends === "" ? null : `${ends}T23:59:59Z`,
        });
        recipient = "";
        for (const input of root!.querySelectorAll<HTMLInputElement>("[data-grant] input"))
          input.value = "";
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
  const change = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    if (target.id === "issue-vm-grant-member") recipient = target.value;
  };
  const click = (event: Event) => {
    const revoke = (event.target as HTMLElement).closest<HTMLElement>("[data-revoke]")?.dataset
      .revoke;
    if (!revoke || !engine || busy) return;
    void run("grants", "Grant revoked.", async () => {
      await request(engine!, `/api/settings/issue-vm/grants/${revoke}`, "DELETE");
      await refreshMembers("Grant revoked.");
    });
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      root = next;
      engine = nextEngine;
      limits = null;
      spend = null;
      members = [];
      hosts = new Map();
      notes = {};
      root.addEventListener("submit", submit);
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      paint();
      void load();
    },
  };
}
