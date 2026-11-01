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
  return /^(?:(?:codex|claude)(?::|\s).*command not found|review command.*not supported|(?:reviewer|codex|claude) login is missing)$/i.test(
    message,
  )
    ? new SystemFault("reviewer-profile", message, { cause: error })
    : null;
}

export function closeoutTransferFault(error: unknown): SystemFault | null {
  if (error instanceof SystemFault) return error;
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:Closeout policy exceeds runner transfer limit|Runner bundle exceeds size limit|failed to transfer (?:the )?Closeout policy)$/i.test(
    message,
  )
    ? new SystemFault("closeout-transfer", message, { cause: error })
    : null;
}
