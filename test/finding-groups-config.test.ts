import { expect, test } from "bun:test";
import { parseConfigToml } from "../src/config";

test("grouping_time accepts a UTC HH:MM and rejects malformed or unknown settings", () => {
  expect(parseConfigToml('[findings]\ngrouping_time = "23:59"').findingsGroupingTime).toBe("23:59");
  expect(parseConfigToml("").findingsGroupingTime).toBeUndefined();
  for (const time of ["24:00", "06:60", "6:00", "06:00 UTC"])
    expect(() => parseConfigToml(`[findings]\ngrouping_time = "${time}"`)).toThrow("HH:MM UTC");
  expect(() => parseConfigToml("[findings]\nautomatic_filing = true")).toThrow();
});
