export {
  CORE_RUNTIME_TOOLS,
  parseRuntimeFiles,
  RUNTIME_FILES,
  RUNTIME_LIMIT,
  type Runtime,
  type RuntimeList,
} from "./parse";

import { parseRuntimeFiles, type RuntimeList } from "./parse";

/**
 * The runtime list from a trusted read of {@link RUNTIME_FILES} on `origin/main`.
 * A failed read installs nothing and leaves one line for the task.
 */
export function runtimeList(
  load: { ok: true; files: ReadonlyMap<string, Uint8Array> } | { ok: false; message: string },
): RuntimeList {
  if (load.ok) return parseRuntimeFiles(load.files);
  return {
    runtimes: [],
    notices: [`Paws could not read the repository's runtime list: ${load.message}.`],
  };
}
