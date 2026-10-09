import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { PINNED_CLOSEOUT_VERSION } from "../closeout";
import { CloseoutInstallError } from "./errors";
import {
  CLOSEOUT_PLATFORMS,
  closeoutAssetUrl,
  closeoutBinPath,
  closeoutPlatform,
  installCloseout,
  loadCloseoutManifest,
  sha256Hex,
  type CloseoutManifest,
  type CloseoutPlatform,
} from "./index";

const TARGETS: Record<CloseoutPlatform, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

test("checked-in manifest pins closeout 0.1.0 assets", () => {
  const manifest = loadCloseoutManifest();
  expect(manifest.version).toBe(PINNED_CLOSEOUT_VERSION);
  expect(manifest.version).toBe("0.1.0");
  expect(manifest.repository).toBe("pmdroid/closeout");
  expect(manifest.tag).toBe("v0.1.0");
  expect(manifest.distribution).toBe("github-release");
  for (const platform of CLOSEOUT_PLATFORMS) {
    const asset = manifest.assets[platform];
    expect(asset.filename).toBe(`closeout-${platform}`);
    expect(asset.target).toBe(TARGETS[platform]);
    expect(asset.digestKind).toBe("unreleased-placeholder");
    expect(closeoutAssetUrl(manifest, platform)).toBe(
      `https://github.com/pmdroid/closeout/releases/download/v0.1.0/closeout-${platform}`,
    );
  }
  expect(closeoutPlatform("darwin", "arm64")).toBe("darwin-arm64");
  expect(closeoutPlatform("darwin", "x64")).toBe("darwin-x64");
  expect(closeoutPlatform("linux", "x64")).toBe("linux-x64");
  expect(closeoutPlatform("linux", "arm64")).toBe("linux-arm64");
  expect(() => closeoutPlatform("win32", "x64")).toThrow(CloseoutInstallError);
});

test("downloads the asset for each platform", async () => {
  const bodies = payloads();
  await withServer(bodies, async (server) => {
    await withHome(async (home) => {
      for (const platform of CLOSEOUT_PLATFORMS) {
        const result = await installCloseout({
          home,
          platform,
          manifest: fixtureManifest(bodies),
          releaseBaseUrl: server.base,
        });
        expect(result.changed).toBe(true);
        expect(result.platform).toBe(platform);
        expect(result.path).toBe(closeoutBinPath(home));
        expect(sha256Hex(await readFile(result.path))).toBe(
          sha256Hex(requireBody(bodies, platform)),
        );
        const info = await stat(result.path);
        expect(info.mode & 0o111).not.toBe(0);
      }
      expect(server.hits).toEqual(CLOSEOUT_PLATFORMS.map((platform) => `closeout-${platform}`));
    });
  });
});

test("a second install is a no-op", async () => {
  const bodies = payloads();
  await withServer(bodies, async (server) => {
    await withHome(async (home) => {
      const manifest = fixtureManifest(bodies);
      const first = await installCloseout({
        home,
        platform: "linux-x64",
        manifest,
        releaseBaseUrl: server.base,
      });
      const second = await installCloseout({
        home,
        platform: "linux-x64",
        manifest,
        releaseBaseUrl: server.base,
      });
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.sha256).toBe(first.sha256);
      expect(server.hits).toEqual(["closeout-linux-x64"]);
    });
  });
});

test("checksum mismatch fails closed and keeps a previous install", async () => {
  const bodies = payloads();
  const manifest = fixtureManifest(bodies);
  await withServer(bodies, async (server) => {
    await withHome(async (home) => {
      await installCloseout({
        home,
        platform: "linux-x64",
        manifest,
        releaseBaseUrl: server.base,
      });
      const before = await readFile(closeoutBinPath(home));
      server.files.set("closeout-linux-x64", new TextEncoder().encode("tampered"));
      await expect(
        installCloseout({
          home,
          platform: "linux-x64",
          manifest,
          releaseBaseUrl: server.base,
        }),
      ).rejects.toMatchObject({ name: "CloseoutInstallError", reason: "checksum" });
      expect(await readFile(closeoutBinPath(home))).toEqual(before);
      expect(await readdir(join(home, "bin"))).toEqual(["closeout"]);
    });
  });

  await withServer(
    new Map([["closeout-linux-x64", new TextEncoder().encode("tampered")]]),
    async (server) => {
      await withHome(async (home) => {
        await expect(
          installCloseout({
            home,
            platform: "linux-x64",
            manifest,
            releaseBaseUrl: server.base,
          }),
        ).rejects.toMatchObject({ reason: "checksum" });
        expect(existsSync(closeoutBinPath(home))).toBe(false);
      });
    },
  );
});

test("a missing release asset fails closed", async () => {
  const bodies = payloads();
  await withServer(new Map(), async (server) => {
    await withHome(async (home) => {
      await expect(
        installCloseout({
          home,
          platform: "darwin-arm64",
          manifest: fixtureManifest(bodies),
          releaseBaseUrl: server.base,
        }),
      ).rejects.toMatchObject({ reason: "http" });
      expect(existsSync(join(home, "bin"))).toBe(false);
    });
  });
});

