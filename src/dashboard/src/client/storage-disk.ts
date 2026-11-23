import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type Fs = { mount: string; type: string; totalBytes: number; freeBytes: number; memory?: true };
type Filesystems = { home: Fs | null; tmp: Fs | null };
type Snapshot = {
  machine: string;
  takenAt: number;
  partial: boolean;
  filesystems: Filesystems;
  categories: Record<string, { bytes: number; files: number } | undefined>;
};
type RunnerView = {
  machine: string;
  name: string;
  state: "fresh" | "stale" | "missing" | "unsupported";
  online: boolean;
  reporting: boolean;
  snapshot: Snapshot | null;
};
type Usage = {
  scanning: boolean;
  live: Filesystems & { checkedAt: number };
  snapshots: Snapshot[];
  runners: RunnerView[];
};
type Rules = {
  schedule: { enabled: boolean; timeUtc: string; machines: string[] };
  categories: {
    temporary: { enabled: boolean; olderThanHours: number };
    closeout_logs: { enabled: boolean };
  };
};
type Item = { category: string; ref: string; bytes: number };
type Preview = {
  id: string;
  expiresAt: number;
  items: Item[];
  kept: { category: string; reason: string; count: number }[];
};
type Cleanup = {
  id: string;
  machine: string;
  actor: string;
  startedAt: number;
  finishedAt: number | null;
  deleted: Item[];
  skipped: { category: string; ref: string; reason: string }[];
  freedBytes: number;
  error: string | null;
};

const SERVER = "server";
const LABELS: Record<string, string> = {
  transcripts: "Agent transcripts",
  run_files: "Run files",
  closeout: "Closeout logs",
  closeout_logs: "Closeout logs",
  evidence: "Evidence",
  tasks: "Task folders",
  repositories: "Repository mirrors",
  worktrees: "Worktrees",
  secrets: "Secrets",
  temporary: "Temporary files",
  deploy_dumps: "Pre-deploy database dumps",
  old_backups: "Old database backups",
  worker_logs: "Worker logs",
  executions: "Executions",
  health: "Health checks",
  tool_caches: "Tool caches",
  other: "Other",
};
const SERVER_ORDER = Object.keys(LABELS).filter(
  (key) => !["closeout_logs", "worker_logs", "executions", "health", "tool_caches"].includes(key),
);
const RUNNER_ORDER = [
  "repositories",
  "worker_logs",
  "executions",
  "health",
  "tool_caches",
  "other",
];
const NEVER = new Set(["repositories", "worktrees", "secrets"]);
const NEVER_DELETED = [
  "Secrets and credentials",
  "The database and its current backups",
  "Repository mirrors and worktrees",
  "Files of items that are running, queued, paused, recovering or verifying",
  "Evidence and agent transcripts",
];

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

const label = (category: string) => LABELS[category] ?? category;
const percent = (fs: Fs) =>
  fs.totalBytes > 0 ? Math.round(((fs.totalBytes - fs.freeBytes) / fs.totalBytes) * 100) : 0;
const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const count = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;
const sum = (items: Item[]) => items.reduce((total, item) => total + item.bytes, 0);

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

function bar(name: string, fs: Fs | null): string {
  if (!fs) return `<p class="sub">${esc(name)}: not measured</p>`;
  const used = fs.totalBytes - fs.freeBytes;
  const share = percent(fs);
  return `<div class="col"><div class="between"><span>${esc(name)}</span><span class="mono">${share}% used</span></div><progress class="${share >= 95 ? "full" : share >= 80 ? "high" : ""}" max="${fs.totalBytes}" value="${used}" aria-label="${esc(name)}: ${share}% used"></progress><small class="sub">${bytes(used)} used, ${bytes(fs.freeBytes)} free of ${bytes(fs.totalBytes)}</small></div>`;
}

function preCategory(items: { ref: string; bytes?: number; reason?: string }[]): string {
  const shown = items.slice(0, 100).map((item) => {
    const detail = item.reason ?? (item.bytes === undefined ? "" : bytes(item.bytes));
    return `${item.ref}  ${detail}`;
  });
  if (items.length > shown.length) shown.push(`and ${items.length - shown.length} more`);
  return `<pre>${esc(shown.join("\n"))}</pre>`;
}

