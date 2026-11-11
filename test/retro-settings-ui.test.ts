import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Window,
  type HTMLElement as El,
  type HTMLFieldSetElement as FieldSetEl,
  type HTMLFormElement as FormEl,
  type HTMLInputElement as InputEl,
  type HTMLSelectElement as SelectEl,
  type HTMLTextAreaElement as TextAreaEl,
} from "happy-dom";
import { migrate, openDatabase, putWorkspaceUser, syncWorkspaceMember, sqliteDb } from "../src/db";
import type { AgentModelCatalog } from "../src/runner-models";
import {
  createFakeRetroCatalog,
  createRetroPreviewHttp,
  createRetroSettingsHttp,
  DEFAULT_RETRO_PROMPT,
} from "../src/retros";
import type { WorkspacePrincipal } from "../src/workspace";
import { ALL, world } from "./improvement-fixtures";

const client = (path: string) => import(path);
const { createRetroSettings } = await client("../src/dashboard/src/client/retro-settings.ts");

const APP = "pmdroid/paws-app";
const OLD = "pmdroid/old-app";
const CATALOGS: AgentModelCatalog[] = [
  {
    agent: "codex",
    updatedAt: 1,
    efforts: [{ id: "medium", name: "Medium" }],
    defaultModel: "gpt-6-astra",
    models: [
      {
        id: "gpt-6-astra",
        name: "gpt-6-astra",
        longContext: false,
        efforts: [
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
        defaultEffort: "medium",
      },
      {
        id: "gpt-6-mini",
        name: "gpt-6-mini",
        longContext: false,
        efforts: [{ id: "low", name: "Low" }],
        defaultEffort: "low",
      },
    ],
  },
  {
    agent: "claude",
    updatedAt: 1,
    efforts: [],
    defaultModel: "opus",
    models: [{ id: "opus", name: "Opus", longContext: false, efforts: [], defaultEffort: null }],
  },
];

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Element",
  "Event",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "CSS",
] as const;
const saved = new Map<string, unknown>();
let window: Window;

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/dashboard/improvements/settings" });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
});

afterEach(() => {
  for (const name of DOM_GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
  window.close();
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function harness(catalogs: AgentModelCatalog[] | null = CATALOGS) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'Kyku', 0)");
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-1')", [APP]);
  const people: Record<string, WorkspacePrincipal> = {};
  for (const [name, role] of [
    ["admin", "admin"],
    ["other", "admin"],
    ["member", "member"],
  ] as const) {
    const userId = await putWorkspaceUser(sqliteDb(db), {
      id: `user-${name}`,
      linearUserId: name,
      name,
      email: `${name}@example.invalid`,
    });
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: "ws",
      userId,
      role,
      active: true,
      teamIds: [],
      now: 1,
    });
    people[name] = { workspaceId: "ws", userId, role, authenticatedAt: 1, teamIds: [] };
  }
  const catalog = createFakeRetroCatalog(catalogs);
  const settings = createRetroSettingsHttp({
    store: sqliteDb(db),
    catalog: catalog.read,
    now: () => 5,
  });
  const preview = createRetroPreviewHttp({
    store: sqliteDb(db),
    artifactRoot: "/nonexistent",
    now: () => 5,
  });
  const requests: { method: string; path: string; body: unknown }[] = [];
  const holds: (() => void)[] = [];
  let hold: RegExp | null = null;
  let who = "admin";
  const override = new Map<string, () => Response>();
  const serve = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", path: target.pathname, body });
    if (hold?.test(target.pathname)) {
      const gate = Promise.withResolvers<void>();
      holds.push(gate.resolve);
      await gate.promise;
    }
    const forced = override.get(target.pathname);
    if (forced) return forced();
    if (target.pathname === "/api/runners/models") return Response.json({ catalogs });
    const request = new Request(target.toString(), {
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const answer =
      (await settings(request, people[who]!)) ?? (await preview(request, people[who]!, []));
    return answer ?? Response.json({ error: "Not found." }, { status: 404 });
  };
  const controller = createRetroSettings({
    fetch: serve,
    csrf: () => "token",
    paint: (root: El, html: string) => {
      root.innerHTML = html;
    },
  });
  const page = window.document.createElement("div");
  window.document.body.append(page);
  const open = async (reader = "ws:user-admin") => {
    page.innerHTML = '<div data-retro-settings=""></div>';
    controller.attach(page, "http://127.0.0.1:8787", reader);
    await settle();
  };
  const $ = <T = El>(selector: string) => page.querySelector(selector) as unknown as T;
  const text = () => page.textContent ?? "";
  const pick = async (selector: string, value: string) => {
    const element = $<SelectEl>(selector);
    element.value = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
  };
  const type = async (selector: string, value: string) => {
    const element = $<InputEl>(selector);
    element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
  };
  const click = async (selector: string) => {
    $<El>(selector).click();
    await settle();
  };
  const submit = async () => {
    $<FormEl>("[data-retro-form]").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
  };
  return {
    db,
    people,
    controller,
    requests,
    override,
    holds,
    setHold: (pattern: RegExp | null) => (hold = pattern),
    as: (name: string) => (who = name),
    settings,
    open,
    $,
    text,
    pick,
    type,
    click,
    submit,
  };
}

