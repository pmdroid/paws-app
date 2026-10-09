import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CloseoutInstallError } from "./errors";
import {
  closeoutAssetUrl,
  closeoutPlatform,
  loadCloseoutManifest,
  parseCloseoutManifest,
  requireAsset,
  type CloseoutManifest,
  type CloseoutPlatform,
} from "./manifest";
import { sameSha256, sha256Hex } from "./sha256";

const DEFAULT_MAX_BYTES = 80 * 1024 * 1024;

export type InstallCloseoutOptions = {
  /** Absolute `~/.paws` directory. The binary is written to `bin/closeout`. */
  home: string;
  platform?: CloseoutPlatform;
  manifest?: CloseoutManifest;
  manifestPath?: string;
  /**
   * Replaces `https://github.com/<repo>/releases/download`.
   * Tests point this at a local fake server. Production omits it.
   */
  releaseBaseUrl?: string;
  /**
   * `--offline` for the setup wizard: copy this absolute file instead of downloading.
   * The bytes still have to match the manifest SHA-256.
   */
  offlineFile?: string;
  fetch?: CloseoutFetch;
  maxBytes?: number;
  signal?: AbortSignal;
};

/** Enough of `fetch` for the release download. Tests pass a fake. */
export type CloseoutFetch = (
  input: string,
  init?: {
    redirect?: "error" | "follow" | "manual";
    signal?: AbortSignal;
    headers?: Record<string, string>;
  },
) => Promise<Response>;

export type CloseoutInstallResult = {
  path: string;
  version: string;
  platform: CloseoutPlatform;
  sha256: string;
  changed: boolean;
};

export function closeoutBinPath(home: string): string {
  return join(home, "bin", "closeout");
}

/**
 * Install the pinned closeout binary into `~/.paws/bin/closeout`.
 * A matching file is left untouched. A checksum mismatch deletes nothing
 * that was already installed.
 */
export async function installCloseout(
  options: InstallCloseoutOptions,
): Promise<CloseoutInstallResult> {
  if (!isAbsolute(options.home)) {
    throw new CloseoutInstallError("home must be an absolute path", "io");
  }
  const manifest = options.manifest
    ? parseCloseoutManifest(options.manifest)
    : loadCloseoutManifest(options.manifestPath);
  const platform = options.platform ?? closeoutPlatform();
  const asset = requireAsset(manifest, platform);
  const dest = closeoutBinPath(options.home);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const existing = await inspectInstalled(dest, asset.sha256);
  if (existing.state === "ready") {
    return {
      path: dest,
      version: manifest.version,
      platform,
      sha256: asset.sha256,
      changed: existing.changed,
    };
  }

  const bytes = options.offlineFile
    ? await readOffline(options.offlineFile, maxBytes)
    : await downloadAsset(manifest, platform, options, maxBytes);
  const actual = sha256Hex(bytes);
  if (!sameSha256(actual, asset.sha256)) {
    throw new CloseoutInstallError(
      `closeout ${platform} checksum mismatch: expected ${asset.sha256}, got ${actual}`,
      "checksum",
    );
  }
  await placeBinary(dest, bytes);
  return {
    path: dest,
    version: manifest.version,
    platform,
    sha256: actual,
    changed: true,
  };
}

async function inspectInstalled(
  dest: string,
  expected: string,
): Promise<{ state: "absent" | "different" } | { state: "ready"; changed: boolean }> {
  let info;
  try {
    info = await stat(dest);
  } catch (error) {
    if (isEnoent(error)) return { state: "absent" };
    throw error;
  }
  if (!info.isFile()) {
    throw new CloseoutInstallError("closeout destination exists and is not a file", "io");
  }
  const actual = sha256Hex(await readFile(dest));
  if (!sameSha256(actual, expected)) return { state: "different" };
  if ((info.mode & 0o111) === 0) {
    await chmod(dest, 0o755);
    return { state: "ready", changed: true };
  }
  return { state: "ready", changed: false };
}

async function readOffline(file: string, maxBytes: number): Promise<Uint8Array> {
  if (!isAbsolute(file)) {
    throw new CloseoutInstallError("offline file must be an absolute path", "offline");
  }
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (isEnoent(error)) {
      throw new CloseoutInstallError("offline closeout file was not found", "offline");
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new CloseoutInstallError("offline closeout path is not a file", "offline");
  }
  if (info.size > maxBytes) {
    throw new CloseoutInstallError("offline closeout file is too large", "offline");
  }
  return readFile(file);
}

async function downloadAsset(
  manifest: CloseoutManifest,
  platform: CloseoutPlatform,
  options: InstallCloseoutOptions,
  maxBytes: number,
): Promise<Uint8Array> {
  const asset = requireAsset(manifest, platform);
  const rawUrl = closeoutAssetUrl(manifest, platform, options.releaseBaseUrl);
  assertDownloadUrl(rawUrl);
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(rawUrl, {
      redirect: "follow",
      signal: options.signal,
      headers: {
        accept: "application/octet-stream",
        "user-agent": "paws-closeout-install",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    throw new CloseoutInstallError(`closeout ${platform} download failed: ${detail}`, "http");
  }
  if (response.url) assertDownloadUrl(response.url);
  if (response.status === 404) {
    await response.body?.cancel();
    throw new CloseoutInstallError(
      `closeout ${platform} asset ${asset.filename} is not in the ${manifest.tag} release`,
      "http",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CloseoutInstallError(
      `closeout ${platform} download failed with HTTP ${response.status}`,
      "http",
    );
  }
  return readLimited(response, maxBytes, platform);
}

async function readLimited(
  response: Response,
  maxBytes: number,
  platform: CloseoutPlatform,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isInteger(size) || size < 0 || size > maxBytes) {
      await response.body?.cancel();
      throw new CloseoutInstallError(
        `closeout ${platform} download is larger than ${maxBytes} bytes`,
        "http",
      );
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new CloseoutInstallError(`closeout ${platform} download had no body`, "http");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CloseoutInstallError(
        `closeout ${platform} download is larger than ${maxBytes} bytes`,
        "http",
      );
    }
    chunks.push(next.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function placeBinary(dest: string, bytes: Uint8Array): Promise<void> {
  const dir = dirname(dest);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = join(dir, `.closeout-${randomBytes(8).toString("hex")}.download`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function assertDownloadUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloseoutInstallError("closeout download URL is invalid", "http");
  }
  if (url.username || url.password) {
    throw new CloseoutInstallError("closeout download URL must not include credentials", "http");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return;
  throw new CloseoutInstallError("closeout download URL must be https", "http");
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
