import { describe, expect, test } from "bun:test";
import { isOneMillionModel, modelLabel, standardModelId } from "./models";

describe("model labels", () => {
  const catalog = [
    { id: "sonnet", name: "Sonnet 5.5" },
    { id: "opus", name: "Opus 5.5" },
    { id: "opus[1m]", name: "Opus (1M context)" },
  ];

  test("a [1m] entry is labelled with its standard model's name", () => {
    expect(modelLabel(catalog[2]!, catalog)).toBe("Opus 5.5 · 1M context");
    expect(isOneMillionModel(catalog[2]!)).toBe(true);
    expect(standardModelId("opus[1m]")).toBe("opus");
  });

  test("standard entries keep their name", () => {
    expect(catalog.slice(0, 2).map((model) => modelLabel(model, catalog))).toEqual([
      "Sonnet 5.5",
      "Opus 5.5",
    ]);
    expect(isOneMillionModel(catalog[1]!)).toBe(false);
    expect(standardModelId("opus")).toBeNull();
  });

  test("a (1M context) name or description counts too", () => {
    const described = { id: "claude-opus-5-5-long", name: "Opus 5.5", description: "(1M context)" };
    expect(isOneMillionModel(described)).toBe(true);
    expect(modelLabel(described, [...catalog, described])).toBe("Opus 5.5 · 1M context");
    const named = { id: "claude-sonnet-5-5-long", name: "Sonnet 5.5 (1M context)" };
    expect(modelLabel(named)).toBe("Sonnet 5.5 · 1M context");
  });

  test("a lone [1m] entry falls back to its own name", () => {
    expect(modelLabel({ id: "opus[1m]", name: "Opus" })).toBe("Opus · 1M context");
  });
});
