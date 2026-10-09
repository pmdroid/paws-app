import { existsSync } from "node:fs";
import { NotImplementedError } from "../core";

/** Fields `config.toml` will hold. Parsing is a later change; a missing file is the default. */
export type PawsConfigFile = {
  linearTeam: string | null;
  repo: string | null;
  publicUrl: string | null;
};

const emptyConfig: PawsConfigFile = {
  linearTeam: null,
  repo: null,
  publicUrl: null,
};

export function loadConfigFile(path: string): PawsConfigFile {
  if (!existsSync(path)) return emptyConfig;
  throw new NotImplementedError("config.toml parsing");
}
