import { describe, expect, test } from "bun:test";
import { setJournalSink } from "../../journal";
import policySchema from "../schema/policy.schema.json" with { type: "json" };
import { recheckDigest } from "./canonical";
import { createPolicyParser, parsePolicy } from "./document";
import { createFakeGitReader } from "./git";
import { policyKeys } from "./keys";
import { loadPolicy } from "./load";
import { loadMemoryPolicy, PUBLIC_POLICY_PATH } from "./resolve";

const CI_POLICY = `specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test"]
    timeoutSeconds: 600
    ci: "test (*)"
`;

/** The parser of a runner from before `ci` and `recheck`: the 0.1.48 schema. */
function olderParser() {
  const schema = structuredClone(policySchema) as {
    $defs: Record<string, { properties: Record<string, unknown> }>;
  };
  for (const name of ["command", "review", "evidence", "rule"]) {
    delete schema.$defs[name]!.properties.recheck;
    delete schema.$defs[name]!.properties.ci;
  }
  return createPolicyParser(schema);
}

function policyWith(items: string): Map<string, Uint8Array> {
  return new Map([
    [PUBLIC_POLICY_PATH, new TextEncoder().encode(`specVersion: "0.1"\nitems:\n${items}`)],
  ]);
}

function command(id: string, extra = ""): string {
  return `  - id: ${id}\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 30\n${extra}`;
}

function digestOf(files: Map<string, Uint8Array>): { digest: string; recheck: string } {
  const loaded = loadMemoryPolicy(files);
  if (!loaded.ok || loaded.absent) throw new Error("expected a policy");
  return { digest: loaded.policy.digest, recheck: recheckDigest(loaded.policy) };
}

describe("policy keys a parser does not know", () => {
  test("a policy with an unknown key validates with a warning on an older parser", () => {
    const older = olderParser()(CI_POLICY);
    expect(older).toMatchObject({ ok: true, unknownKeys: ["/items/0/ci"] });
    if (older.ok) expect(older.document.items?.[0]).not.toHaveProperty("ci");
    // The current parser knows `ci` and keeps it.
    expect(parsePolicy(CI_POLICY)).toMatchObject({
      ok: true,
      unknownKeys: [],
      document: { items: [{ id: "test", ci: "test (*)" }] },
    });
  });

  test("the keys an older parser knows are still validated strictly", () => {
    expect(olderParser()(CI_POLICY.replace("timeoutSeconds: 600", "timeoutSeconds: soon"))).toEqual(
      { ok: false, message: "/items/0/timeoutSeconds must be integer" },
    );
    expect(olderParser()(`specVersion: "0.2"\nlater: true\n`)).toMatchObject({ ok: false });
  });

  test("an unknown key is journaled once per policy digest", () => {
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      const files = policyWith(command("lint", "    someday: true\n"));
      const git = createFakeGitReader(
        Object.fromEntries(
          [...files].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]),
        ),
      );
      for (let run = 0; run < 3; run++) {
        const loaded = loadPolicy({ repo: "/nonexistent", git, env: {} });
        expect(loaded.ok && loaded.warnings.map((warning) => warning.code)).toEqual([
          "unknown-policy-keys",
        ]);
      }
      expect(lines.filter((line) => line.includes("/items/0/someday"))).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe("recheck digest", () => {
  test("is empty without a check marked `recheck: true`, and ignores the other checks", () => {
    const before = digestOf(policyWith(command("lint") + command("test")));
    expect(before.recheck).toBe("");
    const after = digestOf(
      policyWith(command("lint") + command("test").replace('"true"', '"false"')),
    );
    expect(after.digest).not.toBe(before.digest);
    expect(after.recheck).toBe("");
  });

  test("changes when a check marked `recheck: true` changes", () => {
    const marked = "    recheck: true\n";
    const before = digestOf(policyWith(command("lint") + command("test", marked)));
    expect(before.recheck).toMatch(/^sha256:[0-9a-f]{64}$/);
    const otherCheck = digestOf(
      policyWith(command("lint").replace("30", "60") + command("test", marked)),
    );
    expect(otherCheck.digest).not.toBe(before.digest);
    expect(otherCheck.recheck).toBe(before.recheck);
    const markedCheck = digestOf(
      policyWith(command("lint") + command("test", marked).replace("30", "60")),
    );
    expect(markedCheck.recheck).not.toBe(before.recheck);
  });
});

describe("policyKeys", () => {
  test("lists each key the entry and its imports write, as a schema path", () => {
    const files = new Map([
      [
        PUBLIC_POLICY_PATH,
        new TextEncoder().encode(
          `specVersion: "0.1"\nretry:\n  scope: task\nimports:\n  - path: .agents/shared.yaml\n    as: shared\nitems:\n${command("lint", '    ci: "lint"\n')}`,
        ),
      ],
      [
        ".agents/shared.yaml",
        new TextEncoder().encode(
          `specVersion: "0.1"\nitems:\n${command("test", "    recheck: true\n")}`,
        ),
      ],
    ]);
    expect(policyKeys(files)).toEqual([
      "imports",
      "imports[].as",
      "imports[].path",
      "items",
      "items[].ci",
      "items[].exec",
      "items[].gate",
      "items[].id",
      "items[].kind",
      "items[].recheck",
      "items[].timeoutSeconds",
      "retry",
      "retry.scope",
      "specVersion",
    ]);
  });
});
