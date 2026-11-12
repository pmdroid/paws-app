import { expect, test } from "bun:test";
import { nextAppearance, parseAppearance, resolveAppearance } from "./appearance";

test("appearance accepts explicit themes and safely defaults to the system", () => {
  expect(parseAppearance("light")).toBe("light");
  expect(parseAppearance("dark")).toBe("dark");
  for (const value of [null, "system", "invalid", ""])
    expect(parseAppearance(value)).toBe("system");
});

test("system appearance follows the device while explicit choices override it", () => {
  expect(resolveAppearance("system", false)).toBe("light");
  expect(resolveAppearance("system", true)).toBe("dark");
  expect(resolveAppearance("light", true)).toBe("light");
  expect(resolveAppearance("dark", false)).toBe("dark");
});

test("the theme toggle switches to the opposite of the resolved theme", () => {
  expect(nextAppearance("dark")).toBe("light");
  expect(nextAppearance("light")).toBe("dark");
});
