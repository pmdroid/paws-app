import type { TailscalePlatform, TailscaleRelease } from "./bootstrap";

/**
 * The Tailscale static release a Create VM VM installs to join the Paws tailnet. The SHA-256 is of
 * `https://pkgs.tailscale.com/stable/tailscale_<version>_<platform>.tgz`, checked on the VM before
 * anything is unpacked.
 */
export const PINNED_TAILSCALE_VERSION = "1.104.2";

export const PINNED_TAILSCALE: Readonly<Record<TailscalePlatform, TailscaleRelease>> = {
  amd64: {
    version: PINNED_TAILSCALE_VERSION,
    sha256: "512f613ed7d04fc7282f7dc5bd76aa105aae28168fbb9357eb749ebcbc29f0ae",
    platform: "amd64",
  },
  arm64: {
    version: PINNED_TAILSCALE_VERSION,
    sha256: "5776aaa901b5ef1916e66be5bb54b9f481cd399c9c28db123a8cab620efa237b",
    platform: "arm64",
  },
};
