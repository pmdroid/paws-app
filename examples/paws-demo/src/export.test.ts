import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportRows } from "./export";

/**
 * The paws checkout runs `bun test` from a package named `paws`. This seeded
 * failure is the demo's fix loop, so it stays skipped there. Closeout and
 * `bun test` inside paws-demo use this package, and the test runs.
 */
function embeddedInPawsCheckout(): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === "paws";
  } catch {
    return false;
  }
}

test.skipIf(embeddedInPawsCheckout())("exportRows writes one id,name line per row", () => {
  expect(
    exportRows([
      { id: "1", name: "Ada", archived: false },
      { id: "2", name: "Grace", archived: true },
    ]),
  ).toBe("1,Ada\n2,Grace\n");
});
