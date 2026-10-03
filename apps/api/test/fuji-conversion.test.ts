import assert from "node:assert/strict";
import test from "node:test";
import { conversionData, conversionUnsignedWarpMessage, decodeAvalancheId, warpPredicateAccessList } from "../src/fuji-conversion.js";

const EMPTY_ID = "11111111111111111111111111111111LpoYY";

test("CB58 decodes Avalanche's canonical zero ID and rejects altered checksums", () => {
  assert.deepEqual(decodeAvalancheId(EMPTY_ID), Buffer.alloc(32));
  assert.throws(() => decodeAvalancheId(`${EMPTY_ID.slice(0, -1)}Z`), /checksum/);
});

test("conversion payload is byte-exact and includes explicit initial weight", () => {
  const input = {
    subnetId: EMPTY_ID, blockchainId: EMPTY_ID,
    managerAddress: `0x${"a".repeat(40)}`,
    nodeId: "NodeID-GGU7pZzHKHkC4DuXU7RgihBd4ubvvrwKs",
    blsPublicKey: `0x${"b".repeat(96)}`, weight: 100n,
  };
  const result = conversionData(input);
  assert.equal(result.bytes.length, 2 + 32 + 32 + 4 + 20 + 4 + 4 + 20 + 48 + 8);
  assert.match(result.castTuple, /,100\)\]\)$/);
  assert.equal(result.bytes.subarray(-8).readBigUInt64BE(), 100n);
  assert.notEqual(conversionData({ ...input, weight: 101n }).conversionId, result.conversionId);
});

test("Warp predicate uses the complete signed message, delimiter, and 32-byte storage keys", () => {
  const unsigned = conversionUnsignedWarpMessage(EMPTY_ID, `0x${"c".repeat(64)}`);
  assert.equal(unsigned.readUInt32BE(2), 5);
  assert.equal(unsigned.length, 2 + 4 + 32 + 4 + 2 + 4 + 4 + 4 + 2 + 4 + 32);
  const signed = `0x${unsigned.toString("hex")}000000000000000101${"d".repeat(192)}`;
  const access = JSON.parse(warpPredicateAccessList(unsigned, signed)) as Array<{ address: string; storageKeys: string[] }>;
  assert.equal(access[0]?.address, "0x0200000000000000000000000000000000000005");
  assert.ok(access[0]!.storageKeys.length > 1);
  const packed = Buffer.from(access[0]!.storageKeys.map((key) => key.slice(2)).join(""), "hex");
  assert.deepEqual(packed.subarray(0, Buffer.from(signed.slice(2), "hex").length), Buffer.from(signed.slice(2), "hex"));
  assert.equal(packed[Buffer.from(signed.slice(2), "hex").length], 0xff);
  assert.throws(() => warpPredicateAccessList(unsigned, `0x${"0".repeat(unsigned.length * 2 + 192)}`), /does not match/);
});
