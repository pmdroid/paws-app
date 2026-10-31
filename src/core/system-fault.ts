export type SystemFaultClass = "closeout-transfer" | "closeout-policy" | "reviewer-profile";

export class SystemFault extends Error {
  override readonly name: string = "SystemFault";
  constructor(
    readonly faultClass: SystemFaultClass,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function reviewerProfileFault(error: unknown): SystemFault | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" ||
    /command not found|unknown command|unsupported (?:review|command|model)|review command.*not supported|(?:reviewer|codex|claude) login is missing|not authenticated|model (?:not found|not available)/i.test(
      message,
    )
    ? new SystemFault("reviewer-profile", message, { cause: error })
    : null;
}

export function closeoutTransferFault(error: unknown): SystemFault | null {
  if (error instanceof SystemFault) return error;
  const message = error instanceof Error ? error.message : String(error);
  return /worker exited without a result|runner is offline|(?:policy|bundle|payload|transfer).*(?:too large|exceeds|transfer failed)|failed to transfer (?:the )?(?:Closeout )?policy/i.test(
    message,
  )
    ? new SystemFault("closeout-transfer", message, { cause: error })
    : null;
}
