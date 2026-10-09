const LOCAL_API = "http://127.0.0.1:4040/api/tunnels";

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined> },
) => {
  kill: () => void;
  exited: Promise<number>;
};

export type Tunnel = {
  requested: boolean;
  url: string | null;
  isUp(): boolean;
  refresh(): Promise<void>;
  stop(): void;
};

export function downTunnel(): Tunnel {
  return {
    requested: false,
    url: null,
    isUp: () => false,
    refresh: async () => {},
    stop() {},
  };
}

/**
 * Start `ngrok http --url=<dev-domain> <port>` when a public URL is configured.
 * The child is optional: a missing binary leaves the tunnel down and the poller speeds up.
 */
export function startNgrokTunnel(options: {
  port: number;
  url: string;
  authtoken: string | null;
  command?: string;
  spawn?: SpawnFn;
  probe?: (url: string) => Promise<boolean>;
}): Tunnel {
  const spawn = options.spawn ?? defaultSpawn;
  const probe = options.probe ?? probeNgrok;
  let up = false;
  let child: ReturnType<SpawnFn> | null = null;
  const env: Record<string, string | undefined> = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
  };
  if (options.authtoken !== null) env["NGROK_AUTHTOKEN"] = options.authtoken;
  try {
    child = spawn(
      options.command ?? "ngrok",
      ["http", `--url=${options.url}`, String(options.port)],
      { env },
    );
    void child.exited.then(() => {
      up = false;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ngrok failed to launch";
    console.error(`tunnel not started: ${message}`);
    child = null;
  }
  const tunnel: Tunnel = {
    requested: true,
    url: options.url,
    isUp: () => up,
    async refresh() {
      if (child === null) {
        up = false;
        return;
      }
      try {
        up = await probe(options.url);
      } catch {
        up = false;
      }
    },
    stop() {
      up = false;
      child?.kill();
      child = null;
    },
  };
  void tunnel.refresh();
  return tunnel;
}

async function probeNgrok(url: string): Promise<boolean> {
  const response = await fetch(LOCAL_API, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) return false;
  const json: unknown = await response.json();
  if (json === null || typeof json !== "object" || !("tunnels" in json)) return false;
  const tunnels = json.tunnels;
  if (!Array.isArray(tunnels)) return false;
  const expected = trimSlash(url);
  return tunnels.some((tunnel) => {
    if (tunnel === null || typeof tunnel !== "object" || !("public_url" in tunnel)) return false;
    return typeof tunnel.public_url === "string" && trimSlash(tunnel.public_url) === expected;
  });
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined> },
): { kill: () => void; exited: Promise<number> } {
  const proc = Bun.spawn([command, ...args], {
    env: options.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    kill() {
      proc.kill();
    },
    exited: proc.exited.then((code) => code ?? 1),
  };
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
