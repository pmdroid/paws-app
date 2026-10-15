import { expect, test } from "bun:test";
import { tempHome } from "./helpers";
import { probeLinearSessionStop } from "./local/linear-session-stop";

test("Linear dismissal, archive and Stop cancel only their session and apply claimed commands", async () => {
  expect(await probeLinearSessionStop(tempHome())).toHaveLength(8);
});
