import assert from "node:assert/strict";
import test from "node:test";
import { generateEvmChainId } from "../src/chain-id.js";

test("retries repository collisions", () => {
  const values = [123_456_789, 123_456_790];
  assert.equal(generateEvmChainId([123_456_789], () => values.shift()!), 123_456_790);
});
