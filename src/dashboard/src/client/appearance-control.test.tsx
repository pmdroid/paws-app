import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AppearanceControl, initializeAppearance } from "./appearance";
import { settleReactWork } from "./settle-react";

const GLOBALS = ["window", "document", "localStorage", "HTMLElement", "Element", "Node"] as const;
const saved = Object.fromEntries(GLOBALS.map((key) => [key, Reflect.get(globalThis, key)]));

afterEach(async () => {
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 10));
  Object.assign(globalThis, saved);
});

test("the toggle shows the light switch in dark and stores light after a click", () => {
  const window = new Window({ url: "http://localhost/dashboard" });
  for (const key of GLOBALS) Reflect.set(globalThis, key, key === "window" ? window : window[key]);
  window.localStorage.setItem("paws.appearance", "dark");
  initializeAppearance();
  expect(window.document.documentElement.classList.contains("dark")).toBe(true);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  flushSync(() => root.render(<AppearanceControl />));
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Switch to light theme");
  expect(button.getAttribute("title")).toBe("Switch to light theme");
  flushSync(() => button.click());
  expect(window.localStorage.getItem("paws.appearance")).toBe("light");
  expect(window.document.documentElement.classList.contains("light")).toBe(true);
  expect(window.document.documentElement.classList.contains("dark")).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Switch to dark theme");
  flushSync(() => root.unmount());
});
