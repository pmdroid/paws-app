import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

const saved = new Map<string, unknown>();

afterEach(async () => {
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

test("a page name matches its item and a typed issue id comes first", async () => {
  installWindow();
  const { paletteItems } = await import("./command-palette");
  expect(paletteItems("merge").map((item) => [item.title, item.path])).toEqual([
    ["Merge queue", "/merge-queue"],
  ]);
  const [first] = paletteItems("pas-7");
  expect(first).toEqual({ title: "Open issue PAS-7", path: "/issues/PAS-7", issue: "PAS-7" });
  expect(paletteItems("").some((item) => item.issue)).toBe(false);
});

test("Ctrl K opens the palette, Down then Enter opens the second item and Escape closes", async () => {
  const window = installWindow();
  const { CommandPalette, paletteItems } = await import("./command-palette");
  const container = window.document.createElement("div");
  const content = window.document.createElement("main");
  content.id = "content";
  content.tabIndex = -1;
  window.document.body.append(container, content);
  const root = createRoot(container as unknown as HTMLElement);
  const paths: string[] = [];
  await act(async () => root.render(<CommandPalette onNavigate={(path) => paths.push(path)} />));
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toContain("Ctrl K");

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
  const dialog = () => window.document.querySelector('[role="dialog"]');
  const combobox = () =>
    window.document.querySelector('input[role="combobox"]') as unknown as HTMLInputElement;

  expect((await press(window, "k", true)).defaultPrevented).toBe(true);
  const title = dialog()?.getAttribute("aria-labelledby");
  expect(title ? window.document.getElementById(title)?.textContent : null).toBe("Jump to");
  const input = combobox();
  expect(input.getAttribute("placeholder")).toBe("Jump to a page or type an issue id…");
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
