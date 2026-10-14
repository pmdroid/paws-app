import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseEngineUrl } from "./src/endpoint";

const root = import.meta.dir;
const dist = join(root, "dist");
const engineUrl = process.env.PAWS_ENGINE_URL?.trim() ?? "";

if (engineUrl && !parseEngineUrl(engineUrl)) {
  console.error("PAWS_ENGINE_URL must be an http or https URL");
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "assets"), { recursive: true });

const built = await Bun.build({
  entrypoints: [join(root, "src/client/main.ts")],
  outdir: join(dist, "assets"),
  naming: "[name]-[hash].[ext]",
  minify: true,
  target: "browser",
  format: "esm",
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const js = built.outputs.find((output) => output.path.endsWith(".js"));
const jsName = js?.path.split(/[/\\]/).pop();
if (!js || !jsName) {
  console.error("Client bundle did not emit JavaScript");
  process.exit(1);
}

const cssPath = join(dist, "assets", "theme.css");
const tailwind = Bun.spawn(
  [
    process.execPath,
    "run",
    "tailwindcss",
    "-i",
    join(root, "src/client/theme.css"),
    "-o",
    cssPath,
    "--minify",
  ],
  { cwd: join(root, "../.."), stdout: "inherit", stderr: "inherit" },
);
if ((await tailwind.exited) !== 0) process.exit(1);
const css = (await Bun.file(cssPath).text()).replaceAll(
  "../fonts/bricolage.woff2",
  "./bricolage.woff2",
);
await rm(cssPath);
const cssName = `app-${Bun.hash(css).toString(16)}.css`;
await Bun.write(join(dist, "assets", cssName), css);
await copyFile(
  join(root, "../../landing/public/fonts/bricolage.woff2"),
  join(dist, "assets/bricolage.woff2"),
);

const html = (await Bun.file(join(root, "src/client/index.html")).text())
  .replaceAll("__CSS__", `assets/${cssName}`)
  .replaceAll("__JS__", `assets/${jsName}`);
await Bun.write(join(dist, "index.html"), html);
await Bun.write(join(dist, "config.json"), `${JSON.stringify({ engineUrl }, null, 2)}\n`);

console.log(`Built status dashboard → ${dist}`);
