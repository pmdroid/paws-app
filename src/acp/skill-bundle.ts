import {
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import { loadConfigFile } from "../config";
import { loadImplementationSkills } from "./skills";

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const bundleSchema = z
  .array(
    z.strictObject({
      path: z
        .string()
        .min(1)
        .max(4096)
        .refine(
          (value) =>
            !value.includes("\\") &&
            !value.startsWith("/") &&
            value.split("/").length > 1 &&
            value
              .split("/")
              .every(
                (part) =>
                  part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
              ) &&
            [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127),
        ),
      executable: z.boolean(),
      data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    }),
  )
  .min(1)
  .max(1000);

export async function snapshotImplementationSkills(input: {
  pawsRoot: string;
  worktree: string;
  repository: string;
  signal?: AbortSignal;
}): Promise<Uint8Array | undefined> {
  const { roots } = await loadImplementationSkills({
    pawsRoot: input.pawsRoot,
    worktree: input.worktree,
    repository: input.repository,
    signal: input.signal,
    config: loadConfigFile(join(input.pawsRoot, "config.toml")),
  });
  if (!roots.length) return undefined;
  const files: z.infer<typeof bundleSchema> = [];
  let size = 0;
  for (const root of roots) {
    const visit = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        input.signal?.throwIfAborted();
        const path = join(directory, name);
        const info = lstatSync(path);
        if (info.isDirectory()) {
          visit(path);
          continue;
        }
        if (!info.isFile() || info.nlink !== 1)
          throw new Error(
            "Transferred skills require regular files without symlinks or hard links",
          );
        size += info.size;
        if (size > MAX_BUNDLE_BYTES || files.length >= 1000)
          throw new Error("Transferred skills exceed the bundle limits");
        files.push({
          path: `${basename(root)}/${relative(root, path)}`,
          executable: (info.mode & 0o111) !== 0,
          data: readFileSync(path).toString("base64"),
        });
      }
    };
    visit(root);
  }
  const bytes = Buffer.from(JSON.stringify(bundleSchema.parse(files)));
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("Transferred skills exceed 20 MiB");
  return bytes;
}

export function materializeImplementationSkills(bytes: Uint8Array, parent: string): string {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("Transferred skills exceed 20 MiB");
  const files = bundleSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Duplicate transferred skill path");
  const root = mkdtempSync(join(parent, ".paws-skills-"));
  try {
    for (const file of files) {
      const contents = Buffer.from(file.data, "base64");
      if (contents.toString("base64") !== file.data) throw new Error("Invalid skill encoding");
      const path = join(root, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, contents, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
