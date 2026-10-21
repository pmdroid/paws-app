import { expect, test } from "bun:test";
import { RunnerHealthResultSchema } from "./health";
import { labelModels, longContextModel } from "./models";

test("a catalog with opus[1m] labels it after its standard entry", () => {
  expect(
    labelModels([
      { id: "default", name: "Default (recommended)" },
      { id: "opus", name: "Opus 5.5" },
      { id: "opus[1m]", name: "Opus (1M context)" },
    ]).map(({ id, name, longContext }) => ({ id, name, longContext })),
  ).toEqual([
    { id: "default", name: "Default (recommended)", longContext: false },
    { id: "opus", name: "Opus 5.5", longContext: false },
    { id: "opus[1m]", name: "Opus 5.5 · 1M context", longContext: true },
  ]);
});

test("a (1M context) description counts as a 1M entry", () => {
  const [standard, long] = labelModels([
    { id: "claude-opus-5-5", name: "Opus 5.5", description: "Opus 5.5 for complex work" },
    { id: "claude-opus-5-5-1m", name: "Opus 5.5", description: "Opus 5.5 (1M context)" },
  ]);
  expect(standard).toMatchObject({ name: "Opus 5.5", longContext: false });
  expect(long).toMatchObject({ name: "Opus 5.5 · 1M context", longContext: true });
});

test("a 1M entry without a standard entry keeps its own name", () => {
  expect(labelModels([{ id: "sonnet[1m]", name: "Sonnet 5.5 (1M context)" }])[0]!.name).toBe(
    "Sonnet 5.5 · 1M context",
  );
  expect(longContextModel({ id: "haiku", name: "Haiku 5.5" })).toBe(false);
});

test("runner model lists keep each option's description", () => {
  const parsed = RunnerHealthResultSchema.shape.models.parse([
    { id: "opus[1m]", name: "Opus", description: "Opus 5.5 (1M context)" },
    { id: "opus", name: "Opus 5.5" },
  ]);
  expect(parsed?.[0]?.description).toBe("Opus 5.5 (1M context)");
});
