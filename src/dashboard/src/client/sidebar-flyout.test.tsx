import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import type { Route } from "./route";
import { setSettingsAdmin, WORKSPACE_PAGES } from "./settings-pages";
import { settleReactWork } from "./settle-react";

const saved = new Map<string, unknown>();
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  await settleReactWork();
  for (const [key, value] of saved) Reflect.set(globalThis, key, value);
  saved.clear();
  setSettingsAdmin(false);
});

function installWindow(hover: boolean): Window {
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
  Reflect.set(globalThis, "matchMedia", (query: string) => ({
    matches: hover && query === "(hover: hover)",
  }));
  return window;
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function sidebar({
  hover = true,
  flyout = true,
  route = { view: "issues", id: null } as Route,
} = {}) {
  const window = installWindow(hover);
  setSettingsAdmin(true);
  const { Navigation } = await import("./shell");
  const paths: string[] = [];
  function Path() {
    paths.push(useLocation().pathname);
    return null;
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={["/issues"]}>
        <Navigation route={route} counts={{}} flyout={flyout} />
        <Path />
      </MemoryRouter>,
    ),
  );
  const item = (name: string) =>
    [...container.querySelectorAll("a")].find((link) => link.textContent === name)!;
  const menu = (name: string) => container.querySelector(`[role="menu"][aria-label="${name}"]`);
  const pointer = (target: Element, type: "pointerover" | "pointerout", related?: Element) =>
    act(() => {
      target.dispatchEvent(
        new window.PointerEvent(type, {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: related ?? window.document.body,
        }) as unknown as Event,
      );
    });
  const key = (target: Element, name: string, shiftKey = false) =>
    act(() => {
      target.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: name,
          bubbles: true,
          cancelable: true,
          shiftKey,
        }) as unknown as Event,
      );
    });
  const focused = () => window.document.activeElement;
  return { window, container, item, menu, pointer, key, focused, paths };
}

test("hovering Workspace opens its pages after a delay and clicking one opens it", async () => {
  const { item, menu, pointer, paths } = await sidebar();
  const workspace = item("Workspace");
  expect(workspace.getAttribute("aria-haspopup")).toBe("menu");
  expect(workspace.getAttribute("aria-expanded")).toBe("false");
  await pointer(workspace, "pointerover");
  await wait(50);
  expect(menu("Workspace pages")).toBeNull();
  await wait(100);
  const panel = menu("Workspace pages")!;
  expect(workspace.getAttribute("aria-expanded")).toBe("true");
  const entries = [...panel.querySelectorAll('[role="menuitem"]')];
  expect(entries.map((entry) => [entry.textContent, entry.getAttribute("href")])).toEqual(
    WORKSPACE_PAGES.map((page) => [page.name, `/workspace/${page.id}`]),
  );
  await pointer(workspace, "pointerout");
  await wait(100);
  await pointer(panel, "pointerover");
  await wait(300);
  expect(menu("Workspace pages")).not.toBeNull();
  await act(() => (entries[1] as HTMLElement).click());
  expect(paths.at(-1)).toBe(`/workspace/${WORKSPACE_PAGES[1]!.id}`);
  expect(menu("Workspace pages")).toBeNull();
});

test("the panel closes once the pointer has left the item and the panel", async () => {
  const { item, menu, pointer } = await sidebar();
  await pointer(item("Settings"), "pointerover");
  await wait(150);
  expect(menu("Settings pages")).not.toBeNull();
  await pointer(item("Settings"), "pointerout");
  await wait(150);
  expect(menu("Settings pages")).not.toBeNull();
  await wait(150);
  expect(menu("Settings pages")).toBeNull();
});

test("Right arrow opens Settings on its first entry, Down moves and Escape returns", async () => {
  const { item, menu, key, focused, paths } = await sidebar();
  const settings = item("Settings");
  await act(() => settings.focus());
  await key(settings, "ArrowRight");
  const entries = [...menu("Settings pages")!.querySelectorAll('[role="menuitem"]')];
  expect(entries.map((entry) => entry.textContent)).toEqual(["Your account", "Agent accounts"]);
  expect(focused()).toBe(entries[0]!);
  await key(entries[0]!, "ArrowDown");
  expect(focused()).toBe(entries[1]!);
  await key(entries[1]!, "ArrowDown");
  expect(focused()).toBe(entries[0]!);
  await key(entries[0]!, "ArrowUp");
  expect(focused()).toBe(entries[1]!);
  await key(entries[1]!, "Escape");
  expect(menu("Settings pages")).toBeNull();
  expect(focused()).toBe(settings);
  await key(settings, "Enter");
  expect(paths.at(-1)).toBe("/issues");
  expect(focused()?.textContent).toBe("Your account");
  await key(focused()!, "ArrowLeft");
  expect(menu("Settings pages")).toBeNull();
  expect(focused()).toBe(settings);
});

test("focus leaving the item and its panel closes the panel", async () => {
  const { item, menu, key, focused } = await sidebar();
  const workspace = item("Workspace");
  await act(() => workspace.focus());
  await key(workspace, "ArrowRight");
  expect(menu("Workspace pages")).not.toBeNull();
  await act(() => item("Settings").focus());
  expect(menu("Workspace pages")).toBeNull();
  expect(focused()).toBe(item("Settings"));
});

test("no flyout on the active route, without hover, or in the mobile sheet", async () => {
  for (const options of [
    { route: { view: "workspace", page: "merging" } as Route },
    { hover: false },
    { flyout: false },
  ]) {
    const { item, menu, pointer, key } = await sidebar(options);
    const workspace = item("Workspace");
    expect(workspace.getAttribute("aria-haspopup")).toBeNull();
    await pointer(workspace, "pointerover");
    await key(workspace, "ArrowRight");
    await wait(150);
    expect(menu("Workspace pages")).toBeNull();
    await act(async () => root?.unmount());
    root = null;
  }
});
