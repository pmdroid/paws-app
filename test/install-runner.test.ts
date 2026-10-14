import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const script = resolve(import.meta.dir, "../deploy/linux/install-runner.sh");

function digest(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

function checksum(name: string, body: string) {
  return `${digest(body)}  ${name}\n`;
}

function writeExecutable(directory: string, name: string, body: string) {
  const path = join(directory, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function fakes(directory: string) {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeExecutable(
    bin,
    "id",
    '#!/bin/sh\nif [ "$1" = "-u" ]; then printf \'%s\\n\' "${FAKE_UID:-0}"; exit 0; fi\nexit 1\n',
  );
  writeExecutable(
    bin,
    "dpkg",
    '#!/bin/sh\nif [ "$1" = "--print-architecture" ]; then printf \'%s\\n\' "${FAKE_ARCH:-amd64}"; exit 0; fi\nexit 1\n',
  );
  writeExecutable(
    bin,
    "apt-get",
    `#!/bin/sh
printf '%s\\n' "$*" >> "$PAWS_APT_LOG"
test "$DEBIAN_FRONTEND" = noninteractive || exit 2
if [ "$1" = update ]; then exit 0; fi
if [ "$1" = install ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -y) shift ;;
      *) test -s "$1" || exit 1; cp "$1" "$PAWS_INSTALLED_DEB"; exit 0 ;;
    esac
  done
fi
exit 1
`,
  );
}

function serve(routes: Record<string, string>, latest: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/latest") return Response.redirect(`${url.origin}${latest}`, 302);
      if (url.pathname.startsWith("/tag/")) return new Response("release");
      const body = routes[url.pathname];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response(body);
    },
  });
}

