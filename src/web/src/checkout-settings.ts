/** `GET /api/settings/checkout`. Paths left out of a repository's checkout for new runs. */
export type CheckoutHideFrom = "agent" | "checks";
export type CheckoutPath = {
  /** Relative path or glob. A trailing `/` names a folder. */
  path: string;
  hideFrom: CheckoutHideFrom;
  /** Closeout check ids that read this path. */
  usedBy: string[];
};
export type CheckoutRepository = {
  repo: string;
  paths: CheckoutPath[];
  /** File counts for the saved paths. Missing when Paws could not count them. */
  files?: { total: number; agent: number };
};
export type CheckoutSettings = {
  /** The Linear label that runs an issue with the full checkout. */
  label: string;
  repositories: CheckoutRepository[];
  /** Present on a PUT response when the saved paths need attention. */
  warnings?: string[];
};
/** `PUT /api/settings/checkout` body. Every repository is sent, including empty ones. */
export type CheckoutSettingsUpdate = {
  repositories: { repo: string; paths: { path: string; hideFrom: CheckoutHideFrom }[] }[];
};
