import { envNote, envVariable, type FieldSources } from "./env-source";
import { esc } from "./format";
import { loadWhenShown } from "./settings-loads";
import type { SettingsPage } from "./settings-pages";
import { renderMarkup } from "./theme";

type Rotation = {
  page: SettingsPage;
  title: string;
  endpoint: string;
  method: "PUT" | "PATCH";
  fields: [name: string, label: string][];
  done: string;
};

const ROTATIONS: Rotation[] = [
  {
    page: "linear",
    title: "Rotate the Linear client",
    endpoint: "/api/settings/linear-client",
    method: "PUT",
    fields: [
      ["clientId", "client ID"],
      ["clientSecret", "client secret"],
      ["webhookSecret", "webhook signing secret"],
    ],
    done: "Linear accepted the new values. Restart Paws to use them.",
  },
  {
    page: "integrations",
    title: "Rotate the GitHub webhook secret",
    endpoint: "/api/workspaces/github-app",
    method: "PATCH",
    fields: [["webhookSecret", "webhook secret"]],
    done: "GitHub now signs deliveries with the new secret.",
  },
];

export function initializeCredentialRotation(root: HTMLElement, csrfToken: string): void {
  for (const rotation of ROTATIONS)
    loadWhenShown(rotation.page, () => void rotate(root, csrfToken, rotation));
}

async function rotate(root: HTMLElement, csrfToken: string, rotation: Rotation) {
  const response = await fetch(rotation.endpoint, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const data = (await response.json()) as { configured?: boolean; sources?: FieldSources };
  if (data.configured === false) return;
  const fields = rotation.fields.filter(
    ([name]) => data.sources?.[name]?.source === "settings" || envVariable(data.sources, name),
  );
  if (!fields.some(([name]) => data.sources?.[name]?.source === "settings")) return;
  const section = document.createElement("section");
  section.className = "settings-section";
  section.dataset.settingsPage = rotation.page;
  section.dataset.rotation = rotation.method;
  root.append(section);
  renderMarkup(
    section,
    `<div><h2>${esc(rotation.title)}</h2><p class="sub">Enter only the values you are replacing. Paws checks them before saving; a failed check keeps the current values.</p></div><form class="settings-account flex min-w-0 flex-col gap-4" autocomplete="off">${fields
      .map(([name, label]) => {
        const variable = envVariable(data.sources, name);
        return `<label class="field"><span>New ${esc(label)}</span>${
          variable
            ? envNote(variable)
            : `<input name="${name}" type="password" autocomplete="new-password" />`
        }</label>`;
      })
      .join(
        "",
      )}<p role="alert" data-error></p><p role="status" data-done></p><button class="btn primary" type="submit">Rotate</button></form>`,
  );
  const form = section.querySelector("form")!;
  const error = form.querySelector<HTMLElement>("[data-error]")!;
  const done = form.querySelector<HTMLElement>("[data-done]")!;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const button = form.querySelector("button")!;
      error.textContent = done.textContent = "";
      const body = Object.fromEntries(
        [...new FormData(form)].filter(([, value]) => typeof value === "string" && value.trim()),
      );
      if (Object.keys(body).length === 0) {
        error.textContent = "Enter a new value to rotate.";
        return;
      }
      button.disabled = true;
      try {
        const saved = await fetch(rotation.endpoint, {
          method: rotation.method,
          headers: { "content-type": "application/json", "x-paws-csrf": csrfToken },
          body: JSON.stringify(body),
        });
        const reply = (await saved.json().catch(() => ({}))) as { error?: string };
        if (!saved.ok) throw new Error(reply.error ?? "The new values could not be saved.");
        form.reset();
        done.textContent = rotation.done;
      } catch (caught) {
        error.textContent = (caught as Error).message;
      } finally {
        button.disabled = false;
      }
    })();
  });
}
