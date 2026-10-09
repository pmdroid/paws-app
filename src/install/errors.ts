export type CloseoutInstallFailure =
  | "checksum"
  | "http"
  | "offline"
  | "platform"
  | "manifest"
  | "io";

export class CloseoutInstallError extends Error {
  readonly reason: CloseoutInstallFailure;

  constructor(message: string, reason: CloseoutInstallFailure) {
    super(message);
    this.name = "CloseoutInstallError";
    this.reason = reason;
  }
}
