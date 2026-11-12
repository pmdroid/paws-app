import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "theme.css"), "utf8");

function tokens(selector: string): Map<string, string> {
  const match = new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "m").exec(css);
  if (!match?.[1]) throw new Error(`no ${selector} block in theme.css`);
  const values = new Map<string, string>();
  for (const [, name, value] of match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (name && value) values.set(name, value.trim());
  }
  return values;
}

function hex(value: string | undefined): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value ?? "");
  if (!match?.[1]) throw new Error(`not a six-digit hex color: ${value}`);
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(color: string | undefined): number {
  const [r, g, b] = hex(color).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string | undefined, b: string | undefined): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const STATES = ["running", "verifying", "awaiting", "ok", "failed", "recovering", "live", "warn"];

for (const [theme, selector] of [
  ["light", ":root"],
  ["dark", ".dark"],
] as const) {
  describe(`${theme} theme tokens`, () => {
    const values = tokens(selector);
    const text = [
      "--foreground",
      "--muted-foreground",
      "--subtle-foreground",
      ...STATES.map((state) => `--state-${state}`),
    ];

    for (const surface of ["--background", "--secondary-background"]) {
      for (const name of text) {
        test(`${name} on ${surface} reaches 4.5:1`, () => {
          expect(contrast(values.get(name), values.get(surface))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    test("--main-foreground on --main reaches 4.5:1", () => {
      expect(
        contrast(values.get("--main-foreground"), values.get("--main")),
      ).toBeGreaterThanOrEqual(4.5);
    });
  });
}
