import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, type AgentInputFile } from "../acp";
import type { LinearFileTransfer } from "../linear";
import { recordLinearInput } from "../db";

const MAX_BYTES = 20 * 1024 * 1024;
const INPUT_DIRECTORY = ".paws-linear-inputs";

type CachedInput = { filename: string; mimeType: string; sha256: string; data: string };

export function createLinearInputLoader(options: {
  db: Database;
  files: Pick<LinearFileTransfer, "download">;
  cacheDir: string;
}) {
  const inflight = new Map<string, Promise<CachedInput>>();
  return async (request: {
    workspace: string;
    prompt: string;
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
  }): Promise<{ prompt: string; inputFiles: AgentInputFile[] }> => {
    request.signal.throwIfAborted();
    if (!request.sessionId.trim() || !request.turnId.trim())
      throw new Error("Linear input files require a session and turn identity");
    const sources = inputSources(request.prompt);
    if (sources.size === 0) return { prompt: request.prompt, inputFiles: [] };
    if (sources.size > 20) throw new Error("Linear input files exceed the file limit");
    const workspace = await realpath(request.workspace);
    await guardDirectory(options.cacheDir);
    await excludeInputs(workspace);
    const directory = join(workspace, INPUT_DIRECTORY);
    await guardDirectory(directory);
    const turnDirectory = join(directory, digest(request.turnId));
    await guardDirectory(turnDirectory);
    const inputs: AgentInputFile[] = [];
    const replacements = new Map<string, string>();
    let total = 0;
    for (const [url, originals] of sources) {
      request.signal.throwIfAborted();
      const id = digest(url);
      let cached = inflight.get(id);
      if (!cached) {
        cached = load(id, url, request.signal).finally(() => inflight.delete(id));
        inflight.set(id, cached);
      }
      let file: CachedInput;
      try {
        file = await cached;
      } catch (error) {
        request.signal.throwIfAborted();
        if (
          error instanceof Error &&
          /^Linear file download HTTP (401|403|404)$/.test(error.message)
        )
          continue;
        throw error;
      }
      request.signal.throwIfAborted();
      const bytes = Buffer.from(file.data, "base64");
      total += bytes.byteLength;
      if (total > MAX_BYTES) throw new Error("Linear input files exceed the byte limit");
      const extension =
        file.filename.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? extensionFor(file.mimeType);
      const path = join(turnDirectory, `${id}${extension}`);
      await writeAtomic(path, bytes);
      request.signal.throwIfAborted();
      recordLinearInput(options.db, {
        sessionId: request.sessionId,
        turnId: request.turnId,
        assetId: id,
        assetUrl: url,
        mimeType: file.mimeType,
        size: bytes.byteLength,
        sha256: file.sha256,
      });
      inputs.push({ path, mimeType: file.mimeType, bytes: new Uint8Array(bytes) });
      const local = `./${INPUT_DIRECTORY}/${digest(request.turnId)}/${id}${extension}`;
      for (const original of originals) replacements.set(original, local);
    }
    const prompt = request.prompt.replace(
      /https:\/\/uploads\.linear\.app\/[^\s<>"'\\)\]]+/g,
      (url) => replacements.get(url) ?? url,
    );
    return { prompt, inputFiles: inputs };
  };

  async function load(id: string, url: string, signal: AbortSignal): Promise<CachedInput> {
    const path = join(options.cacheDir, `${id}.json`);
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES * 1.4 + 1024)
          throw new Error("Linear input cache is invalid");
        const cached: unknown = JSON.parse(await file.readFile("utf8"));
        return validateCache(cached);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    signal.throwIfAborted();
    const file = await options.files.download({ url, signal });
    signal.throwIfAborted();
    if (file.bytes.byteLength > MAX_BYTES)
      throw new Error("Linear input file exceeds the byte limit");
    const cached = validateCache({
      filename: file.filename,
      mimeType: file.contentType,
      sha256: digest(file.bytes),
      data: Buffer.from(file.bytes).toString("base64"),
    });
    await writeAtomic(path, Buffer.from(JSON.stringify(cached)));
    return cached;
  }
}

export function inputSources(prompt: string): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const match of prompt.matchAll(/https:\/\/uploads\.linear\.app\/[^\s<>"'\\)\]]+/g)) {
    const original = match[0];
    const url = new URL(original);
    if (
      url.origin !== "https://uploads.linear.app" ||
      url.username ||
      url.password ||
      url.pathname === "/"
    )
      continue;
    url.search = "";
    url.hash = "";
    const asset = url.href;
    sources.set(asset, [...(sources.get(asset) ?? []), original]);
  }
  return sources;
}

function validateCache(value: unknown): CachedInput {
  const file = value as Partial<CachedInput> | null;
  if (
    !file ||
    typeof file.filename !== "string" ||
    !file.filename.trim() ||
    file.filename.length > 255 ||
    [...file.filename].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        "/\\".includes(character),
    ) ||
    typeof file.mimeType !== "string" ||
    !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimeType) ||
    typeof file.data !== "string" ||
    file.data.length > MAX_BYTES * 1.4 ||
    typeof file.sha256 !== "string" ||
    digest(Buffer.from(file.data, "base64")) !== file.sha256
  ) {
    throw new Error("Linear input cache integrity check failed");
  }
  return file as CachedInput;
}

async function excludeInputs(workspace: string): Promise<void> {
  let info;
  try {
    info = await lstat(join(workspace, ".git"));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!info.isFile() && !info.isDirectory())
    throw new Error("Linear input workspace Git metadata is invalid");
  const exclude = (
    await git([
      "-C",
      workspace,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ])
  ).trim();
  await mkdir(dirname(exclude), { recursive: true });
  const file = await open(
    exclude,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await file.stat()).isFile()) throw new Error("Linear input Git exclusion is invalid");
    const current = await file.readFile("utf8");
    const rule = `/${INPUT_DIRECTORY}/`;
    if (!current.split("\n").includes(rule))
      await file.writeFile(`${current.endsWith("\n") ? "" : "\n"}${rule}\n`);
  } finally {
    await file.close();
  }
}

async function guardDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Linear input storage must be a controlled directory");
  await chmod(path, 0o700);
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
        throw error;
      const existing = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await existing.stat();
        if (
          !info.isFile() ||
          (info.mode & 0o077) !== 0 ||
          info.size !== bytes.byteLength ||
          digest(await existing.readFile()) !== digest(bytes)
        ) {
          throw new Error("Linear input destination already exists", { cause: error });
        }
      } finally {
        await existing.close();
      }
    }
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function extensionFor(mime: string): string {
  return (
    (
      {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "application/pdf": ".pdf",
        "text/plain": ".txt",
      } as Record<string, string>
    )[mime] ?? ".bin"
  );
}