test("the form shows proposed values from the API and the signed-in runner catalog", async () => {
  const t = await harness();
  await t.open();
  expect(t.text()).toContain("Proposed defaults, not saved yet");
  expect(t.$<TextAreaEl>("#retro-prompt").value).toBe(DEFAULT_RETRO_PROMPT);
  expect(t.$<SelectEl>("#retro-agent").value).toBe("codex");
  const models = [...t.$<SelectEl>("#retro-model").options].map((o) => o.value);
  expect(models).toEqual(["", "gpt-6-astra", "gpt-6-mini"]);
  expect(t.$<InputEl>('[name="retro-repository"]').checked).toBe(true);
  expect(t.$<InputEl>("#retro-max-items").value).toBe("5");
  expect(t.$<InputEl>("#retro-active-minutes").value).toBe("15");
  expect(t.text()).toContain("Every Monday, 09:00 UTC.");
  expect(t.text()).toContain("spends no execution minutes");
  expect(t.text()).toContain("Finding settings");
});

test("changing agent or model resets incompatible choices", async () => {
  const t = await harness();
  await t.open();
  await t.pick("#retro-model", "gpt-6-astra");
  await t.pick("#retro-effort", "high");
  expect(t.controller.state().draft!.agentProfile).toEqual({
    agent: "codex",
    model: "gpt-6-astra",
    effort: "high",
  });
  await t.pick("#retro-model", "gpt-6-mini");
  expect(t.controller.state().draft!.agentProfile.effort).toBeNull();
  await t.pick("#retro-effort", "low");
  await t.pick("#retro-agent", "claude");
  expect(t.controller.state().draft!.agentProfile).toEqual({
    agent: "claude",
    model: null,
    effort: null,
  });
  const models = [...t.$<SelectEl>("#retro-model").options].map((o) => o.value);
  expect(models).toEqual(["", "opus"]);
});

test("a saved model no runner offers is shown as unavailable, and kept while catalogs load", async () => {
  const t = await harness();
  await t.open();
  await t.pick("#retro-model", "gpt-6-mini");
  await t.submit();
  expect(t.text()).toContain("Saved revision 1");

  const loading = await harness();
  loading.setHold(/\/api\/runners\/models/);
  await loading.open();
  await loading.pick("#retro-model", "");
  expect(loading.text()).toContain("Loading model choices");
  expect(loading.text()).toContain("Your selection is kept");
  loading.holds.forEach((release) => release());
  await settle();
  expect(loading.text()).toContain("Choices come from your signed-in");

  const gone = await harness([{ ...CATALOGS[0]!, models: [CATALOGS[0]!.models[0]!] }]);
  await gone.open();
  gone.controller.state().draft!.agentProfile.model = "gpt-6-mini";
  await gone.open();
  expect(gone.text()).toContain("gpt-6-mini (not offered by a signed-in runner)");
  expect(gone.text()).toContain("No signed-in runner offers gpt-6-mini");
  expect(gone.controller.state().draft!.agentProfile.model).toBe("gpt-6-mini");
});

test("variables insert at the cursor and focus stays in the editor", async () => {
  const t = await harness();
  await t.open();
  await t.type("#retro-prompt", "Look at  please.\n\n{{digest}}");
  const editor = t.$<TextAreaEl>("#retro-prompt");
  editor.focus();
  editor.setSelectionRange(8, 8);
  editor.dispatchEvent(new window.Event("select", { bubbles: true }));
  await t.click('[data-retro-variable="period"]');
  expect(t.$<TextAreaEl>("#retro-prompt").value).toBe("Look at {{period}} please.\n\n{{digest}}");
  expect(window.document.activeElement?.id).toBe("retro-prompt");
  expect(t.$<TextAreaEl>("#retro-prompt").selectionStart).toBe(18);
  expect(t.controller.state().draft!.prompt).toContain("{{period}}");
});

