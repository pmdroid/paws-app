import { mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const run = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited) throw new Error(`Failed: ${args.join(" ")}`);
};
await run(["run", "build:dashboard"]);
const files = ["package.json", "deploy/linux/install-runner.sh"];
function collect(dir: string) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else files.push(path);
  }
}
collect("src/dashboard/dist");
collect("src/db/drizzle-pg");
for (const name of ["pglite.wasm", "initdb.wasm", "pglite.data", "citext.tar.gz"])
  files.push(`node_modules/@electric-sql/pglite/dist/${name}`);
mkdirSync(join(root, "dist"), { recursive: true });
const entry = join(root, "dist", "binary-entry.ts");
const imports = files.map(
  (file, i) =>
    `import a${i} from ${JSON.stringify(relative(join(root, "dist"), join(root, file)).replace(/^(?!\.)/, "./"))} with { type: "file" };`,
);
writeFileSync(
  entry,
  `${imports.join("\n")}\nglobalThis.pawsEmbeddedAssets = {${files.map((file, i) => `${JSON.stringify(file)}: a${i}`).join(",")}};\nif (process.argv[2] === "__ask-team-mcp") { await import("../src/acp/ask-team-mcp.ts"); } else if (process.argv[2] === "__process-anchor") { process.argv.splice(2, 1); await import("../src/process/process-anchor.ts"); } else { await import("../src/index.ts"); }\n`,
);
const version =
  process.env["PAWS_VERSION"] ??
  Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"]).stdout.toString().trim();
try {
  for (const arch of process.argv.slice(2).length ? process.argv.slice(2) : ["x64", "arm64"])
    await run([
      "build",
      "--compile",
      `--target=bun-linux-${arch}`,
      "--define",
      `PAWS_VERSION=${JSON.stringify(version)}`,
      entry,
      "--outfile",
      `dist/paws-${arch}`,
    ]);
} finally {
  rmSync(entry);
}
