import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  moveCredentialGrants,
  readScopedCredentialSteps,
  scopedCredentialsSteps,
  writeSecretFile,
} from "../src/credentials";
import { readStoredToken } from "../src/linear";
import { tempStore } from "./pglite";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function seal(dir: string, context: string, value: string) {
  writeSecretFile(join(dir, context), value);
  return readFileSync(join(dir, context), "utf8");
}

async function setup() {
  const handle = await tempStore();
  const dir = mkdtempSync(join(tmpdir(), "paws-grants-"));
  cleanup.push(() => handle.close());
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = (kind: "linear" | "slack", workspace: string, value: string, context?: string) =>
    handle.db.run((q) =>
      q.exec(
        q.orm.insert(q.t.credential).values({
          kind,
          workspace,
          updatedAt: 1234,
          ciphertext: seal(dir, context ?? `credential:${kind}:${workspace}`, value),
        }),
      ),
    );
  const rows = () => handle.db.run((q) => q.all(q.orm.select().from(q.t.credential)));
  return { db: handle.db, dir, legacy, rows };
}

const linear = { accessToken: "marker-linear", refreshToken: "marker-refresh", expiresAtMs: 9 };

test("grants move from credential into secret under their own names", async () => {
  const { db, dir, legacy, rows } = await setup();
  await legacy("linear", "installation", JSON.stringify(linear));
  await legacy("slack", "W1", JSON.stringify({ accessToken: "marker-slack", teamId: "T1" }));
  await legacy("slack", "team:T1", "W1");

  expect(await moveCredentialGrants(db, dir)).toBe(3);
  expect(await readStoredToken(db, dir)).toMatchObject(linear);
  const slack = await db.run((q) => scopedCredentialsSteps(q, dir, "slack"));
  const moved = slack.map(({ workspace, version, updatedAt }) => [workspace, version, updatedAt]);
  expect(moved.sort()).toEqual([
    ["W1", 1, 1234],
    ["team:T1", 1, 1234],
  ]);
  const owner = { kind: "slack" as const, workspace: "team:T1" };
  expect((await db.run((q) => readScopedCredentialSteps(q, dir, owner)))?.value).toBe("W1");
  const names = await db.run((q) => q.all(q.orm.select().from(q.t.secret)));
  expect(names.map((row) => row.name).sort()).toEqual([
    "oauth-linear-installation",
    "oauth-slack-W1",
    "oauth-slack-team-T1",
  ]);
  expect(JSON.stringify(names)).not.toContain("marker-");
  expect(
    (await rows()).map(({ kind, workspace, ciphertext }) => [kind, workspace, ciphertext]),
  ).toEqual([
    ["linear", "installation", ""],
    ["slack", "W1", ""],
    ["slack", "team:T1", ""],
  ]);
  expect(await moveCredentialGrants(db, dir)).toBe(0);
});

test("a grant that cannot be moved stays in credential and the others still move", async () => {
  const { db, dir, legacy, rows } = await setup();
  await legacy("linear", "installation", JSON.stringify(linear), "credential:slack:installation");
  await legacy("slack", "installation", JSON.stringify({ accessToken: "marker-slack" }));

  expect(await moveCredentialGrants(db, dir)).toBe(1);
  expect(await readStoredToken(db, dir)).toBeNull();
  const kept = (await rows()).find((row) => row.kind === "linear")!;
  expect(kept.ciphertext).toStartWith("paws-envelope-v1\n");
  expect(await moveCredentialGrants(db, dir)).toBe(0);
  expect((await rows()).find((row) => row.kind === "linear")!.ciphertext).toBe(kept.ciphertext);
});
