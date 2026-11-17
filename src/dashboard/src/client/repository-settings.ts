import { esc } from "./format";
import { readCsrfToken } from "./csrf";
import { renderMarkup } from "./theme";

type Access = {
  agentRead: boolean;
  mirrors: boolean;
  restartRequired?: boolean;
};
type Policies = { projects: Record<string, { policyRoot: string }> };

export function mountRepositorySettings(engine: string | null): void {
  const root = document.querySelector<HTMLElement>("#repositories-settings, #linear-settings");
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = "true";
  const linear = root.id === "linear-settings";
  let access: Access = { agentRead: true, mirrors: false };
  let policies: Policies = { projects: {} };
  let agents: string[] = [];
  let busy = true;
  let loaded = false;
  let error = "";
  let message = "";
  let rows: [string, string][] = [];
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    if (!engine) throw new Error("Connect to your Paws dashboard to load settings.");
    const response = await fetch(new URL(path, engine), {
      method: body === undefined ? "GET" : "PUT",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  };
  const paint = () => {
    if (!root.isConnected) return;
    const controls = linear
      ? `<section class="settings-section"><div class="settings-label"><h2>Comment agents</h2><p class="sub">Linear app user IDs, one per line.</p></div><div class="settings-field"><label for="linear-comment-agents">Agents</label><textarea id="linear-comment-agents" name="agents" rows="6">${esc(agents.join("\n"))}</textarea></div></section>`
      : `<section class="settings-section"><div class="settings-label"><h2>GitHub access</h2></div><div class="col">${[
          ["agentRead", "Agents may read the repository"],
          ["mirrors", "Use local mirrors"],
        ]
          .map(
            ([key, label]) =>
              `<label class="settings-inherit"><input type="checkbox" name="${key}" ${access[key as "agentRead" | "mirrors"] ? "checked" : ""}>${label}</label>`,
          )
          .join(
            "",
          )}${access.restartRequired ? '<p role="status">Restart Paws for Closeout policy reads to use the new mirrors setting.</p>' : ""}<button class="btn primary" type="submit" name="section" value="access">Save GitHub access</button></div></section>
      <section class="settings-section"><div class="settings-label"><h2>Closeout policy roots</h2><p class="sub">Absolute directories on the Paws host, per repository.</p></div><div class="col">${rows.map(([repo, path], i) => `<div class="settings-project"><div class="settings-field"><label for="policy-repo-${i}">Repository</label><input id="policy-repo-${i}" name="repo-${i}" value="${esc(repo)}" placeholder="owner/repo"></div><div class="settings-field"><label for="policy-root-${i}">Policy root</label><input id="policy-root-${i}" name="root-${i}" value="${esc(path)}" placeholder="/path/to/policy"></div><button class="btn" type="button" data-remove="${i}">Remove repository</button></div>`).join("")}${!rows.length ? '<p class="sub">No local policy roots configured.</p>' : ""}<button class="btn" type="button" data-add>Add repository</button><button class="btn primary" type="submit" name="section" value="policies">Save policy roots</button></div></section>`;
    renderMarkup(
      root,
      `<form><fieldset class="settings-fields" ${busy ? "disabled" : ""}>${loaded ? controls : ""}${loaded && linear ? '<button class="btn primary" type="submit">Save settings</button>' : ""}</fieldset>${busy ? '<p role="status">Loading settings…</p>' : ""}${error ? `<p class="err" role="alert">${esc(error)}</p>` : message ? `<p role="status">${esc(message)}</p>` : ""}</form>`,
    );
  };
  const draft = () => {
    const form = root.querySelector("form")!;
    const data = new FormData(form);
    if (linear)
      agents = String(data.get("agents") ?? "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    else {
      access = { ...access, agentRead: data.has("agentRead"), mirrors: data.has("mirrors") };
      rows = rows.map((_, i) => [
        String(data.get(`repo-${i}`) ?? ""),
        String(data.get(`root-${i}`) ?? ""),
      ]);
    }
  };
  root.addEventListener("click", (event) => {
    if (busy) return;
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "[data-add], [data-remove]",
    );
    if (!button) return;
    draft();
    if (button.hasAttribute("data-add")) rows.push(["", ""]);
    else rows.splice(Number(button.dataset.remove), 1);
    paint();
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !loaded) return;
    draft();
    const section = (event as SubmitEvent).submitter?.getAttribute("value");
    void run(async () => {
      if (linear)
        agents = (await request<{ agents: string[] }>("/api/settings/linear-comments", { agents }))
          .agents;
      else if (section === "access")
        access = await request<Access>("/api/settings/github-access", {
          agentRead: access.agentRead,
          mirrors: access.mirrors,
        });
      else {
        if (new Set(rows.map(([repo]) => repo.toLowerCase())).size !== rows.length)
          throw new Error("Each repository must appear only once.");
        policies = await request<Policies>("/api/settings/closeout", {
          projects: Object.fromEntries(rows.map(([repo, policyRoot]) => [repo, { policyRoot }])),
        });
        rows = Object.entries(policies.projects).map(([repo, entry]) => [repo, entry.policyRoot]);
      }
      message = "Settings saved.";
    });
  });
  async function run(action: () => Promise<void>) {
    busy = true;
    error = message = "";
    paint();
    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not update settings.";
    }
    busy = false;
    paint();
  }
  void run(async () => {
    if (linear)
      agents = (await request<{ agents: string[] }>("/api/settings/linear-comments")).agents;
    else {
      [access, policies] = await Promise.all([
        request<Access>("/api/settings/github-access"),
        request<Policies>("/api/settings/closeout"),
      ]);
      rows = Object.entries(policies.projects).map(([repo, entry]) => [repo, entry.policyRoot]);
    }
    loaded = true;
  });
}
