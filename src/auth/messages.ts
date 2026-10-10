/** Shown when a stored GitHub token can no longer be used. No retry. */
export const GITHUB_REAUTH_MESSAGE = "Run `bun run paws login github`";

export const DEVICE_CODE_EXPIRED_MESSAGE = `The GitHub device code expired. ${GITHUB_REAUTH_MESSAGE}.`;

export const DEVICE_ACCESS_DENIED_MESSAGE = `GitHub denied the sign-in. ${GITHUB_REAUTH_MESSAGE}.`;

export const DEVICE_SCOPE_MESSAGE = `GitHub did not grant repo and read:org. ${GITHUB_REAUTH_MESSAGE}.`;

/**
 * Device-flow scope. `workflow` is not requested: that scope can push
 * `.github/workflows`, and Paws does not edit GitHub Actions workflows.
 */
export const DEVICE_SCOPE = "repo read:org";

export const WORKFLOW_SCOPE_NOTE =
  "The workflow scope is not requested. Paws does not edit GitHub Actions workflows.";

export const FILE_TOKEN_STORE_DOCTOR_WARNING =
  "GitHub OAuth token is in ~/.paws/secrets/github-oauth.json (mode 0600) because the macOS keychain and secret-tool are unavailable. paws doctor warns about this fallback.";
