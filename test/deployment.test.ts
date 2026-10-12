import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPublicTls } from "../src/deployment";
import { createPublicTlsFixture, probePublicTls } from "./local/public-tls";

const root = mkdtempSync(join(tmpdir(), "paws-public-tls-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("direct public HTTPS configuration", () => {
  test("local defaults and webhook public URL do not enable public dashboard TLS", () => {
    expect(loadPublicTls({})).toBeUndefined();
    expect(loadPublicTls({ PAWS_PUBLIC_URL: "https://webhook.example.invalid" })).toBeUndefined();
    expect(() => loadPublicTls({ PAWS_PUBLIC_DASHBOARD: "1" })).toThrow("requires");
  });

  test("rejects incomplete paths, relative paths, exposed keys and mismatched material", () => {
    const files = createPublicTlsFixture(join(root, "validation"));
    const other = createPublicTlsFixture(join(root, "other"));
    expect(() => loadPublicTls({ PAWS_TLS_KEY_PATH: files.PAWS_TLS_KEY_PATH })).toThrow(
      "both be absolute",
    );
    expect(() => loadPublicTls({ ...files, PAWS_TLS_KEY_PATH: "relative.key" })).toThrow(
      "both be absolute",
    );
    expect(() => loadPublicTls({ ...files, PAWS_TLS_KEY_PATH: other.PAWS_TLS_KEY_PATH })).toThrow(
      "valid and match",
    );
    for (const mode of [0o644, 0o640, 0o700]) {
      chmodSync(files.PAWS_TLS_KEY_PATH, mode);
      expect(() => loadPublicTls(files)).toThrow("owner-only");
    }
    chmodSync(files.PAWS_TLS_KEY_PATH, 0o600);
    writeFileSync(files.PAWS_TLS_CERT_PATH, "invalid certificate");
    expect(() => loadPublicTls(files)).toThrow("valid and match");
  });

  test("real TLS verifies the configured certificate and serves HTTPS", async () => {
    const observations: boolean[] = [];
    await probePublicTls(root, (_name, passed) => observations.push(passed));
    expect(observations).toEqual([true]);
  });
});
