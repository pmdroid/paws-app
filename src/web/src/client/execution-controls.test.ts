import { afterEach, beforeEach, expect, test } from "bun:test";
import { createExecutionControls } from "./execution-controls";

const ORIGIN = "http://127.0.0.1:8787";
const realFetch = globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
let asked: string[] = [];
let answer: { available: boolean; itemId: string; actions: string[] };

beforeEach(() => {
  asked = [];
  answer = { available: true, itemId: "", actions: [] };
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: ORIGIN },
  });
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return Response.json(answer);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realLocation) Object.defineProperty(globalThis, "location", realLocation);
  else delete (globalThis as { location?: unknown }).location;
});

/** The controls only paint a visible root, so a hidden stand-in carries the item's data. */
function root(item: string, data: Record<string, string> = {}) {
  return { dataset: { item, ...data }, hidden: true } as unknown as HTMLElement;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("finished items are not asked about, and a cached no is asked again only for a new version", async () => {
  const controls = createExecutionControls(async () => {});
  const mount = (element: HTMLElement) => controls.mount(element, ORIGIN, "live");

  mount(root("merged", { version: "4", noControls: "" }));
  mount(root("cancelled", { version: "9", noControls: "" }));
  await settle();
  expect(asked).toEqual([]);

  mount(root("theirs", { version: "2" }));
  await settle();
  expect(asked).toEqual(["/api/execution-controls?itemId=theirs"]);
  mount(root("theirs", { version: "2" }));
  mount(root("other", { version: "1" }));
  await settle();
  mount(root("theirs", { version: "2" }));
  await settle();
  expect(asked).toEqual([
    "/api/execution-controls?itemId=theirs",
    "/api/execution-controls?itemId=other",
  ]);

  mount(root("theirs", { version: "3" }));
  await settle();
  expect(asked.at(-1)).toBe("/api/execution-controls?itemId=theirs");
  expect(asked).toHaveLength(3);
});

test("an item without a version, or whose controls are not ready, is asked on every mount", async () => {
  const controls = createExecutionControls(async () => {});
  const mount = (element: HTMLElement) => controls.mount(element, ORIGIN, "live");
  mount(root("unversioned"));
  await settle();
  mount(root("unversioned"));
  await settle();
  answer = { available: false, itemId: "starting", actions: [] };
  mount(root("starting", { version: "5" }));
  await settle();
  mount(root("starting", { version: "5" }));
  await settle();
  expect(asked).toEqual([
    "/api/execution-controls?itemId=unversioned",
    "/api/execution-controls?itemId=unversioned",
    "/api/execution-controls?itemId=starting",
    "/api/execution-controls?itemId=starting",
  ]);
});
