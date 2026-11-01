import { setJournalSink } from "../../src/db";
import { openRunnerRuntime } from "../../src/runner-runtime";

// Run the production runtime in a disposable process while keeping the existing
// restart fixture's scripted daemon, broker and local Git transport in its parent.
type Options = Parameters<typeof openRunnerRuntime>[0];
type Runtime = Awaited<ReturnType<typeof openRunnerRuntime>>;
type Message = { id: number; method: string; args: unknown[] };

export async function runtimeProcess(options: Options) {
  if (options.skills) throw new Error("This fixture does not bridge skill installers");
  const workers = new Set<string>();
  const observations = () => ({
    alive: Object.fromEntries([...workers].map((id) => [id, options.broker?.alive?.(id) ?? true])),
    now: options.now?.(),
    monotonic: options.monotonic?.(),
    concurrency:
      typeof options.concurrency === "function" ? options.concurrency() : options.concurrency,
    agents: options.agents?.installed(),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { method, args } = (await request.json()) as Message;
      try {
        const [group, name] = method.split(".");
        const target =
          group === "daemon"
            ? options.daemon
            : group === "agents"
              ? options.agents
              : options.broker;
        if (method === "broker.start") workers.add(String(args[0]));
        const value =
          group === "networkGit"
            ? await options.networkGit!(
                args[0] as Parameters<NonNullable<Options["networkGit"]>>[0],
              )
            : group === "error"
              ? options.onError?.(new Error(String(args[0])))
              : await (target as unknown as Record<string, (...args: unknown[]) => unknown>)[
                  name!
                ]!(...args);
        return Response.json({ value });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path], {
    env: { PATH: process.env.PATH, HOME: options.home },
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: { id: number; value?: unknown; error?: string }) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error));
      else waiter?.resolve(message.value);
    },
  });
  let exited = false;
  void child.exited.then(() => {
    exited = true;
    for (const waiter of pending.values()) waiter.reject(new Error("Runner fixture exited"));
    pending.clear();
  });
  const dispose = async () => {
    child.kill();
    await child.exited;
    await server.stop(true);
  };
  const call = (method: string, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (exited) return reject(new Error("Runner fixture exited"));
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.send({ id, method, args });
    });
  try {
    await call(
      "open",
      {
        root: options.root,
        spool: options.spool,
        results: options.results,
        repositoryRoot: options.repositoryRoot,
        home: options.home,
        resultRetryMs: options.resultRetryMs,
        sessionRetryMs: options.sessionRetryMs,
        stopWaitMs: options.stopWaitMs,
        deliveryWaitMs: options.deliveryWaitMs,
      },
      options.daemon.status(),
      server.url.href,
      Object.keys(options.daemon),
      observations(),
    );
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    tick: () => call("tick", observations()),
    async stop() {
      try {
        if (!exited) await call("stop");
      } finally {
        await dispose();
      }
    },
    async crash() {
      child.kill("SIGKILL");
      await child.exited;
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  setJournalSink(() => {});
  let runtime: Runtime;
  let observed: {
    alive: Record<string, boolean>;
    now?: number;
    monotonic?: number;
    concurrency?: number;
    agents?: ReturnType<NonNullable<Options["agents"]>["installed"]>;
  };
  process.on("message", async (request: Message) => {
    try {
      if (request.method === "open") {
        const [options, paired, endpoint, methods, initial] = request.args as [
          Options,
          ReturnType<Options["daemon"]["status"]>,
          string,
          string[],
          typeof observed,
        ];
        observed = initial;
        const rpc = async (method: string, ...args: unknown[]) => {
          const response = await fetch(endpoint, {
            method: "POST",
            body: JSON.stringify({ method, args }),
          });
          const result = (await response.json()) as { value?: unknown; error?: string };
          if (result.error) throw new Error(result.error);
          return result.value;
        };
        let commands: unknown[] = [];
        runtime = await openRunnerRuntime({
          ...options,
          ...(initial.now === undefined ? {} : { now: () => observed.now! }),
          ...(initial.monotonic === undefined ? {} : { monotonic: () => observed.monotonic! }),
          ...(initial.concurrency === undefined
            ? {}
            : { concurrency: () => observed.concurrency! }),
          ...(initial.agents === undefined
            ? {}
            : {
                agents: {
                  installed: () => observed.agents,
                  apply: (targets: unknown) => {
                    void rpc("agents.apply", targets);
                  },
                } as Options["agents"],
              }),
          onError: (error) => {
            void rpc("error", error.message);
          },
          networkGit: (input) => rpc("networkGit", input) as Promise<void>,
          broker: {
            start: (id) =>
              rpc("broker.start", id) as ReturnType<NonNullable<Options["broker"]>["start"]>,
            stop: async (id) => {
              await rpc("broker.stop", id);
            },
            alive: (id) => observed.alive[id] ?? true,
          },
          daemon: new Proxy(
            {},
            {
              get(_target, name: string) {
                if (!methods.includes(name)) return undefined;
                if (name === "status") return () => paired;
                if (name === "pendingCommands") return () => commands;
                return async (...args: unknown[]) => {
                  const result = await rpc(`daemon.${name}`, ...args);
                  if (name === "pollCommands")
                    commands = (result as { commands: unknown[] }).commands;
                  if (name === "acknowledgeCommand")
                    commands = commands.filter((c) => (c as { id: string }).id !== args[0]);
                  return result;
                };
              },
            },
          ) as Options["daemon"],
        });
      } else if (request.method === "tick") {
        observed = request.args[0] as typeof observed;
        await runtime!.tick();
      } else if (request.method === "stop") await runtime!.stop();
      process.send!({ id: request.id });
    } catch (error) {
      process.send!({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
