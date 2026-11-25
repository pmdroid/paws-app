import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { fullStatusFixture, issueList, mergeQueueOf } from "../../test/fixtures";
import { setSettingsAdmin } from "./settings-pages";
import { settleReactWork } from "./settle-react";

beforeEach(() => setSettingsAdmin(true));

const saved = new Map<string, unknown>();

afterEach(async () => {
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const [key, value] of saved) Reflect.set(globalThis, key, value);
  saved.clear();
});

function installWindow(): Window {
  const window = new Window({ url: "http://localhost/dashboard" });
  for (const key of [...Object.getOwnPropertyNames(window), "window", "IS_REACT_ACT_ENVIRONMENT"]) {
    if (["undefined", "globalThis", "Infinity", "NaN", "console"].includes(key)) continue;
    if (!saved.has(key)) saved.set(key, Reflect.get(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(window, key);
    Reflect.set(
      globalThis,
      key,
      typeof value === "function" && /^[a-z]/.test(key) ? value.bind(window) : value,
    );
  }
  return window;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function fakeFetch(): string[] {
  const full = fullStatusFixture();
  const bodies: Record<string, unknown> = {
    "/api/issues": issueList(full),
    "/api/merge-queue": mergeQueueOf(full),
  };
  const requests: string[] = [];
  Reflect.set(globalThis, "fetch", async (path: string) => {
    requests.push(path);
    return { ok: true, json: async () => JSON.parse(JSON.stringify(bodies[path])) };
  });
  return requests;
}

async function mountPalette(window: Window) {
  const container = window.document.createElement("div");
  const content = window.document.createElement("main");
  content.id = "content";
  content.tabIndex = -1;
  window.document.body.append(container, content);
  const root = createRoot(container as unknown as HTMLElement);
  const paths: string[] = [];
  const { CommandPalette } = await import("./command-palette");
  await act(async () => root.render(<CommandPalette onNavigate={(path) => paths.push(path)} />));
  const press = async (target: unknown, key: string, ctrlKey = false) => {
    const event = new window.KeyboardEvent("keydown", {
      key,
      ctrlKey,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      (target as EventTarget).dispatchEvent(event as unknown as Event);
      await settle();
    });
    return event;
  };
  return { container, content, root, paths, press };
}

test("a page name matches its item and a typed issue id comes first", async () => {
  installWindow();
  const { paletteItems } = await import("./command-palette");
  expect(paletteItems("merge queue").map((item) => [item.group, item.title, item.path])).toEqual([
    ["Pages", "Merge queue", "/merge-queue"],
  ]);
  const [first] = paletteItems("pas-7");
  expect(first).toEqual({
    group: "Issues",
    title: "Open issue",
    path: "/issues/PAS-7",
    issue: "PAS-7",
  });
  expect(paletteItems("").some((item) => item.issue)).toBe(false);
});

test("settings pages open in Settings and workspace pages in Workspace, for admins only", async () => {
  installWindow();
  const { paletteItems } = await import("./command-palette");
  const pages = () =>
    paletteItems("")
      .filter((item) => /^(Settings|Workspace) · /.test(item.title))
      .map((item) => [item.title, item.path]);
  expect(pages()).toContainEqual(["Settings · Your account", "/settings/account"]);
  expect(pages()).toContainEqual(["Settings · Agent accounts", "/settings/agent-accounts"]);
  expect(pages()).toContainEqual(["Workspace · Merging", "/workspace/merging"]);
  expect(pages()).toContainEqual(["Workspace · Member VMs", "/workspace/member-vm"]);
  for (const [title, path] of pages())
    expect(path!.startsWith(title!.startsWith("Workspace") ? "/workspace/" : "/settings/")).toBe(
      true,
    );
  setSettingsAdmin(false);
  expect(pages()).toEqual([
    ["Settings · Your account", "/settings/account"],
    ["Settings · Agent accounts", "/settings/agent-accounts"],
  ]);
});

test("Ctrl K opens the palette, Down then Enter opens the second item and Escape closes", async () => {
  const window = installWindow();
  const requests = fakeFetch();
  const { paletteItems } = await import("./command-palette");
  const { container, content, root, paths, press } = await mountPalette(window);
  expect(requests).toEqual([]);
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toContain("Ctrl K");

  const dialog = () => window.document.querySelector('[role="dialog"]');
  const combobox = () =>
    window.document.querySelector('input[role="combobox"]') as unknown as HTMLInputElement;

  expect((await press(window, "k", true)).defaultPrevented).toBe(true);
  const title = dialog()?.getAttribute("aria-labelledby");
  expect(title ? window.document.getElementById(title)?.textContent : null).toBe("Jump to");
  const input = combobox();
  expect(input.getAttribute("placeholder")).toBe(
    "Search pages, settings, issues and pull requests…",
  );
  expect(requests).toEqual(["/api/issues", "/api/merge-queue"]);
  const options = window.document.querySelectorAll('[role="option"]');
  expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);

  const scrolled: string[] = [];
  for (const option of options)
    Reflect.set(option, "scrollIntoView", () => scrolled.push(option.id));
  await press(input, "ArrowDown");
  expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
  expect(scrolled).toEqual([options[1]!.id]);
  await press(input, "Enter");
  expect(paths).toEqual([paletteItems("")[1]!.path]);
  expect(dialog()).toBeNull();
  expect(window.document.activeElement).toBe(content);

  await act(async () => {
    trigger.click();
    await settle();
  });
  expect(dialog()).not.toBeNull();
  await press(combobox(), "Escape");
  expect(dialog()).toBeNull();
  expect(window.document.activeElement).toBe(trigger);

  const field = window.document.createElement("input");
  window.document.body.append(field);
  field.focus();
  await press(field, "k", true);
  expect(dialog()).not.toBeNull();
  await press(combobox(), "Escape");
  expect(dialog()).toBeNull();
  expect(paths).toHaveLength(1);
  expect(window.document.activeElement).toBe(trigger);
  await act(async () => root.unmount());
});

test("a query shows grouped settings, issue and PR rows, and arrows then Enter open the chosen one", async () => {
  const window = installWindow();
  const requests = fakeFetch();
  const { root, paths, press } = await mountPalette(window);
  await press(window, "k", true);
  const combobox = () => window.document.querySelector('input[role="combobox"]')!;
  const input = combobox();
  const type = async (value: string) => {
    const field = combobox();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
      setter.call(field, value);
      field.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }) as never);
      await settle();
    });
  };
  const rows = () =>
    [...window.document.querySelectorAll('[role="listbox"] > li')].map((row) =>
      row.getAttribute("role") === "option" ? row.textContent : `[${row.textContent}]`,
    );

  await type("audit");
  expect(rows()).toEqual([
    "[Settings]",
    "Workspace · Audit history",
    "[Issues]",
    "ENG-104Admin export UIQueued",
    "ENG-103Signed URL deliveryAwaiting input",
    "ENG-101Export job workerIn merge queue",
    "ENG-100Retention policy enforcement jobAwaiting input",
    "ENG-99Audit event schema v2Merged",
    "[PRs]",
    "#474 Audit event schema v2acme/platform",
  ]);
  await type("acme/platform");
  expect(rows()).toEqual([
    "[PRs]",
    "#479 Export job workeracme/platform",
    "#474 Audit event schema v2acme/platform",
  ]);
  await type("#479");
  expect(rows()).toEqual(["[PRs]", "#479 Export job workeracme/platform"]);

  await type("audit");
  for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp"])
    await press(input, key);
  await press(input, "Enter");
  expect(paths).toEqual(["/issues/ENG-99"]);

  await press(window, "k", true);
  await type("zzz no match");
  expect(rows()).toEqual(["[No settings, issues or pull requests match.]"]);
  expect(requests).toEqual(["/api/issues", "/api/merge-queue", "/api/issues", "/api/merge-queue"]);
  await act(async () => root.unmount());
});
