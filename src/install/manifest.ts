import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CloseoutInstallError } from "./errors";
import { sha256Text } from "./sha256";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

export type CloseoutPlatform = (typeof PLATFORMS)[number];

export const CLOSEOUT_PLATFORMS: readonly CloseoutPlatform[] = PLATFORMS;

export type CloseoutDigestKind = "file" | "unreleased-placeholder";

export type CloseoutAsset = {
  filename: string;
  target: string;
  sha256: string;
  digestKind: CloseoutDigestKind;
  /** Present only while the release asset is unpublished. Its UTF-8 SHA-256 is `sha256`. */
  digestPreimage?: string;
};

export type CloseoutManifest = {
  version: string;
  repository: string;
  tag: string;
  commit: string;
  distribution: "github-release";
  note?: string;
  assets: Record<CloseoutPlatform, CloseoutAsset>;
};

const MAX_MANIFEST_CHARS = 100_000;

export function defaultCloseoutManifestPath(): string {
  return join(import.meta.dir, "../../install/closeout-manifest.json");
}

export function closeoutPlatform(
  platform = process.platform,
  arch = process.arch,
): CloseoutPlatform {
  const key = `${platform}-${arch}`;
  if (isPlatform(key)) return key;
  throw new CloseoutInstallError(`closeout has no pinned binary for ${key}`, "platform");
}

export function closeoutAssetUrl(
  manifest: CloseoutManifest,
  platform: CloseoutPlatform,
  releaseBaseUrl?: string,
): string {
  const asset = requireAsset(manifest, platform);
  const base = (
    releaseBaseUrl ?? `https://github.com/${manifest.repository}/releases/download`
  ).replace(/\/+$/, "");
  return `${base}/${manifest.tag}/${asset.filename}`;
}

export function loadCloseoutManifest(
  path: string = defaultCloseoutManifestPath(),
): CloseoutManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new CloseoutInstallError(`closeout manifest could not be read: ${detail}`, "manifest");
  }
  if (text.length > MAX_MANIFEST_CHARS) {
    throw new CloseoutInstallError("closeout manifest is too large", "manifest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CloseoutInstallError("closeout manifest is not JSON", "manifest");
  }
  return parseCloseoutManifest(parsed);
}

export function parseCloseoutManifest(value: unknown): CloseoutManifest {
  if (!isRecord(value)) {
    throw new CloseoutInstallError("closeout manifest must be an object", "manifest");
  }
  const version = requiredString(value, "version");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new CloseoutInstallError("closeout manifest version is invalid", "manifest");
  }
  const repository = requiredString(value, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CloseoutInstallError("closeout manifest repository is invalid", "manifest");
  }
  const tag = requiredString(value, "tag");
  if (tag !== `v${version}`) {
    throw new CloseoutInstallError("closeout manifest tag does not match the version", "manifest");
  }
  const commit = requiredString(value, "commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new CloseoutInstallError("closeout manifest commit is invalid", "manifest");
  }
  if (value.distribution !== "github-release") {
    throw new CloseoutInstallError("closeout manifest distribution is invalid", "manifest");
  }
  const note = optionalString(value, "note");
  if (note !== undefined && note.length > 2_000) {
    throw new CloseoutInstallError("closeout manifest note is too long", "manifest");
  }
  if (!isRecord(value.assets)) {
    throw new CloseoutInstallError("closeout manifest assets are missing", "manifest");
  }
  const assets = {} as Record<CloseoutPlatform, CloseoutAsset>;
  for (const platform of CLOSEOUT_PLATFORMS) {
    assets[platform] = parseAsset(platform, value.assets[platform]);
  }
  for (const key of Object.keys(value.assets)) {
    if (!isPlatform(key)) {
      throw new CloseoutInstallError(
        `closeout manifest has an unknown platform ${key}`,
        "manifest",
      );
    }
  }
  return {
    version,
    repository,
    tag,
    commit,
    distribution: "github-release",
    ...(note !== undefined ? { note } : {}),
    assets,
  };
}

export function requireAsset(
  manifest: CloseoutManifest,
  platform: CloseoutPlatform,
): CloseoutAsset {
  const asset = manifest.assets[platform];
  if (!asset) {
    throw new CloseoutInstallError(`closeout manifest has no asset for ${platform}`, "manifest");
  }
  return asset;
}

function parseAsset(platform: CloseoutPlatform, value: unknown): CloseoutAsset {
  if (!isRecord(value)) {
    throw new CloseoutInstallError(`closeout manifest asset ${platform} is missing`, "manifest");
  }
  const filename = requiredString(value, "filename");
  if (filename !== `closeout-${platform}`) {
    throw new CloseoutInstallError(
      `closeout manifest filename for ${platform} must be closeout-${platform}`,
      "manifest",
    );
  }
  const target = requiredString(value, "target");
  if (!/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/.test(target)) {
    throw new CloseoutInstallError(
      `closeout manifest target for ${platform} is invalid`,
      "manifest",
    );
  }
  const sha256 = requiredString(value, "sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new CloseoutInstallError(
      `closeout manifest sha256 for ${platform} is invalid`,
      "manifest",
    );
  }
  const digestKind = requiredString(value, "digestKind");
  if (digestKind !== "file" && digestKind !== "unreleased-placeholder") {
    throw new CloseoutInstallError(
      `closeout manifest digestKind for ${platform} is invalid`,
      "manifest",
    );
  }
  const digestPreimage = optionalString(value, "digestPreimage");
  if (digestKind === "file" && digestPreimage !== undefined) {
    throw new CloseoutInstallError(
      `closeout manifest file digest for ${platform} must not include a preimage`,
      "manifest",
    );
  }
  if (digestKind === "unreleased-placeholder") {
    if (
      digestPreimage === undefined ||
      digestPreimage.length === 0 ||
      digestPreimage.length > 200
    ) {
      throw new CloseoutInstallError(
        `closeout manifest placeholder for ${platform} needs a digestPreimage`,
        "manifest",
      );
    }
    if (sha256Text(digestPreimage) !== sha256) {
      throw new CloseoutInstallError(
        `closeout manifest sha256 for ${platform} does not match digestPreimage`,
        "manifest",
      );
    }
  }
  return {
    filename,
    target,
    sha256,
    digestKind,
    ...(digestPreimage !== undefined ? { digestPreimage } : {}),
  };
}

function isPlatform(value: string): value is CloseoutPlatform {
  return (PLATFORMS as readonly string[]).includes(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CloseoutInstallError(`closeout manifest ${key} is missing`, "manifest");
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record) || record[key] === undefined) return undefined;
  const value = record[key];
  if (typeof value !== "string") {
    throw new CloseoutInstallError(`closeout manifest ${key} is invalid`, "manifest");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
