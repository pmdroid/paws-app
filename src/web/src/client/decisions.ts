import { journalCaught } from "../journal";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";
import { esc } from "./format";

type Decision = {
  id: string;
  questionId: string;
  statement: string;
  scopeGlobs: string[];
  tags: string[];
  revision: number;
  retiredAt: number | null;
  author: string;
  sourceUrl: string;
  repository: string;
  shown: number;
  accepted: number;
};
type Answer = { id: string; body: string; answer: string; author: string; repository: string };

export function initializeDecisions(root: HTMLElement, csrfToken: string, canEdit: boolean) {
  const section = document.createElement("section");
  section.dataset.settingsPage = "decisions";
  section.hidden = true;
  section.className = "settings-section";
  root.append(section);
  let query = "";
  let active = 0;
  const fields = (statement = "", globs = ["**"], tags: string[] = []) =>
    `<label class="field"><span>Decision</span><textarea aria-label="Decision" name="statement" required maxlength="4000" rows="3">${esc(statement)}</textarea></label><label class="field"><span>File scope, one glob per line</span><textarea aria-label="File scope, one glob per line" name="scopeGlobs" required rows="2">${esc(globs.join("\n"))}</textarea><span class="muted">Use ** for the whole source repository, or paths such as src/api/**.</span></label><label class="field"><span>Tags, separated by commas</span><input name="tags" value="${esc(tags.join(", "))}" /></label>`;
  async function save(body: unknown, form: HTMLFormElement) {
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    const status = form.querySelector<HTMLElement>('[role="status"]')!;
    status.textContent = "Saving…";
    try {
      const response = await fetch("/api/workspaces/decisions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-paws-csrf": csrfToken,
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Save failed. Try again.");
      await load();
    } catch (error) {
      journalCaught(error, "decisions.save.fetch", null);
      status.textContent = error instanceof Error ? error.message : "Save failed. Try again.";
    } finally {
      button.disabled = false;
    }
  }
  async function load() {
    const generation = ++active;
    if (!section.hasChildNodes())
      renderMarkup(section, '<p role="status">Loading saved decisions…</p>');
    try {
      const response = await fetch(
        `/api/workspaces/decisions?search=${encodeURIComponent(query)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Decisions could not be loaded. Try again.");
      const data = (await response.json()) as { decisions: Decision[]; answers: Answer[] };
      if (generation !== active || !section.isConnected) return;
      renderMarkup(
        section,
        `<div><h2>Saved decisions</h2><p class="sub">Save a confirmed answer for future questions. Paws suggests matching decisions in Linear for a person to confirm.</p></div><div class="flex min-w-0 flex-col gap-6"><form data-search class="flex min-w-0 flex-col gap-3"><label class="field"><span>Search decisions</span><input name="search" maxlength="1000" value="${esc(query)}" /></label><button class="btn self-start" type="submit">Search</button></form>${canEdit ? `<details><summary>Save an answer as a decision</summary>${data.answers.length ? `<form data-create class="flex flex-col gap-4"><label class="field"><span>Confirmed answer</span><select aria-label="Confirmed answer" name="questionId" required><option value="">Choose an answer</option>${data.answers.map((answer) => `<option value="${esc(answer.id)}">${esc(answer.repository)} · ${esc(answer.body.slice(0, 120))}</option>`).join("")}</select></label>${fields()}<button class="btn primary" type="submit">Save decision</button><p role="status"></p></form>` : '<p class="muted">Answered questions from your accessible repositories will appear here.</p>'}</details>` : ""}<div class="flex flex-col gap-6">${data.decisions.length ? data.decisions.map((decision) => `<article class="flex min-w-0 flex-col gap-3 border-b pb-6"><div class="between"><strong>${esc(decision.repository)}</strong><span class="pill${decision.retiredAt ? "" : " ok"}">${decision.retiredAt ? "Retired" : "Active"}</span></div><p class="break-words whitespace-pre-wrap">${esc(decision.statement)}</p><p class="muted">Scope: ${esc(decision.scopeGlobs.join(", "))}${decision.tags.length ? ` · Tags: ${esc(decision.tags.join(", "))}` : ""}</p><p><a href="${esc(decision.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source answer in Linear</a> · Answered by ${esc(decision.author)}</p><p class="muted">${decision.accepted} accepted / ${decision.shown} suggestions · Revision ${decision.revision}</p>${canEdit && !decision.retiredAt ? `<details><summary>Correct or retire decision</summary><form data-edit="${esc(decision.id)}" class="flex flex-col gap-4">${fields(decision.statement, decision.scopeGlobs, decision.tags)}<label><input type="checkbox" name="retire" /> Retire this decision</label><button class="btn" type="submit">Save changes</button><p role="status"></p></form></details>` : ""}</article>`).join("") : `<p class="muted">${query ? "No decisions match your search." : "No saved decisions yet."}</p>`}</div></div>`,
      );
      section
        .querySelector<HTMLFormElement>("[data-search]")!
        .addEventListener("submit", (event) => {
          event.preventDefault();
          query = String(new FormData(event.currentTarget as HTMLFormElement).get("search") ?? "");
          void load();
        });
      const create = section.querySelector<HTMLFormElement>("[data-create]");
      create?.querySelector("select")?.addEventListener("change", (event) => {
        const answer = data.answers.find(
          (entry) => entry.id === (event.target as HTMLSelectElement).value,
        );
        create.querySelector<HTMLTextAreaElement>('[name="statement"]')!.value =
          answer?.answer ?? "";
      });
      for (const form of section.querySelectorAll<HTMLFormElement>("[data-create], [data-edit]"))
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const values = new FormData(form);
          const decision = data.decisions.find((entry) => entry.id === form.dataset.edit);
          void save(
            {
              ...(decision
                ? { id: decision.id, revision: decision.revision }
                : { questionId: values.get("questionId") }),
              statement: values.get("statement"),
              scopeGlobs: String(values.get("scopeGlobs"))
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              tags: String(values.get("tags"))
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              retire: values.has("retire"),
            },
            form,
          );
        });
    } catch (error) {
      journalCaught(error, "decisions.load.fetch", null);
      if (generation !== active) return;
      renderMarkup(
        section,
        `<p role="status">${esc(error instanceof Error ? error.message : "Loading failed.")}</p><button class="btn" type="button">Try again</button>`,
      );
      section.querySelector("button")!.addEventListener("click", () => void load());
    }
  }
  loadWhenShown("decisions", () => void load());
}
