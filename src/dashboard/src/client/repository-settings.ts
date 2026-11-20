import { esc } from "./format";
import { readCsrfToken } from "./csrf";
import { renderMarkup } from "./theme";
import { settingsAreEditable } from "./settings-pages";

type Access = {
  agentRead: boolean;
  mirrors: boolean;
  restartRequired?: boolean;
};
type Policies = { projects: Record<string, { policyRoot: string }> };
type Description = {
  repository: string;
  text: string | null;
  source: "paws" | "admin" | "github" | null;
};
const SOURCES = { paws: "Written by Paws", admin: "Written by an admin", github: "From GitHub" };
const DESCRIPTIONS_PATH = "/api/settings/repository-descriptions";
const counter = (text: string) => (text.length >= 250 ? `${text.length}/300` : "");

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
  let descriptions: Description[] | null = null;
  let descriptionsError = "";
  let describing = false;
  const drafts = new Map<string, string>();
  const rowErrors = new Map<string, string>();
  const request = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
    if (!engine) throw new Error("Connect to your Paws dashboard to load settings.");
    const response = await fetch(new URL(path, engine), {
      method: method ?? (body === undefined ? "GET" : "PUT"),
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
  const describe = (entry: Description, i: number) => {
    const label = entry.source ? SOURCES[entry.source] : "No description yet";
    if (!settingsAreEditable())
      return `<div class="settings-project"><h3>${esc(entry.repository)}</h3>${entry.text ? `<p>${esc(entry.text)}</p>` : ""}<p class="sub">${label}</p></div>`;
    const text = drafts.get(entry.repository) ?? entry.text ?? "";
    const failure = rowErrors.get(entry.repository);
    const disabled = describing ? "disabled" : "";
    return `<form class="settings-project" data-description="${i}"><h3>${esc(entry.repository)}</h3><p class="sub">${label}</p><div class="settings-field"><label for="description-${i}">Description</label><input id="description-${i}" name="description" data-description-input="${i}" value="${esc(text)}" maxlength="300" ${failure ? `aria-invalid="true" aria-describedby="description-${i}-error"` : ""} ${disabled}><small class="sub" data-description-counter="${i}">${counter(text)}</small>${failure ? `<p class="err" role="alert" id="description-${i}-error">${esc(failure)}</p>` : ""}</div><div class="row"><button class="btn primary" type="submit" ${disabled}>Save description</button>${entry.source && entry.source !== "paws" ? `<button class="btn" type="button" data-description-clear="${i}" ${disabled}>Let Paws write it</button>` : ""}</div></form>`;
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
      `<form><fieldset class="settings-fields" ${busy ? "disabled" : ""}>${loaded ? controls : ""}${loaded && linear ? '<button class="btn primary" type="submit">Save settings</button>' : ""}</fieldset>${busy ? '<p role="status">Loading settings…</p>' : ""}${error ? `<p class="err" role="alert">${esc(error)}</p>` : message ? `<p role="status">${esc(message)}</p>` : ""}</form>${linear ? "" : `<section class="settings-section"><div class="settings-label"><h2>Repository descriptions</h2><p class="sub">Agents see this when they choose which repository to read.</p></div><div class="col">${descriptionsError ? `<p class="err" role="alert">${esc(descriptionsError)}</p>` : !descriptions ? '<p role="status">Loading descriptions…</p>' : descriptions.length ? descriptions.map(describe).join("") : '<p class="sub">No repositories yet.</p>'}</div></section>`}`,
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
  const changeDescription = async (index: number, text?: string) => {
    const entry = descriptions?.[index];
    if (!entry || describing) return;
    const { repository } = entry;
    if (text !== undefined && (!text.trim() || text.length > 300)) {
      rowErrors.set(repository, "A repository description must be 1 to 300 characters.");
      paint();
      return;
    }
    if (loaded && !busy) draft();
    describing = true;
    rowErrors.delete(repository);
    paint();
    try {
      descriptions = (
        await request<{ repositories: Description[] }>(
          DESCRIPTIONS_PATH,
          text === undefined ? { repository } : { repository, text },
          text === undefined ? "DELETE" : "PUT",
        )
      ).repositories;
      drafts.delete(repository);
    } catch (e) {
      rowErrors.set(repository, e instanceof Error ? e.message : "Could not save the description.");
    }
    describing = false;
    paint();
  };
  root.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    const index = input.dataset?.descriptionInput;
    const entry = index === undefined ? undefined : descriptions?.[Number(index)];
    if (!entry) return;
    drafts.set(entry.repository, input.value);
    const count = root.querySelector(`[data-description-counter="${index}"]`);
    if (count) count.textContent = counter(input.value);
  });
  root.addEventListener("click", (event) => {
    const clear = (event.target as Element).closest<HTMLElement>("[data-description-clear]");
    if (clear) {
      void changeDescription(Number(clear.dataset.descriptionClear));
      return;
    }
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
    const form = (event.target as Element).closest<HTMLElement>("[data-description]");
    if (form) {
      const index = Number(form.dataset.description);
      const input = form.querySelector<HTMLInputElement>('[name="description"]');
      void changeDescription(index, input?.value ?? "");
      return;
    }
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
  if (!linear)
    void request<{ repositories: Description[] }>(DESCRIPTIONS_PATH)
      .then((data) => {
        descriptions = data.repositories;
      })
      .catch((e) => {
        descriptionsError = e instanceof Error ? e.message : "Could not load descriptions.";
      })
      .then(paint);
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