test("prompt errors appear beside the editor and block saving", async () => {
  const t = await harness();
  await t.open();
  await t.type("#retro-prompt", "Use {{nope}}.\n\n{{digest}}");
  expect(t.$("#retro-prompt-error").textContent).toBe("Unknown variable: nope.");
  await t.type("#retro-prompt", "No digest here.");
  expect(t.$("#retro-prompt-error").textContent).toContain("{{digest}} exactly once");
  await t.type("#retro-prompt", "{{digest}} {{digest}}");
  expect(t.$("#retro-prompt-error").textContent).toContain("exactly once");
  await t.type("#retro-prompt", "Broken {{period}\n{{digest}}");
  expect(t.$("#retro-prompt-error").textContent).toContain("matching double braces");
  await t.submit();
  expect(t.requests.filter((r) => r.method === "PUT")).toEqual([]);
  expect(t.text()).toContain("Nothing was saved");
});

test("restore default changes the draft only, and preview renders the draft", async () => {
  const t = await harness();
  await t.open();
  await t.type("#retro-prompt", "Custom for {{period}}.\n\n{{digest}}");
  await t.submit();
  await t.click('[data-retro="restore"]');
  expect(t.$<TextAreaEl>("#retro-prompt").value).toBe(DEFAULT_RETRO_PROMPT);
  expect(t.controller.state().view!.settings.prompt).toBe("Custom for {{period}}.\n\n{{digest}}");
  expect(t.text()).toContain("Unsaved changes");

  await t.type("#retro-max-items", "2");
  await t.click('[data-retro="preview"]');
  const sent = t.requests.find((r) => r.path === "/api/retros/preview")!;
  expect(sent.body).toEqual({
    prompt: DEFAULT_RETRO_PROMPT,
    outputLimits: { maxItems: 2, workedWell: 3 },
  });
  expect(t.$("#retro-prompt-preview").textContent).toContain("Find up to 2 recurring");
  expect(t.text()).toContain("Preview only");
});

test("a preview answer for an older draft never replaces the current one", async () => {
  const t = await harness();
  await t.open();
  t.setHold(/\/api\/retros\/preview/);
  await t.click('[data-retro="preview"]');
  await t.type("#retro-prompt", "Edited for {{period}}.\n\n{{digest}}");
  t.holds.forEach((release) => release());
  await settle();
  expect(t.text()).toContain("The draft changed after this preview");
});

test("save is atomic with the expected revision; drafts survive tab changes and cancel restores", async () => {
  const t = await harness();
  await t.open();
  await t.pick("#retro-cadence", "paused");
  expect(t.text()).toContain("Automatic retros are paused");
  await t.type("#retro-retries", "2");
  await t.submit();
  const put = t.requests.find((r) => r.method === "PUT")!;
  expect(put.body).toMatchObject({
    expectedRevision: 0,
    settings: {
      executionLimits: { activeMinutes: 15, retries: 2 },
      schedule: { cadence: "paused" },
    },
  });
  expect(t.text()).toContain("Saved revision 1");

  await t.type("#retro-worked-well", "1");
  await t.open();
  expect(t.$<InputEl>("#retro-worked-well").value).toBe("1");
  expect(t.text()).toContain("Unsaved changes");
  await t.click('[data-retro="cancel"]');
  expect(t.$<InputEl>("#retro-worked-well").value).toBe("3");
  expect(t.$<SelectEl>("#retro-cadence").value).toBe("paused");
});

