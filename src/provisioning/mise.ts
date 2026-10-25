import type { MiseRelease, MisePlatform } from "./bootstrap";

export const PINNED_MISE_VERSION = "2026.10.18";

export const PINNED_MISE: Readonly<Record<MisePlatform, MiseRelease>> = {
  "linux-x64": {
    version: PINNED_MISE_VERSION,
    sha256: "e97c38973336aa2ff350fea50f47b412b266fe263b102b7200ff1e9b118c6942",
    platform: "linux-x64",
  },
  "linux-arm64": {
    version: PINNED_MISE_VERSION,
    sha256: "3a3c72376687ba21a588d0f5a2c88c76f483fb6cdece7b0fc43d5e3132b08a52",
    platform: "linux-arm64",
  },
};