async function install(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(["/bin/sh", script, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function withRelease(
  routes: Record<string, string>,
  latest: string,
  run: (origin: string, directory: string, aptLog: string, installed: string) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "paws-install-runner-"));
  const aptLog = join(directory, "apt.log");
  const installed = join(directory, "installed.deb");
  fakes(directory);
  const server = serve(routes, latest);
  try {
    await run(server.url.origin, directory, aptLog, installed);
  } finally {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

function envFor(
  origin: string,
  directory: string,
  aptLog: string,
  installed: string,
  extra: Record<string, string> = {},
) {
  return {
    PATH: `${join(directory, "bin")}:/usr/bin:/bin`,
    HOME: directory,
    TMPDIR: directory,
    LANG: "C",
    PAWS_RUNNER_DOWNLOAD_BASE: origin,
    PAWS_RUNNER_ALLOW_HTTP_BASE: "1",
    PAWS_APT_LOG: aptLog,
    PAWS_INSTALLED_DEB: installed,
    ...extra,
  };
}

test("installer rejects a non-root caller before download", async () => {
  const name = "paws-runner_1.2.3_amd64.deb";
  const body = "package";
  await withRelease(
    {
      [`/download/v1.2.3/${name}`]: body,
      [`/download/v1.2.3/${name}.sha256`]: checksum(name, body),
    },
    "/tag/v1.2.3",
    async (origin, directory, aptLog, installed) => {
      const result = await install(
        [],
        envFor(origin, directory, aptLog, installed, { FAKE_UID: "1000" }),
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("curl -fsSL https://get.paws.boo | sudo sh");
      expect(existsSync(aptLog)).toBe(false);
    },
  );
});

test("installer follows the latest release and installs the matching package", async () => {
  const name = "paws-runner_1.2.3_amd64.deb";
  const body = "amd64-package";
  await withRelease(
    {
      [`/download/v1.2.3/${name}`]: body,
      [`/download/v1.2.3/${name}.sha256`]: checksum(name, body),
    },
    "/tag/v1.2.3/",
    async (origin, directory, aptLog, installed) => {
      const result = await install([], envFor(origin, directory, aptLog, installed));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed paws-runner 1.2.3");
      expect(readFileSync(installed, "utf8")).toBe(body);
      const log = readFileSync(aptLog, "utf8");
      expect(log.startsWith("update\ninstall -y ")).toBe(true);
      expect(log).toContain("/paws-runner_1.2.3_amd64.deb\n");
    },
  );
});

test("installer selects the requested version and architecture", async () => {
  const name = "paws-runner_2.0.0_arm64.deb";
  const body = "arm64-package";
  await withRelease(
    {
      [`/download/v2.0.0/${name}`]: body,
      [`/download/v2.0.0/${name}.sha256`]: checksum(name, body),
      "/download/v1.2.3/paws-runner_1.2.3_amd64.deb": "wrong",
    },
    "/tag/v1.2.3",
    async (origin, directory, aptLog, installed) => {
      const result = await install(
        ["v2.0.0"],
        envFor(origin, directory, aptLog, installed, { FAKE_ARCH: "arm64" }),
      );
      expect(result.code).toBe(0);
      expect(readFileSync(installed, "utf8")).toBe(body);
      expect(result.stdout).toContain("Installing paws-runner 2.0.0 (arm64)");
    },
  );
});

test("installer accepts a release tag without a v prefix", async () => {
  const name = "paws-runner_0.4.0_amd64.deb";
  const body = "bare-tag";
  await withRelease(
    {
      [`/download/0.4.0/${name}`]: body,
      [`/download/0.4.0/${name}.sha256`]: checksum(name, body),
    },
    "/tag/0.4.0",
    async (origin, directory, aptLog, installed) => {
      const result = await install(["0.4.0"], envFor(origin, directory, aptLog, installed));
      expect(result.code).toBe(0);
      expect(readFileSync(installed, "utf8")).toBe(body);
    },
  );
});

test("installer refuses a checksum that does not match the package", async () => {
  const name = "paws-runner_1.2.3_amd64.deb";
  await withRelease(
    {
      [`/download/v1.2.3/${name}`]: "package",
      [`/download/v1.2.3/${name}.sha256`]: checksum(name, "other"),
    },
    "/tag/v1.2.3",
    async (origin, directory, aptLog, installed) => {
      const result = await install([], envFor(origin, directory, aptLog, installed));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Checksum verification failed");
      expect(existsSync(aptLog)).toBe(false);
      expect(existsSync(installed)).toBe(false);
    },
  );
});

test("installer refuses a checksum that does not bind the package alone", async () => {
  const name = "paws-runner_1.2.3_amd64.deb";
  const body = "package";
  const other = "elsewhere";
  await withRelease(
    {
      [`/download/v1.2.3/${name}`]: body,
      [`/download/v1.2.3/${name}.sha256`]: `${checksum(other, other)}${digest(body)}  ${name}\n`,
    },
    "/tag/v1.2.3",
    async (origin, directory, aptLog, installed) => {
      const result = await install([], envFor(origin, directory, aptLog, installed));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Published checksum must be one line");
      expect(existsSync(aptLog)).toBe(false);
      expect(existsSync(installed)).toBe(false);
    },
  );
});

test("installer refuses a checksum for a different filename", async () => {
  const name = "paws-runner_1.2.3_amd64.deb";
  const body = "package";
  await withRelease(
    {
      [`/download/v1.2.3/${name}`]: body,
      [`/download/v1.2.3/${name}.sha256`]: checksum("other.deb", body),
    },
    "/tag/v1.2.3",
    async (origin, directory, aptLog, installed) => {
      const result = await install(
        ["--version=1.2.3"],
        envFor(origin, directory, aptLog, installed),
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Checksum verification failed");
    },
  );
});

test("installer refuses an unsupported architecture and an invalid version", async () => {
  await withRelease({}, "/tag/v1.2.3", async (origin, directory, aptLog, installed) => {
    const architecture = await install(
      [],
      envFor(origin, directory, aptLog, installed, { FAKE_ARCH: "i386" }),
    );
    expect(architecture.code).not.toBe(0);
    expect(architecture.stderr).toContain("Unsupported architecture: i386");
    const version = await install(
      ["1.2"],
      envFor(origin, directory, aptLog, installed, { FAKE_UID: "1000" }),
    );
    expect(version.code).not.toBe(0);
    expect(version.stderr).toContain("Version must look like 1.2.3");
  });
});

test("installer help and the default download command stay on https", () => {
  const source = readFileSync(script, "utf8");
  expect(source).toContain("curl --proto '=https' --tlsv1.2 -fsSL");
  expect(source).toContain("https://github.com/pmdroid/paws-app/releases");
});

test("installer refuses a checksum joined with a carriage return", async () => {
  const name = "paws-runner_1.2.3_amd64.deb";
  const body = "package";
  const line = checksum(name, body).replace(/\n$/, "");
  await withRelease(
    {
      [`/download/v1.2.3/${name}`]: body,
      [`/download/v1.2.3/${name}.sha256`]: `${line}\rother.deb`,
    },
    "/tag/v1.2.3",
    async (origin, directory, aptLog, installed) => {
      const result = await install([], envFor(origin, directory, aptLog, installed));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Published checksum must be one line");
      expect(existsSync(aptLog)).toBe(false);
      expect(existsSync(installed)).toBe(false);
    },
  );
});

test("installer refuses an http download base outside the loopback opt-in", async () => {
  await withRelease({}, "/tag/v1.2.3", async (origin, directory, aptLog, installed) => {
    const remote = await install(
      ["1.2.3"],
      envFor(origin, directory, aptLog, installed, {
        PAWS_RUNNER_DOWNLOAD_BASE: "http://example.com/releases",
      }),
    );
    expect(remote.code).not.toBe(0);
    expect(remote.stderr).toContain("Download base must use https");
    const loopback = await install(
      ["1.2.3"],
      envFor(origin, directory, aptLog, installed, { PAWS_RUNNER_ALLOW_HTTP_BASE: "" }),
    );
    expect(loopback.code).not.toBe(0);
    expect(loopback.stderr).toContain("Refusing a non-HTTPS download base");
    expect(existsSync(aptLog)).toBe(false);
  });
});