test("a revision conflict or a failed save keeps the draft", async () => {
  const t = await harness();
  await t.open();
  await t.type("#retro-max-items", "4");
  await t.settings(
    new Request("http://paws.test/api/retros/settings", {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: 0,
        settings: {
          ...t.controller.state().view!.settings,
          outputLimits: { maxItems: 1, workedWell: 0 },
        },
      }),
    }),
    t.people.other!,
  );
  await t.submit();
  expect(t.text()).toContain("Someone saved retro settings after you started editing");
  expect(t.$<InputEl>("#retro-max-items").value).toBe("4");
  expect(t.text()).toContain("Save over revision 1");

  t.override.set("/api/retros/settings", () =>
    Response.json({ error: "Disk full." }, { status: 500 }),
  );
  await t.submit();
  expect(t.text()).toContain("Disk full. Your draft is kept");
  expect(t.$<InputEl>("#retro-max-items").value).toBe("4");
  t.override.clear();

  await t.submit();
  expect(t.controller.state().view!.revision).toBe(2);
  expect(t.controller.state().view!.settings.outputLimits.maxItems).toBe(4);
});

test("invalid limits and provider unavailability are reported separately", async () => {
  const t = await harness(null);
  await t.open();
  await t.type("#retro-active-minutes", "500");
  await t.submit();
  expect(t.$("#retro-active-minutes-error").textContent).toBe(
    "The time limit is 1 to 120 minutes.",
  );
  expect(t.$('[data-retro-notice="invalid"]')).not.toBeNull();
  await t.type("#retro-active-minutes", "20");
  t.controller.state().draft!.agentProfile.model = "gpt-6-astra";
  await t.submit();
  expect(t.$('[data-retro-notice="provider"]').textContent).toContain(
    "runner availability problem, not an invalid setting",
  );
  expect(t.controller.state().draft!.executionLimits.activeMinutes).toBe(20);
});

test("a repository Paws can no longer access is denied beside the list", async () => {
  const t = await harness();
  t.db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-1')", [OLD]);
  await t.open();
  await t.submit();
  t.db.run("DELETE FROM workspace_repository WHERE repository = ?", [OLD]);
  await t.open("ws:user-admin:reload");
  expect(t.text()).toContain("Paws cannot access this repository");
  await t.submit();
  expect(t.$("#retro-repositories-error").textContent).toContain(`Paws cannot access ${OLD}`);
  const old = [...t.$<El>("fieldset fieldset").querySelectorAll("input")].find(
    (input) => (input as InputEl).value === OLD,
  ) as InputEl;
  old.checked = false;
  old.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  await t.submit();
  expect(t.controller.state().view!.settings.repositories).toEqual([APP]);
});

test("members read the saved settings without editing", async () => {
  const t = await harness();
  t.as("member");
  await t.open("ws:user-member");
  expect(t.text()).toContain("Only workspace admins can change retro settings");
  expect(t.$<FieldSetEl>("fieldset").disabled).toBe(true);
  expect(t.$('[data-retro="cancel"]')).toBeNull();
});

test("a workspace switch or lost permission clears the draft and preview", async () => {
  const t = await harness();
  await t.open();
  await t.type("#retro-prompt", "Secret draft {{period}}\n\n{{digest}}");
  await t.click('[data-retro="preview"]');
  expect(t.controller.state().preview).not.toBeNull();
  await t.open("other-ws:user-admin");
  expect(t.controller.state().preview).toBeNull();
  expect(t.$<TextAreaEl>("#retro-prompt").value).toBe(DEFAULT_RETRO_PROMPT);

  await t.type("#retro-prompt", "Another draft {{period}}\n\n{{digest}}");
  t.as("member");
  await t.click('[data-retro="preview"]');
  expect(t.controller.state().draft).toBeNull();
  expect(t.text()).not.toContain("Another draft");
  expect(t.text()).toContain("Only workspace admins can preview retro prompts.");
});

test("a report shows the prompt and profile its retro froze", async () => {
  const w = await world();
  const handle = createRetroPreviewHttp({ store: sqliteDb(w.db), artifactRoot: w.root });
  const controller = createRetroSettings({
    fetch: async (url: string) =>
      (await handle(new Request(String(url)), w.people.admin!, ALL)) ??
      new Response(null, { status: 404 }),
    paint: (root: El, html: string) => {
      root.innerHTML = html;
    },
  });
  const page = window.document.createElement("div");
  window.document.body.append(page);
  page.innerHTML = '<div data-retro-frozen="r1"></div>';
  controller.attach(page, "http://127.0.0.1:8787", "ws:user-admin");
  expect(page.textContent).toContain("Loading the settings");
  await settle();
  expect(page.textContent).toContain("Settings this retro ran with");
  expect(page.textContent).toContain("Settings revision1");
  expect(page.textContent).toContain("Review {{period}}.");
  expect(page.textContent).toContain("15 active minutes, 1 retries");
});
