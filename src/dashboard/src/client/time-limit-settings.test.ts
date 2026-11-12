import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderSettingsPage } from "./settings-pages";
import {
  createTimeLimitSettings,
  renderTimeLimitSettings,
  timeLimitDraft,
  type TimeLimitSettings,
} from "./time-limit-settings";
import { settleReactWork } from "./settle-react";

const DEFAULTS: TimeLimitSettings = {
  configured: false,
  default: { implementationMinutes: 180, fixesMinutes: 0, closeoutMinutes: 0 },
  projects: [],
};
const view = (data: TimeLimitSettings) => ({
  draft: timeLimitDraft(data),
  busy: null,
  error: null,
  saved: false,
  fieldErrors: {},
});

test("Settings › Queue and limits holds the Time limits section", () => {
  expect(renderSettingsPage("limits")).toContain('id="time-limit-settings"');
});

test("the section shows the defaults and the not-counted state", () => {
  const html = renderTimeLimitSettings(view(DEFAULTS));
  expect(html).toContain("<h2>Time limits</h2>");
  expect(html).toContain('name="time-default-implementation" type="number"');
  expect(html).toContain('value="180"');
  for (const stage of ["fixes", "closeout"]) {
    const select = html
      .slice(html.indexOf(`name="time-default-${stage}-mode"`))
      .split("</select>")[0]!;
    expect(select).toContain('<option value="off" selected>Not counted</option>');
    expect(html).not.toContain(`name="time-default-${stage}" `);
  }
  expect(html).toContain("Fix rounds");
  expect(html).toContain("No project overrides.");
});

test("project overrides list under the global values and inherit what they leave out", () => {
  const html = renderTimeLimitSettings(
    view({ ...DEFAULTS, projects: [{ id: "paws-fixes", fixesMinutes: 45 }] }),
  );
  expect(html.indexOf("time-default-closeout")).toBeLessThan(html.indexOf("<h3>paws-fixes</h3>"));
  expect(html).toContain('name="time-project-0-fixes" type="number"');
  expect(html).toContain('value="45"');
  const implementation = html
    .slice(html.indexOf('name="time-project-0-implementation-mode"'))
    .split("</select>")[0]!;
  expect(implementation).toContain('<option value="inherit" selected>Workspace default</option>');
});

let window: Window;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const GLOBALS = ["window", "document", "Element", "HTMLElement", "Event"] as const;
let requests: { url: string; init: RequestInit }[];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/settings/agents" });
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    const body = init.body ? JSON.parse(String(init.body)) : DEFAULTS;
    return Response.json(init.body ? { configured: true, ...body } : body);
  }) as typeof fetch;
});

afterEach(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

function setValue(root: HTMLElement, name: string, value: string) {
  const field = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
}

test("editing and saving calls the Settings API with the right values", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(root as never);
  createTimeLimitSettings().mount(root, "http://127.0.0.1:8787");
  await settle();
  setValue(root, "time-default-implementation", "240");
  setValue(root, "time-default-closeout-mode", "limit");
  setValue(root, "time-default-closeout", "30");
  setValue(root, "time-new-project", "paws-fixes");
  root.querySelector<HTMLButtonElement>('[data-time-limits="add-project"]')!.click();
  setValue(root, "time-project-0-fixes-mode", "limit");
  setValue(root, "time-project-0-fixes", "60");
  const form = () => root.querySelector("#time-limit-form")!;
  form().dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
  await settle();
  const put = requests.at(-1)!;
  expect(put.url).toBe("http://127.0.0.1:8787/api/settings/time-limits");
  expect(put.init.method).toBe("PUT");
  expect((put.init.headers as Record<string, string>)["x-paws-csrf"]).toBe("token-1");
  expect(JSON.parse(String(put.init.body))).toEqual({
    default: { implementationMinutes: 240, fixesMinutes: 0, closeoutMinutes: 30 },
    projects: [{ id: "paws-fixes", fixesMinutes: 60 }],
  });
  expect(root.innerHTML).toContain("Saved");
});

test("invalid minutes show the error next to the field and save nothing", async () => {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  createTimeLimitSettings().mount(root, "http://127.0.0.1:8787");
  await settle();
  setValue(root, "time-default-implementation", "0");
  root
    .querySelector("#time-limit-form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
  await settle();
  expect(requests.map((request) => request.init.method)).toEqual(["GET"]);
  const input = root.querySelector('[name="time-default-implementation"]')!;
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(root.querySelector("#time-default-implementation-error")!.textContent).toBe(
    "Enter whole minutes from 1 to 10080.",
  );
});
