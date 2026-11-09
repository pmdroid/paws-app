// A garbage collection during one spawnSync finalizes these stderr writers. On Bun 1.4.2 that
// lowered the poll count of spawnSync's reused event loop, so the next call lost its child's exit.
let writers: ReturnType<typeof Bun.stderr.writer>[] | null = [];
const collectable: WeakRef<object>[] = [];
for (let index = 0; index < 3; index += 1) {
  const writer = Bun.stderr.writer();
  writer.write("");
  writer.flush();
  writers.push(writer);
  collectable.push(new WeakRef(writer));
}
await Bun.sleep(0);
Bun.spawnSync({
  cmd: ["true"],
  stdout: "pipe",
  stderr: "ignore",
  get maxBuffer(): undefined {
    Bun.gc(true);
    writers = null;
    return undefined;
  },
});
const { stdout, exitedDueToTimeout } = Bun.spawnSync({
  cmd: ["sh", "-c", "sleep 0.1; echo polled"],
  stdout: "pipe",
  stderr: "pipe",
  timeout: 2_000,
});
console.log(
  JSON.stringify({
    collected: collectable.filter((reference) => reference.deref() === undefined).length,
    output: stdout.toString(),
    timedOut: exitedDueToTimeout === true,
  }),
);
