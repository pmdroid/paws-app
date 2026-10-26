import { journalCaught } from "../journal";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";
import { resolveGrokCommand } from "../acp";
import type { RunnerLoginUpdate } from "../runner-protocol";

export async function runGrokLogin(options: {
  home: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  command?: string[];
  emit(update: RunnerLoginUpdate): void;
}) {
  const adapter = resolveGrokCommand();
  if (!options.command && adapter.error) throw new Error(adapter.error);
  const command = options.command ?? [
    adapter.command,
    "--no-auto-update",
    "login",
    "--device-auth",
  ];
  options.signal.throwIfAborted();
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.home,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (caughtError1) {
        journalCaught(caughtError1, "grok.runGrokLogin.kill", null, "process may have exited");
      }
    }
  };
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  options.signal.addEventListener("abort", kill, { once: true });
  let bytes = 0;
  let overflow = false;
  let challenge = "";
  const capture = async (stream: NodeJS.ReadableStream) => {
    const decoder = new TextDecoder();
    let output = "";
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 131072) {
        overflow = true;
        kill();
        continue;
      }
      output += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const clean = stripVTControlCharacters(output);
      const link = /https:\/\/(?:accounts|auth)\.x\.ai[^\s<>"']*/.exec(clean)?.[0];
      const code =
        /(?:Then enter this code|Confirm this code in your browser):\s*([A-Z0-9-]+)\s/.exec(
          clean,
        )?.[1];
      if (!link || !code) continue;
      const url = new URL(link);
      if (
        (url.hostname !== "accounts.x.ai" && url.hostname !== "auth.x.ai") ||
        url.username ||
        url.password ||
        url.port
      )
        continue;
      const key = `${url.href}:${code}`;
      if (challenge === key) continue;
      challenge = key;
      options.emit({
        state: "waiting",
        terminal: "",
        authorization: {
          url: url.href,
          message: `Enter code ${code}. Only continue with a code you requested.`,
        },
        inputId: null,
      });
    }
  };
  try {
    options.emit({ state: "starting", terminal: "", authorization: null, inputId: null });
    if (options.signal.aborted) kill();
    const [code] = await Promise.all([exited, capture(child.stdout!), capture(child.stderr!)]);
    options.signal.throwIfAborted();
    if (overflow || code !== 0) throw new Error("Grok device sign-in did not complete");
  } finally {
    options.signal.removeEventListener("abort", kill);
    kill();
    await exited.catch((caughtError2) => {
      journalCaught(caughtError2, "grok.runGrokLogin", null);
      return undefined;
    });
  }
}
