import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCheckpoint, git } from "../src/acp";
import { listLinearInputs } from "../src/db";
import { createLinearFileTransfer } from "../src/linear";
import { createLinearInputLoader, inputSources } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

const URL = "https://uploads.linear.app/workspace/asset.png";
const bytes = new Uint8Array([1, 2, 3]);

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), "paws-inputs-"));
  const db = tempDb();
  const cacheDir = join(tempHome(), "inputs");
  const requests: { url: string; authorization: string | null }[] = [];
  const files = createLinearFileTransfer({
    client: {
      async query() {
        throw new Error("no upload");
      },
    },
    auth: {
      async ensureFresh() {
        return "host-token-private";
      },
    },
    fetch: async (url, request) => {
      requests.push({
        url: String(url),
        authorization: new Headers(request?.headers).get("authorization"),
      });
      return new Response(bytes, { headers: { "content-type": "image/png" } });
    },
  });
  const loader = () => createLinearInputLoader({ db, files, cacheDir });
  const request = {
    workspace,
    sessionId: "session",
    turnId: "turn-1",
    signal: new AbortController().signal,
    prompt: `Current prompt ![design](${URL}?signature=expired)\nPrevious thread: <${URL}?signature=other>`,
  };
  return { workspace, db, cacheDir, requests, loader, request };
}

test("current and historical private assets share stable cache identity across signed URLs and replay", async () => {
  const env = await setup();
  const result = await env.loader()(env.request);
  expect(env.requests).toEqual([{ url: URL, authorization: "Bearer host-token-private" }]);
  expect(result.inputFiles).toHaveLength(1);
  expect(result.inputFiles[0]?.bytes).toEqual(bytes);
  expect(await readFile(result.inputFiles[0]!.path)).toEqual(Buffer.from(bytes));
  expect(result.prompt).not.toContain("uploads.linear.app");
  expect(result.prompt).not.toContain("signature");
  expect(listLinearInputs(env.db, "session", "turn-1")).toHaveLength(1);
  const replay = await env.loader()({
    ...env.request,
    turnId: "turn-2",
    prompt: `New prompt ${URL}?signature=new`,
  });
  expect(env.requests).toHaveLength(1);
  expect(replay.inputFiles[0]?.path).not.toBe(result.inputFiles[0]?.path);
  expect(listLinearInputs(env.db, "session", "turn-2")[0]?.assetId).toBe(
    listLinearInputs(env.db, "session", "turn-1")[0]?.assetId,
  );
  expect(JSON.stringify(listLinearInputs(env.db, "session", "turn-2"))).not.toContain("signature");
  for (const filename of await readdir(env.cacheDir))
    expect((await stat(join(env.cacheDir, filename))).mode & 0o777).toBe(0o600);
  env.db.close();
});

test("private local inputs stay outside Git checkpoints", async () => {
  const env = await setup();
  await git(["-C", env.workspace, "init", "-q"]);
  await git([
    "-C",
    env.workspace,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  await env.loader()(env.request);
  await writeFile(join(env.workspace, "result.txt"), "result");
  expect((await commitCheckpoint(env.workspace)).committed).toBe(true);
  expect((await git(["-C", env.workspace, "ls-files"])).trim()).toBe("result.txt");
  env.db.close();
});

test("input materialization refuses symlink directories and existing symlink destinations", async () => {
  const env = await setup();
  const outside = tempHome();
  await symlink(outside, join(env.workspace, ".paws-linear-inputs"));
  await expect(env.loader()(env.request)).rejects.toThrow("controlled directory");
  expect(env.requests).toHaveLength(0);
  await rm(join(env.workspace, ".paws-linear-inputs"));
  const result = await env.loader()(env.request);
  const victim = join(outside, "victim");
  await writeFile(victim, "unchanged");
  await rm(result.inputFiles[0]!.path);
  await symlink(victim, result.inputFiles[0]!.path);
  await expect(env.loader()(env.request)).rejects.toThrow();
  expect(await readFile(victim, "utf8")).toBe("unchanged");
  env.db.close();
});

test("invalid cache bytes fail closed without another download", async () => {
  const env = await setup();
  await env.loader()(env.request);
  const filename = (await readdir(env.cacheDir))[0]!;
  await writeFile(
    join(env.cacheDir, filename),
    JSON.stringify({ filename: "proof.png", mimeType: "image/png", sha256: "bad", data: "AQID" }),
  );
  await chmod(join(env.cacheDir, filename), 0o600);
  await expect(env.loader()(env.request)).rejects.toThrow("integrity");
  expect(env.requests).toHaveLength(1);
  env.db.close();
});

test("foreign URLs, excessive files, and canceled turns cannot acquire host credentials", async () => {
  const env = await setup();
  expect(
    inputSources(
      "https://uploads.linear.app.evil/file https://evil.test/file http://uploads.linear.app/file",
    ).size,
  ).toBe(0);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(env.loader()({ ...env.request, signal: cancelled.signal })).rejects.toThrow();
  await expect(
    env.loader()({
      ...env.request,
      prompt: Array.from({ length: 21 }, (_, i) => `${URL}/${i}`).join(" "),
    }),
  ).rejects.toThrow("file limit");
  expect(env.requests).toHaveLength(0);
  env.db.close();
});
