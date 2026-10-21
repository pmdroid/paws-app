export class UserFacingError extends Error {
  reported = false;
  override readonly name = "UserFacingError";
}

export class RunnerSlotsBusyError extends UserFacingError {
  constructor() {
    super("Queued: every runner slot is busy. Paws starts this issue when a slot frees.");
  }
}
