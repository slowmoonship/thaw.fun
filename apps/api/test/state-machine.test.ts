import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition } from "../src/state-machine.js";

test("permits lifecycle transitions", () => {
  assert.doesNotThrow(() => assertTransition("CREATING", "LIVE"));
  assert.doesNotThrow(() => assertTransition("LIVE", "EXPIRING"));
  assert.doesNotThrow(() => assertTransition("EXPIRING", "DEAD"));
});

test("rejects resurrection", () => assert.throws(() => assertTransition("DEAD", "LIVE"), /illegal/));
