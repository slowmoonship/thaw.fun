import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const WARP_PRECOMPILE = "0x0200000000000000000000000000000000000005";

function sha256(bytes: Buffer): Buffer { return createHash("sha256").update(bytes).digest(); }
function u32(value: number): Buffer { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function u64(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); return bytes; }
function variable(bytes: Buffer): Buffer { return Buffer.concat([u32(bytes.length), bytes]); }

export function decodeCb58(value: string, expectedLength: number): Buffer {
  if (!value || typeof value !== "string") throw new Error("Avalanche ID is empty");
  let number = 0n;
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("Avalanche ID is not CB58");
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const leadingZeroes = value.match(/^1*/)?.[0].length ?? 0;
  const packed = Buffer.concat([Buffer.alloc(leadingZeroes), number === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
  if (packed.length !== expectedLength + 4) throw new Error("Avalanche ID has an invalid length");
  const payload = packed.subarray(0, expectedLength);
  const checksum = sha256(payload).subarray(28);
  if (!checksum.equals(packed.subarray(expectedLength))) throw new Error("Avalanche ID checksum mismatch");
  return payload;
}

export function decodeAvalancheId(value: string): Buffer {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value.slice(2), "hex") : decodeCb58(value, 32);
}

export interface FujiConversionInput {
  subnetId: string;
  blockchainId: string;
  managerAddress: string;
  nodeId: string;
  blsPublicKey: string;
  weight: bigint;
}

export function conversionData(input: FujiConversionInput): { bytes: Buffer; conversionId: string; castTuple: string } {
  const subnet = decodeAvalancheId(input.subnetId);
  const chain = decodeAvalancheId(input.blockchainId);
  const node = decodeCb58(input.nodeId.replace(/^NodeID-/, ""), 20);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.managerAddress)) throw new Error("invalid ValidatorManager address");
  if (!/^0x[0-9a-fA-F]{96}$/.test(input.blsPublicKey)) throw new Error("invalid BLS public key");
  if (input.weight < 1n || input.weight > 0xffffffffffffffffn) throw new Error("invalid initial validator weight");
  const manager = Buffer.from(input.managerAddress.slice(2), "hex");
  const bls = Buffer.from(input.blsPublicKey.slice(2), "hex");
  const bytes = Buffer.concat([
    Buffer.alloc(2), subnet, chain, variable(manager), u32(1), variable(node), bls, u64(input.weight),
  ]);
  return {
    bytes, conversionId: `0x${sha256(bytes).toString("hex")}`,
    castTuple: `(0x${subnet.toString("hex")},0x${chain.toString("hex")},${input.managerAddress},[(0x${node.toString("hex")},0x${bls.toString("hex")},${input.weight})])`,
  };
}

export function conversionUnsignedWarpMessage(subnetId: string, conversionId: string): Buffer {
  const subnet = decodeAvalancheId(subnetId);
  const conversion = decodeAvalancheId(conversionId);
  // ACP-77: SubnetToL1Conversion(type 0), inside AddressedCall(type 1, empty source),
  // inside a Fuji (network 5) unsigned Warp message sourced from the zero P-Chain ID.
  const inner = Buffer.concat([Buffer.alloc(2), u32(0), conversion]);
  const addressed = Buffer.concat([Buffer.alloc(2), u32(1), variable(Buffer.alloc(0)), variable(inner)]);
  const unsigned = Buffer.concat([Buffer.alloc(2), u32(5), Buffer.alloc(32), variable(addressed)]);
  if (subnet.length !== 32) throw new Error("invalid subnet ID");
  return unsigned;
}

export function warpPredicateAccessList(unsigned: Buffer, signedMessageHex: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(signedMessageHex) || signedMessageHex.length % 2 !== 0) throw new Error("invalid signed Warp message");
  const signed = Buffer.from(signedMessageHex.slice(2), "hex");
  if (signed.length <= unsigned.length || !signed.subarray(0, unsigned.length).equals(unsigned)) {
    throw new Error("signed Warp message does not match the conversion request");
  }
  const signature = signed.subarray(unsigned.length);
  if (signature.length < 4 + 4 + 1 + 96 || signature.readUInt32BE(0) !== 0) throw new Error("signed Warp message has no valid BLS bitset signature envelope");
  const signerBitsLength = signature.readUInt32BE(4);
  if (signerBitsLength < 1 || signature.length !== 4 + 4 + signerBitsLength + 96) throw new Error("signed Warp message BLS signature length mismatch");
  const packed = Buffer.concat([signed, Buffer.from([0xff])]);
  const padded = Buffer.concat([packed, Buffer.alloc((32 - packed.length % 32) % 32)]);
  const storageKeys = [];
  for (let offset = 0; offset < padded.length; offset += 32) storageKeys.push(`0x${padded.subarray(offset, offset + 32).toString("hex")}`);
  return JSON.stringify([{ address: WARP_PRECOMPILE, storageKeys }]);
}
