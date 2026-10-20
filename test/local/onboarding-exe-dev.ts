export type ExeDevCall =
  | { operation: "list"; status: number }
  | { operation: "create"; name: string; cpu: number; memoryGB: number; status: number }
  | { operation: "exec"; vmName: string; bytes: number; status: number; exitCode: number | null }
  | { operation: "rejected"; reason: string; status: number };

export type ExeDevGuest = (input: {
  vmName: string;
  command: string;
}) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

export type OnboardingExeDev = {
  origin: string;
  token: string;
  calls: ExeDevCall[];
  vms: Map<string, { name: string; status: string }>;
  failNextExec: number;
  guest: ExeDevGuest;
  stop(): Promise<void>;
};

function unquote(value: string) {
  const match = /^'((?:[^']|'\\'')*)'$/.exec(value);
  return match ? match[1]!.replaceAll("'\\''", "'") : null;
}

export function startOnboardingExeDev(token: string): OnboardingExeDev {
  const wire = (vm: { name: string; status: string }) => ({
    vm_name: vm.name,
    ssh_dest: `vm+${vm.name}@exe.invalid`,
    ssh_host: "exe.invalid",
    ssh_user: `vm+${vm.name}`,
    status: vm.status,
  });
  const ndjson = (result: { exitCode: number; stdout?: string; stderr?: string }) =>
    [
      ...(result.stdout ? [{ stdout: Buffer.from(result.stdout).toString("base64") }] : []),
      ...(result.stderr ? [{ stderr: Buffer.from(result.stderr).toString("base64") }] : []),
      { exit_code: result.exitCode },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n";
  async function handle(request: Request): Promise<{ response: Response; call: ExeDevCall }> {
    const rejected = (reason: string, status: number) => ({
      response: Response.json({ error: reason }, { status }),
      call: { operation: "rejected", reason, status } as const,
    });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/exec")
      return rejected("route", 404);
    if (request.headers.get("authorization") !== `Bearer ${fake.token}`)
      return rejected("credentials", 401);
    const command = await request.text();
    if (command === "ls --json")
      return {
        response: Response.json({ vms: [...fake.vms.values()].map(wire) }),
        call: { operation: "list", status: 200 },
      };
    const created = /^new --name=('(?:[^']|'\\'')*') --cpu=(\d+) --memory=(\d+)GB(?: |$)/.exec(
      command,
    );
    if (created) {
      const name = unquote(created[1]!);
      const input = { name: name ?? "", cpu: Number(created[2]), memoryGB: Number(created[3]) };
      const extra = command.slice(created[0].length).trim();
      if (!name || !/^(?:--(?:pool|image)='(?:[^']|'\\'')*' ?)*$/.test(extra))
        return rejected("create syntax", 400);
      if (fake.vms.has(name)) {
        const status = 422;
        return {
          response: Response.json({ error: "exists" }, { status }),
          call: { operation: "create", ...input, status },
        };
      }
      const vm = { name, status: "running" };
      fake.vms.set(name, vm);
      return {
        response: Response.json(wire(vm)),
        call: { operation: "create", ...input, status: 200 },
      };
    }
    const executed = /^ssh ('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*')$/s.exec(command);
    if (executed) {
      const vmName = unquote(executed[1]!);
      const inner = unquote(executed[2]!);
      if (!vmName || inner === null || !inner.trim()) return rejected("exec syntax", 400);
      const bytes = Buffer.byteLength(inner);
      if (fake.vms.get(vmName)?.status !== "running") {
        const status = 422;
        return {
          response: Response.json({ error: "missing" }, { status }),
          call: { operation: "exec", vmName, bytes, status, exitCode: null },
        };
      }
      if (fake.failNextExec > 0) {
        fake.failNextExec -= 1;
        const result = { exitCode: 1, stderr: "install failed in fixture\n" };
        return {
          response: new Response(ndjson(result), {
            headers: { "content-type": "application/x-ndjson" },
          }),
          call: { operation: "exec", vmName, bytes, status: 200, exitCode: 1 },
        };
      }
      const result = await fake.guest({ vmName, command: inner });
      return {
        response: new Response(ndjson(result), {
          headers: { "content-type": "application/x-ndjson" },
        }),
        call: { operation: "exec", vmName, bytes, status: 200, exitCode: result.exitCode },
      };
    }
    return rejected("unknown command", 400);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { response, call } = await handle(request);
      fake.calls.push(call);
      return response;
    },
  });
  const fake: OnboardingExeDev = {
    origin: `http://127.0.0.1:${server.port}`,
    token,
    calls: [],
    vms: new Map(),
    failNextExec: 0,
    guest: async () => ({ exitCode: 127, stderr: "no guest bootstrap configured\n" }),
    stop: () => server.stop(true),
  };
  return fake;
}
