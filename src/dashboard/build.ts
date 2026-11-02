import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "assets"), { recursive: true });

const built = await Bun.build({
  entrypoints: [join(root, "src/client/main.ts"), join(root, "src/client/transcript.tsx")],
  outdir: join(dist, "assets"),
  naming: "[name]-[hash].[ext]",
  minify: true,
  target: "browser",
  format: "esm",
  // video.js loads as its own chunk the first time a video plays.
  splitting: true,
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const entryName = (name: string) =>
  built.outputs
    .filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"))
    .map((output) => output.path.split(/[/\\]/).pop()!)
    .find((file) => file.startsWith(`${name}-`));
const jsName = entryName("main");
const transcriptJsName = entryName("transcript");
if (!jsName || !transcriptJsName) {
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

for (const [page, script] of [
  ["index.html", jsName],
  ["transcript.html", transcriptJsName],
] as const) {
  const html = (await Bun.file(join(root, "src/client", page)).text())
    .replaceAll("__CSS__", `assets/${cssName}`)
    .replaceAll("__JS__", `assets/${script}`);
  await Bun.write(join(dist, page), html);
}

console.log(`Built status dashboard → ${dist}`);