export function createStorageDisk() {
  let root: HTMLElement;
  let engine: string | null = null;
  let usage: Usage | null = null;
  let rules: Rules | null = null;
  let draft: Rules | null = null;
  let history: Cleanup[] = [];
  let background: Preview | null = null;
  let preview: Preview | null = null;
  let previewCategories: string[] | undefined;
  let expired = false;
  let opened = new Set<string>();
  let busy = false;
  let message = "";
  let failed = false;
  let generation = 0;
  let polls = 0;

  const call = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, engine!), {
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
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error(result.error ?? `Request failed (${response.status}).`), {
        status: response.status,
      });
    return result as T;
  };

  const canFree = (category: string): string => {
    if (!background) return "—";
    const cleanup =
      category === "temporary" ? "temporary" : category === "closeout" ? "closeout_logs" : null;
    return cleanup === null
      ? "—"
      : bytes(sum(background.items.filter((item) => item.category === cleanup)));
  };

  const rule = (category: string, runner: boolean): string => {
    if (NEVER.has(category)) return "Never deleted here";
    if (runner || !rules) return "Measured only";
    if (category === "temporary")
      return rules.categories.temporary.enabled
        ? `Delete after ${rules.categories.temporary.olderThanHours} hours`
        : "Off";
    if (category === "closeout")
      return rules.categories.closeout_logs.enabled ? "Delete after Closeout log retention" : "Off";
    return "Measured only";
  };

  const table = (snapshot: Snapshot, runner: boolean) => {
    const rows = (runner ? RUNNER_ORDER : SERVER_ORDER)
      .filter((category) => snapshot.categories[category])
      .map(
        (category) =>
          `<tr><td>${esc(label(category))}</td><td class="mono">${bytes(snapshot.categories[category]!.bytes)}</td><td class="mono">${runner ? "—" : canFree(category)}</td><td>${rule(category, runner)}</td></tr>`,
      )
      .join("");
    return `<div class="overflow-x-auto [&_td]:[overflow-wrap:normal] [&_th]:whitespace-nowrap"><table class="run-table"><thead><tr><th>What it is</th><th>Used</th><th>Can free</th><th>Cleanup rule</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  const card = (
    machine: string,
    name: string,
    role: string,
    status: string,
    body: string,
    disabled: boolean,
  ) =>
    `<section class="overview-section" aria-labelledby="disk-${esc(machine)}"><div class="between"><div class="col"><h3 id="disk-${esc(machine)}">${esc(name)}</h3><span class="sub">${role} · ${status}</span></div><button class="btn" type="button" data-disk="refresh" data-machine="${esc(machine)}" aria-label="Refresh ${esc(name)}"${disabled || busy ? " disabled" : ""}>Refresh</button></div>${body}</section>`;

  const machineCards = (now: number) => {
    if (!usage) return "";
    const server = usage.snapshots.find((entry) => entry.machine === SERVER) ?? null;
    const serverCard = card(
      SERVER,
      "Paws server",
      "Server",
      usage.scanning
        ? "Scanning now"
        : server
          ? `Scanned ${ago(server.takenAt, now)}`
          : "Not scanned yet",
      `${bar(`Main disk (${usage.live.home?.mount ?? "home"})`, usage.live.home)}${bar(`/tmp${usage.live.tmp?.memory ? " (memory)" : ""}`, usage.live.tmp)}${server?.partial ? '<p class="sub">The scan stopped early, so these numbers are partial.</p>' : ""}${server ? table(server, false) : ""}`,
      false,
    );
    const runners = usage.runners.map((runner) => {
      const snapshot = runner.snapshot;
      const status = runner.reporting
        ? "Scanning now"
        : snapshot
          ? `Scanned ${ago(snapshot.takenAt, now)}${runner.state === "stale" ? ", may be out of date" : ""}`
          : "Not scanned yet";
      const body =
        runner.state === "unsupported"
          ? "<p>Update the runner to see disk use</p>"
          : snapshot
            ? `${bar(`Main disk (${snapshot.filesystems.home?.mount ?? "home"})`, snapshot.filesystems.home)}${bar(`/tmp${snapshot.filesystems.tmp?.memory ? " (memory)" : ""}`, snapshot.filesystems.tmp)}${table(snapshot, true)}`
            : "";
      return card(
        runner.machine,
        runner.name,
        "Runner",
        `${runner.online ? "" : "Offline, "}${status}`,
        body,
        runner.state === "unsupported" || !runner.online,
      );
    });
    return [serverCard, ...runners].join("");
  };

  const warning = () => {
    if (!usage) return "";
    const full = [
      { name: "the server", fs: usage.live.tmp },
      ...usage.runners.map((runner) => ({
        name: runner.name,
        fs: runner.snapshot?.filesystems.tmp ?? null,
      })),
    ].filter((entry) => entry.fs && percent(entry.fs) > 80);
    if (full.length === 0) return "";
    const temporary = background
      ? ` Cleaning up temporary files could free ${canFree("temporary")} on the server.`
      : "";
    return `<p class="checkout-note warn" role="status">/tmp is more than 80% full on ${full.map((entry) => `${esc(entry.name)} (${percent(entry.fs!)}%)`).join(", ")}.${temporary}</p>`;
  };

  const rulesForm = () => {
    if (!draft) return "";
    const machines = [
      { id: SERVER, name: "Paws server" },
      ...(usage?.runners ?? []).map((runner) => ({ id: runner.machine, name: runner.name })),
    ];
    const off = busy ? " disabled" : "";
    return `<form id="cleanup-form" class="col"><label class="settings-inherit"><input type="checkbox" id="cleanup-enabled" name="cleanup-enabled"${draft.schedule.enabled ? " checked" : ""}${off}> Clean up every day</label>
      <div class="settings-field"><label for="cleanup-time">Time (UTC)</label><input id="cleanup-time" name="cleanup-time" type="time" required value="${esc(draft.schedule.timeUtc)}"${off}></div>
      <fieldset class="col"><legend>Machines</legend>${machines.map((machine, index) => `<label class="settings-inherit"><input type="checkbox" id="cleanup-machine-${index}" name="cleanup-machine" value="${esc(machine.id)}"${draft!.schedule.machines.includes(machine.id) ? " checked" : ""}${off}> ${esc(machine.name)}</label>`).join("")}</fieldset>
      <div class="overflow-x-auto [&_td]:[overflow-wrap:normal]"><table class="run-table"><thead><tr><th>Delete</th><th>Age</th></tr></thead><tbody>
      <tr><td><label class="settings-inherit"><input type="checkbox" id="cleanup-temporary" name="cleanup-temporary"${draft.categories.temporary.enabled ? " checked" : ""}${off}> Temporary files</label></td><td><label class="sr-only" for="cleanup-hours">Temporary files older than hours</label><input id="cleanup-hours" name="cleanup-hours" type="number" min="1" max="8760" step="1" required value="${draft.categories.temporary.olderThanHours}"${off}> hours</td></tr>
      <tr><td><label class="settings-inherit"><input type="checkbox" id="cleanup-closeout" name="cleanup-closeout"${draft.categories.closeout_logs.enabled ? " checked" : ""}${off}> Closeout logs</label></td><td>After the Closeout log retention above</td></tr>
      </tbody></table></div>
      <h3>Never deleted</h3><ul>${NEVER_DELETED.map((entry) => `<li>${entry}</li>`).join("")}</ul>
      <div class="settings-actions"><button class="btn primary" type="submit"${off}>Save rules</button><button class="btn" type="button" data-disk="preview-rules"${off}>Preview with these rules</button></div></form>`;
  };

  const historyTable = () => {
    if (history.length === 0) return '<p class="sub">No cleanups yet.</p>';
    const rows = history.slice(0, 20).map((run) => {
      const open = opened.has(run.id);
      const summary = `<tr><td class="mono">${when(run.startedAt)}</td><td>${esc(run.actor)}</td><td class="mono">${bytes(run.freedBytes)}</td><td>${run.deleted.length} deleted, ${run.skipped.length} skipped${run.error ? `, failed: ${esc(run.error)}` : run.finishedAt === null ? ", running" : ""}</td><td><button class="btn sm" type="button" data-disk="toggle" data-run="${esc(run.id)}" aria-expanded="${open}">${open ? "Hide" : "Show"} items</button></td></tr>`;
      if (!open) return summary;
      return `${summary}<tr><td colspan="5"><div class="col"><h4>Deleted</h4>${run.deleted.length ? preCategory(run.deleted) : '<p class="sub">None</p>'}<h4>Skipped</h4>${run.skipped.length ? preCategory(run.skipped) : '<p class="sub">None</p>'}</div></td></tr>`;
    });
    return `<div class="overflow-x-auto [&_td]:[overflow-wrap:normal] [&_th]:whitespace-nowrap"><table class="run-table"><thead><tr><th>Started</th><th>By</th><th>Freed</th><th>Result</th><th><span class="sr-only">Items</span></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  };

  const dialog = () => {
    if (!preview) return "";
    const actions = (confirm: string) =>
      `<div class="settings-actions"><button class="btn" type="button" data-disk="cancel">Cancel</button>${confirm}</div>`;
    if (expired)
      return `<dialog id="cleanup-preview" aria-labelledby="cleanup-preview-heading"><div class="dialog-body"><h2 id="cleanup-preview-heading">Preview expired</h2><p role="alert">This preview expired. Preview again to see what a cleanup would delete now.</p>${actions(`<button class="btn primary" type="button" data-disk="preview-again"${busy ? " disabled" : ""}>Preview again</button>`)}</div></dialog>`;
    const groups = ["temporary", "closeout_logs"]
      .map(
        (category) =>
          [category, preview!.items.filter((item) => item.category === category)] as const,
      )
      .filter(([, items]) => items.length > 0)
      .map(
        ([category, items]) =>
          `<h3>${label(category)}: ${count(items.length)}, ${bytes(sum(items))}</h3>${preCategory(items)}`,
      )
      .join("");
    const kept = preview.kept.length
      ? `<h3>Kept</h3><ul>${preview.kept.map((entry) => `<li>${esc(label(entry.category))}: ${count(entry.count)} kept, ${esc(entry.reason)}</li>`).join("")}</ul>`
      : "";
    const total = preview.items.length;
    return `<dialog id="cleanup-preview" aria-labelledby="cleanup-preview-heading"><div class="dialog-body"><h2 id="cleanup-preview-heading">Clean up the Paws server</h2><p><b>${bytes(sum(preview.items))}</b> in ${count(total)}</p>${groups || '<p class="sub">Nothing to delete.</p>'}${kept}${actions(`<button class="btn !bg-state-failed !text-main-foreground" type="button" data-disk="run"${total === 0 || busy ? " disabled" : ""}>Delete ${count(total)}</button>`)}</div></dialog>`;
  };

  const paint = () => {
    if (!root) return;
    const now = Date.now();
    const off = busy || !engine ? " disabled" : "";
    renderMarkup(
      root,
      `<section class="settings-section"><div class="settings-label col"><h2>Disk use</h2><p class="sub">What Paws keeps on the server and each runner.</p><div class="row"><button class="btn" type="button" data-disk="refresh-all"${off}>Refresh all</button><button class="btn" type="button" data-disk="preview"${off}>Preview cleanup</button></div></div><div class="col">${message ? `<p class="settings-message${failed ? " err" : ""}" role="${failed ? "alert" : "status"}">${esc(message)}</p>` : ""}${warning()}${machineCards(now)}</div></section>
      <section class="settings-section"><div class="settings-label"><h2>Cleanup schedule and rules</h2><p class="sub">What a cleanup deletes and when the daily cleanup runs.</p></div><div class="col">${rulesForm()}</div></section>
      <section class="settings-section"><div class="settings-label"><h2>Cleanup history</h2><p class="sub">The latest 20 cleanups.</p></div><div class="col">${historyTable()}</div></section>${dialog()}`,
    );
    const open = root.querySelector<HTMLDialogElement>("#cleanup-preview");
    if (open) {
      open.showModal();
      open.addEventListener("close", () => {
        if (!open.isConnected || !preview) return;
        preview = null;
        paint();
      });
    }
  };

  const act = async (work: () => Promise<string>) => {
    if (!engine || busy) return;
    const started = generation;
    busy = true;
    failed = false;
    paint();
    try {
      const done = await work();
      if (started !== generation) return;
      message = done;
    } catch (cause) {
      if (started !== generation) return;
      failed = true;
      message = cause instanceof Error ? cause.message : "Storage request failed.";
    }
    busy = false;
    paint();
  };

  const loadBackground = async () => {
    background = await call<Preview>("/api/settings/storage-cleanup/preview", "POST", {
      machine: SERVER,
    }).catch(() => null);
  };

  const loadUsage = async () => {
    usage = await call<Usage>("/api/settings/storage-usage");
  };

  const poll = () => {
    const started = generation;
    const tick = async () => {
      if (started !== generation || !usage) return;
      await loadUsage().catch(() => undefined);
      if (started !== generation) return;
      paint();
      if ((usage.scanning || usage.runners.some((runner) => runner.reporting)) && ++polls < 40)
        poll();
      else {
        await loadBackground();
        if (started === generation) paint();
      }
    };
    setTimeout(() => void tick(), 3_000);
  };

  const load = () =>
    act(async () => {
      const [read, saved, past] = await Promise.all([
        call<Usage>("/api/settings/storage-usage"),
        call<Rules>("/api/settings/storage-cleanup"),
        call<Cleanup[]>("/api/settings/storage-cleanup/history"),
      ]);
      usage = read;
      rules = saved;
      draft = structuredClone(saved);
      history = past;
      await loadBackground();
      return "";
    });

  const openPreview = (categories?: string[]) =>
    act(async () => {
      previewCategories = categories;
      preview = await call<Preview>("/api/settings/storage-cleanup/preview", "POST", {
        machine: SERVER,
        ...(categories ? { categories } : {}),
      });
      expired = preview.expiresAt <= Date.now();
      return "";
    });

  const read = () => {
    if (!draft) return;
    const field = (name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]`);
    draft.schedule.enabled = !!field("cleanup-enabled")?.checked;
    draft.schedule.timeUtc = field("cleanup-time")?.value ?? draft.schedule.timeUtc;
    draft.schedule.machines = [
      ...root.querySelectorAll<HTMLInputElement>('[name="cleanup-machine"]'),
    ]
      .filter((input) => input.checked)
      .map((input) => input.value);
    draft.categories.temporary.enabled = !!field("cleanup-temporary")?.checked;
    draft.categories.temporary.olderThanHours = Number(field("cleanup-hours")?.value);
    draft.categories.closeout_logs.enabled = !!field("cleanup-closeout")?.checked;
  };

  const save = async () => {
    rules = await call<Rules>("/api/settings/storage-cleanup", "PUT", draft);
    draft = structuredClone(rules);
    return "Cleanup rules saved.";
  };

  const click = (event: Event) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-disk]");
    const action = target?.dataset.disk;
    if (!action) return;
    if (action === "refresh-all" || action === "refresh")
      void act(async () => {
        await call(
          "/api/settings/storage-usage/refresh",
          "POST",
          action === "refresh" ? { machine: target.dataset.machine } : undefined,
        );
        await loadUsage();
        polls = 0;
        poll();
        return "Scanning disk use…";
      });
    if (action === "preview") void openPreview();
    if (action === "preview-again") void openPreview(previewCategories);
    if (action === "preview-rules") {
      const form = root.querySelector<HTMLFormElement>("#cleanup-form");
      if (!form?.reportValidity()) return;
      read();
      void act(async () => {
        await save();
        previewCategories = (["temporary", "closeout_logs"] as const).filter(
          (category) => rules!.categories[category].enabled,
        );
        preview = await call<Preview>("/api/settings/storage-cleanup/preview", "POST", {
          machine: SERVER,
          categories: previewCategories,
        });
        expired = false;
        return "Cleanup rules saved.";
      });
    }
    if (action === "cancel") root.querySelector<HTMLDialogElement>("#cleanup-preview")?.close();
    if (action === "toggle") {
      const id = target.dataset.run!;
      if (!opened.delete(id)) opened.add(id);
      paint();
    }
    if (action === "run" && preview) {
      const id = preview.id;
      if (preview.expiresAt <= Date.now()) {
        expired = true;
        paint();
        return;
      }
      void act(async () => {
        try {
          const done = await call<Cleanup>("/api/settings/storage-cleanup/run", "POST", {
            previewId: id,
          });
          preview = null;
          history = await call<Cleanup[]>("/api/settings/storage-cleanup/history");
          await Promise.all([loadUsage().catch(() => undefined), loadBackground()]);
          if (done.error) throw new Error(`The cleanup stopped: ${done.error}`);
          return `Deleted ${count(done.deleted.length)} and freed ${bytes(done.freedBytes)}.`;
        } catch (cause) {
          const status = (cause as { status?: number }).status;
          if (status !== 410 && status !== 404) throw cause;
          expired = true;
          return "";
        }
      });
    }
  };

  const change = () => read();
  const submit = (event: Event) => {
    event.preventDefault();
    read();
    void act(save);
  };

  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      root?.removeEventListener("submit", submit);
      generation++;
      busy = false;
      usage = rules = draft = background = preview = null;
      history = [];
      opened = new Set();
      message = "";
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      root.addEventListener("submit", submit);
      if (engine) void load();
      else paint();
    },
  };
}
