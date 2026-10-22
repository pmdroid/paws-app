export { FakeCheckout, gitCheckout, UpdateStepError, type PawsCheckout } from "./checkout";
export {
  createPawsUpdater,
  handlePawsUpdateRequest,
  UPDATE_CHECK_MS,
  UPDATE_RESTART_EXIT,
  UPDATE_TICK_MS,
  type PawsUpdater,
  type TickResult,
} from "./updater";
