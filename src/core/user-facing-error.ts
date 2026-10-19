export class UserFacingError extends Error {
  reported = false;
  override readonly name = "UserFacingError";
}