test("offline install copies a local file and still checks the digest", async () => {
  const bodies = payloads();
  const manifest = fixtureManifest(bodies);
  await withServer(bodies, async (server) => {
    await withHome(async (home) => {
      const offline = join(home, "local-closeout");
      await writeFile(offline, bodies["darwin-x64"]);
      const result = await installCloseout({
        home,
        platform: "darwin-x64",
        manifest,
        offlineFile: offline,
        releaseBaseUrl: server.base,
      });
      expect(server.hits).toEqual([]);
      expect(result.changed).toBe(true);
      expect(sha256Hex(await readFile(result.path))).toBe(
        sha256Hex(requireBody(bodies, "darwin-x64")),
      );
      expect((await stat(result.path)).mode & 0o111).not.toBe(0);

      const again = await installCloseout({
        home,
        platform: "darwin-x64",
        manifest,
        offlineFile: offline,
        releaseBaseUrl: server.base,
      });
      expect(again.changed).toBe(false);
      expect(server.hits).toEqual([]);
    });
  });
});

test("offline checksum mismatch fails closed", async () => {
  const bodies = payloads();
  await withHome(async (home) => {
    const offline = join(home, "local-closeout");
    await writeFile(offline, "not-the-pinned-bytes");
    await expect(
      installCloseout({
        home,
        platform: "linux-arm64",
        manifest: fixtureManifest(bodies),
        offlineFile: offline,
      }),
    ).rejects.toMatchObject({ reason: "checksum" });
    expect(existsSync(closeoutBinPath(home))).toBe(false);
  });
});

test("a non-loopback http download URL is rejected before fetch", async () => {
  let called = false;
  await withHome(async (home) => {
    await expect(
      installCloseout({
        home,
        platform: "linux-x64",
        manifest: fixtureManifest(payloads()),
        releaseBaseUrl: "http://example.com/releases/download",
        fetch: async () => {
          called = true;
          return new Response("nope");
        },
      }),
    ).rejects.toMatchObject({ reason: "http" });
  });
  expect(called).toBe(false);
});

test("a mode-only repair is not a download", async () => {
  const bodies = payloads();
  await withServer(bodies, async (server) => {
    await withHome(async (home) => {
      const manifest = fixtureManifest(bodies);
      await installCloseout({
        home,
        platform: "linux-x64",
        manifest,
        releaseBaseUrl: server.base,
      });
      await chmod(closeoutBinPath(home), 0o644);
      const repaired = await installCloseout({
        home,
        platform: "linux-x64",
        manifest,
        releaseBaseUrl: server.base,
      });
      expect(repaired.changed).toBe(true);
      expect(server.hits).toEqual(["closeout-linux-x64"]);
      expect((await stat(closeoutBinPath(home))).mode & 0o111).not.toBe(0);
    });
  });
});

function requireBody(
  bodies: Record<CloseoutPlatform, Uint8Array>,
  platform: CloseoutPlatform,
): Uint8Array {
  const bytes = bodies[platform];
  if (!bytes) throw new Error(`missing bytes for ${platform}`);
  return bytes;
}

function payloads(): Record<CloseoutPlatform, Uint8Array> {
  const out = {} as Record<CloseoutPlatform, Uint8Array>;
  for (const platform of CLOSEOUT_PLATFORMS) {
    out[platform] = new TextEncoder().encode(`closeout-bytes-${platform}\n`);
  }
  return out;
}

function fixtureManifest(bodies: Record<CloseoutPlatform, Uint8Array>): CloseoutManifest {
  const assets = {} as CloseoutManifest["assets"];
  for (const platform of CLOSEOUT_PLATFORMS) {
    const bytes = bodies[platform];
    assets[platform] = {
      filename: `closeout-${platform}`,
      target: TARGETS[platform],
      sha256: sha256Hex(bytes),
      digestKind: "file",
    };
  }
  return {
    version: "0.1.0",
    repository: "pmdroid/closeout",
    tag: "v0.1.0",
    commit: "baac33e8715aac9d646796035ecc9ba7aaee02ef",
    distribution: "github-release",
    assets,
  };
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "paws-closeout-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withServer(
  files: Map<string, Uint8Array> | Record<CloseoutPlatform, Uint8Array>,
  run: (server: { base: string; hits: string[]; files: Map<string, Uint8Array> }) => Promise<void>,
): Promise<void> {
  const stored =
    files instanceof Map
      ? files
      : new Map(CLOSEOUT_PLATFORMS.map((platform) => [`closeout-${platform}`, files[platform]]));
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const filename = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
      hits.push(filename);
      const body = stored.get(filename);
      if (!body) return new Response("missing", { status: 404 });
      return new Response(body);
    },
  });
  try {
    await run({
      base: `http://127.0.0.1:${server.port}/releases/download`,
      hits,
      files: stored,
    });
  } finally {
    await server.stop(true);
  }
}
