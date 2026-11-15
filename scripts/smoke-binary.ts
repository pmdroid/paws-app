import { mkdtempSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const installer = readFileSync(
  resolve(import.meta.dir, "../deploy/linux/install-runner.sh"),
  "utf8",
);
const dir = mkdtempSync(join(tmpdir(), "paws-binary-"));
const binary = join(dir, "paws");
copyFileSync(resolve(process.argv[2] ?? "dist/paws-x64"), binary);
const env = { ...process.env, PAWS_HOME: join(dir, "home"), PAWS_PORT: "18787" };
const run = async (args: string[]) => {
  const child = Bun.spawn([binary, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`${args}: ${err}`);
  return out;
};
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  if (!(await run(["--version"])).trim()) throw new Error("Missing version");
  const embeddedInstaller = [
    ...new Bun.Glob("cache/assets/*/deploy/linux/install-runner.sh").scanSync({
      cwd: env.PAWS_HOME,
      absolute: true,
    }),
  ];
  if (embeddedInstaller.length !== 1 || readFileSync(embeddedInstaller[0]!, "utf8") !== installer)
    throw new Error("Compiled runner installer is missing or differs from the release script");
  server = Bun.spawn([binary], {
    cwd: dir,
    env,
    stdout: Bun.file(join(dir, "stdout")),
    stderr: Bun.file(join(dir, "stderr")),
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    ready = await fetch("http://127.0.0.1:18787/dashboard")
      .then((r) => r.status === 200)
      .catch(() => false);
    if (ready) break;
    if (server.exitCode !== null) throw new Error(await Bun.file(join(dir, "stderr")).text());
    await Bun.sleep(500);
  }
  if (!ready) throw new Error("Dashboard did not start");
  server.kill("SIGTERM");
  await server.exited;
  const report = await run(["db", "check"]);
  if (!report.includes("migrations applied")) throw new Error(report);
  console.log(report.trim());
} finally {
  server?.kill();
  if (server) await server.exited;
  rmSync(dir, { recursive: true, force: true });
}
