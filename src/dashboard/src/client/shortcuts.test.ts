import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createShortcuts, shortcutFor } from "./shortcuts";

const saved = new Map<string, unknown>();

afterEach(() => {
  for (const [key, value] of saved) Reflect.set(globalThis, key, value);
  saved.clear();
});

function installWindow(): Window {
  const window = new Window({ url: "http://localhost/dashboard" });
  for (const key of ["window", "document", "KeyboardEvent"]) {
    saved.set(key, Reflect.get(globalThis, key));
    Reflect.set(globalThis, key, key === "window" ? window : Reflect.get(window, key));
  }
  return window;
}

function press(
  window: Window,
  key: string,
  target: { dispatchEvent(event: never): unknown } = window,
) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }) as never);
}

function listen(window: Window) {
  const paths: string[] = [];
  let helped = 0;
  const shortcuts = createShortcuts({
    navigate: (path) => paths.push(path),
    openHelp: () => helped++,
  });
  return { paths, helped: () => helped, dispose: shortcuts.dispose, window };
}

test("a sequence names its page, ? names the help and an unknown key names nothing", () => {
  expect(shortcutFor("g i")).toEqual({ view: "issues", id: null });
  expect(shortcutFor("?")).toBe("help");
  expect(shortcutFor("g x")).toBeNull();
});

test("g then m within the window opens the merge queue and ? opens the help", () => {
  const window = installWindow();
  const { paths, helped, dispose } = listen(window);
  press(window, "g");
  press(window, "m");
  press(window, "?");
  expect(paths).toEqual(["/merge-queue"]);
  expect(helped()).toBe(1);
  dispose();
  press(window, "g");
  press(window, "i");
  expect(paths).toEqual(["/merge-queue"]);
});

test("g then m 1100 ms apart does not navigate", async () => {
  const window = installWindow();
  const { paths, dispose } = listen(window);
  press(window, "g");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  press(window, "m");
  expect(paths).toEqual([]);
  dispose();
});

test("g i while an input has focus does not navigate", () => {
  const window = installWindow();
  const { paths, dispose } = listen(window);
  const input = window.document.createElement("input");
  window.document.body.appendChild(input);
  input.focus();
  press(window, "g", input as never);
  press(window, "i", input as never);
  expect(paths).toEqual([]);
  dispose();
});

test("an open dialog or a modifier key stops a sequence", () => {
  const window = installWindow();
  const { paths, dispose } = listen(window);
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "g", metaKey: true }) as never);
  press(window, "i");
  const dialog = window.document.createElement("div");
  dialog.setAttribute("role", "dialog");
  window.document.body.appendChild(dialog);
  press(window, "g");
  press(window, "i");
  expect(paths).toEqual([]);
  dialog.remove();
  press(window, "g");
  press(window, "i");
  expect(paths).toEqual(["/issues"]);
  dispose();
});
