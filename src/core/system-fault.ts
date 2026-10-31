export type SystemFaultClass = "closeout-transfer" | "closeout-policy" | "reviewer-profile";

export class SystemFault extends Error {
  override readonly name = "SystemFault";
  constructor(
    readonly faultClass: SystemFaultClass,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
