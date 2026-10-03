import assert from "node:assert/strict";
import test from "node:test";
import { validateCreateInput } from "../src/validation.js";

test("validates safe create input", () => {
  assert.deepEqual(validateCreateInput({ name: "My Stupid Chain", symbol: "LOL", lifetimeSeconds: 60 }), { name: "My Stupid Chain", symbol: "LOL", lifetimeSeconds: 60 });
});

for (const body of [
  { name: "../escape", symbol: "LOL", lifetimeSeconds: 60 },
  { name: "ok; touch pwned", symbol: "LOL", lifetimeSeconds: 60 },
  { name: "OK", symbol: "lol", lifetimeSeconds: 60 },
  { name: "OK", symbol: "L/OL", lifetimeSeconds: 60 },
  { name: "OK", symbol: "LOL", lifetimeSeconds: 59 },
]) test(`rejects unsafe input ${JSON.stringify(body)}`, () => assert.throws(() => validateCreateInput(body)));
