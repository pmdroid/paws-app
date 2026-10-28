import type { PreviewRuntime } from "./runtime";

/** In-memory runner/Tailscale fake. No network or product command is started. */
export function createFakePreviewRuntime(
  options: {
    frameHeaders?: Record<string, string>;
    warmFailures?: number;
    tagged?: boolean;
    occupied?: boolean;
    wildcard?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const starts: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  let started = false;
  let stopped = false;
  let finish: (code: number) => void = () => undefined;
  let failures = options.warmFailures ?? 0;
  const io: PreviewRuntime = {
    async command(argv) {
      calls.push(argv);
      if (argv[1] === "status")
        return JSON.stringify({
          CurrentTailnet: { MagicDNSSuffix: "test-tail.ts.net" },
          Self: { Tags: options.tagged === false ? [] : ["tag:paws-runner"] },
        });
      if (argv[0] === "ss" && !started && !options.occupied) return "";
      if (argv[0] === "ss")
        return `LISTEN 0 128 ${options.wildcard ? "0.0.0.0" : "127.0.0.1"}:${argv.at(-1)!.slice(1)} 0.0.0.0:*`;
      return "";
    },
    start(argv, cwd, env) {
      started = true;
      starts.push({ argv, cwd, env });
      const exited = new Promise<number>((resolve) => {
        finish = resolve;
      });
      return {
        exited,
        async stop() {
          stopped = true;
          finish(0);
        },
      };
    },
    async fetch(url) {
      if (!started && !options.occupied) throw new Error("Not listening");
      if (url.startsWith("https:") && failures-- > 0) throw new Error("Certificate not ready");
      return new Response("fixture", { headers: options.frameHeaders });
    },
  };
  return {
    io,
    calls,
    starts,
    get stopped() {
      return stopped;
    },
    exit(code = 1) {
      finish(code);
    },
  };
}
