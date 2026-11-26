import { expect, test } from "bun:test";
import { catalogModels, reviewerModelDeadEnd } from "./index";

const matches = "a: reviewer model matches implementation model";

test("only a reviewer model match on every usable runner is a dead end", () => {
  expect(reviewerModelDeadEnd([matches, "b: not-yours", "c: revoked"])).toBe(true);
  expect(reviewerModelDeadEnd([matches, "b: run pinned to another online runner"])).toBe(true);
  for (const waits of ["b: offline", "b: paused", "b: no free capacity (work 1 of 1)"])
    expect(reviewerModelDeadEnd([matches, waits])).toBe(false);
  expect(reviewerModelDeadEnd([])).toBe(false);
});

test("a runner offers its catalog's concrete models", () => {
  const catalog = { identity: { model: "a" }, models: [{ id: "default" }, { id: "b" }] };
  expect(catalogModels(JSON.stringify(catalog))).toEqual(["a", "b"]);
  expect(catalogModels(undefined)).toEqual([]);
});
