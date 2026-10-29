import { BOOTSTRAP_LOG_DIR, type ExeDev, type FakeExeDev } from "../src/provisioning";

/** A bootstrap call as it reached exe.dev: a plain command, or a detached step's start, poll or stop. */
export type OuterCall = {
  kind: "exec" | "start" | "poll" | "stop";
  step: string | null;
  command: string;
  timeoutMs: number | null;
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const unquote = (value: string) => value.replaceAll(`'\\''`, "'");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DIR = escape(BOOTSTRAP_LOG_DIR);

/** The command that starts `script` detached as step `name`, as the bootstrap writes it. */
export function detachCommand(name: string, script: string): string {
  const base = `${BOOTSTRAP_LOG_DIR}/${name}`;
  const run = `sh -c ${quote(script)}; code=$?; printf '%s\\n' "$code" > ${base}.exit.tmp && mv ${base}.exit.tmp ${base}.exit`;
  return `sudo sh -c ${quote(
    [
      `install -d -o root -g root -m 0700 ${BOOTSTRAP_LOG_DIR} || exit 1`,
      `if [ -s ${base}.pid ] && [ ! -e ${base}.exit ]; then kill -TERM "-$(cat ${base}.pid)" 2>/dev/null || true; fi`,
      `rm -f ${base}.log ${base}.exit ${base}.exit.tmp ${base}.pid`,
      `setsid nohup sh -c ${quote(run)} > ${base}.log 2>&1 < /dev/null & echo $! > ${base}.pid`,
      `cat ${base}.pid`,
    ].join("; "),
  )}`;
}

/** The command that polls step `name`. */
export function pollCommand(name: string): string {
  const base = `${BOOTSTRAP_LOG_DIR}/${name}`;
  return `sudo sh -c ${quote(
    [
      `if [ -s ${base}.exit ]; then printf 'exited %s\\n' "$(cat ${base}.exit)"`,
      `elif [ -s ${base}.pid ] && ps -o stat= -p "$(cat ${base}.pid)" 2>/dev/null | grep -q '^[^Z]'; then echo running; exit 0`,
      "else echo lost; fi",
      `tail -c 16384 ${base}.log 2>/dev/null || true`,
    ].join("; "),
  )}`;
}

/** The command that stops step `name` after its budget ran out. */
export function stopCommand(name: string): string {
  const base = `${BOOTSTRAP_LOG_DIR}/${name}`;
  return `sudo sh -c ${quote(
    [
      `if [ -s ${base}.pid ]; then kill -TERM "-$(cat ${base}.pid)" 2>/dev/null || true`,
      "fi",
      `tail -c 2000 ${base}.log 2>/dev/null || true`,
    ].join("; "),
  )}`;
}

function parse(command: string): Omit<OuterCall, "command" | "timeoutMs"> {
  const body = /^sudo sh -c '([\s\S]*)'$/.exec(command)?.[1];
  if (body === undefined) return { kind: "exec", step: null };
  const outer = unquote(body);
  const start = new RegExp(
    `setsid nohup sh -c '([\\s\\S]*)' > ${DIR}/([a-z-]+)\\.log 2>&1 < /dev/null &`,
  ).exec(outer);
  if (start) return { kind: "start", step: start[2]! };
  const poll = new RegExp(`^if \\[ -s ${DIR}/([a-z-]+)\\.exit \\]; then printf 'exited`).exec(
    outer,
  );
  if (poll) return { kind: "poll", step: poll[1]! };
  const stop = new RegExp(`^if \\[ -s ${DIR}/([a-z-]+)\\.pid \\]; then kill`).exec(outer);
  if (stop) return { kind: "stop", step: stop[1]! };
  return { kind: "exec", step: null };
}

/** The script a start command runs detached. */
export function detachedScript(command: string): string | null {
  const body = /^sudo sh -c '([\s\S]*)'$/.exec(command)?.[1];
  if (body === undefined) return null;
  const run = /setsid nohup sh -c '([\s\S]*)' > /.exec(unquote(body))?.[1];
  if (run === undefined) return null;
  const script = /^sh -c '([\s\S]*)'; code=\$\?; /.exec(unquote(run))?.[1];
  return script === undefined ? null : unquote(script);
}

/**
 * The fake exe.dev as a VM runs detached steps: a start runs the step's script through the fake
 * at once, and the first poll reports its exit status and output as the log. Plain commands go
 * straight to the fake, so `exe.calls` lists the scripts the VM ran; `outer` lists what was sent.
 */
export function detaching(exe: FakeExeDev): ExeDev & { outer: OuterCall[] } {
  const outer: OuterCall[] = [];
  const runs = new Map<string, { exitCode: number; log: string }>();
  return {
    outer,
    createVm: (name) => exe.createVm(name),
    deleteVm: (name) => exe.deleteVm(name),
    getVm: (name) => exe.getVm(name),
    listPools: () => exe.listPools(),
    adoptVm: (name, pool) => exe.adoptVm(name, pool),
    async execVm(vm, command, options = {}) {
      const call = { ...parse(command), command, timeoutMs: options.timeoutMs ?? null };
      outer.push(call);
      if (call.kind === "exec") return exe.execVm(vm, command, options);
      const step = call.step!;
      if (call.kind === "start") {
        const result = await exe.execVm(vm, detachedScript(command)!);
        runs.set(step, { exitCode: result.exitCode, log: `${result.stdout}${result.stderr}` });
        return { exitCode: 0, stdout: "4242\n", stderr: "" };
      }
      const run = runs.get(step);
      if (call.kind === "stop") return { exitCode: 0, stdout: run?.log ?? "", stderr: "" };
      if (run === undefined) return { exitCode: 0, stdout: "lost\n", stderr: "" };
      return { exitCode: 0, stdout: `exited ${run.exitCode}\n${run.log}`, stderr: "" };
    },
  };
}

/** A clock whose sleeps only move time forward. */
export function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}
