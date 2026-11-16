export class UserFacingError extends Error {
  reported = false;
  override readonly name = "UserFacingError";
}

export class RunnerSlotsBusyError extends UserFacingError {
  /** How long the attempt waited for the lane before giving up: waiting, not implementation. */
  waitedMs = 0;

  constructor(
    message = "Queued: every runner slot is busy. Paws starts this issue when a slot frees.",
  ) {
    super(message);
  }
}

export class PawsShutdown extends Error {
  override readonly name = "PawsShutdown";
  constructor() {
    super("Paws is restarting");
  }
}
