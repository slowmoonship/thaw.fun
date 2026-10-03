import assert from "node:assert/strict";
import test from "node:test";
import { nodeEndpointIp, qualifyPublicIp, sameIp } from "./fuji-public-ip.mjs";

const stable = "240a:4282:3002:9d:c0e:ac8f:ad74:1e06";
const temporary = "240a:4282:3002:9d:ac19:41dd:fbd2:ec81";
const stale = "240a:4282:3003:1fe:1409:18bf:ba67:e0a6";
const interfaces = { en0: [
  { address: stable, family: "IPv6", internal: false, scopeid: 0 },
  { address: temporary, family: "IPv6", internal: false, scopeid: 0 },
  { address: "192.168.136.190", family: "IPv4", internal: false },
] };
const ifconfig = `en0:\n  inet6 ${stable} prefixlen 64 autoconf secured\n  inet6 ${temporary} prefixlen 64 autoconf temporary\n  inet 192.168.136.190 netmask 0xffffff00`;

test("old advertised IPv6 is blocked even while a listener may exist", () => {
  assert.match(qualifyPublicIp(stale, interfaces, ifconfig).reason, /absent/);
  assert.equal(qualifyPublicIp(stale, interfaces, ifconfig).qualified, false);
});

test("current secured IPv6 qualifies while a temporary IPv6 and private IPv4 do not", () => {
  assert.equal(qualifyPublicIp(stable, interfaces, ifconfig).qualified, true);
  assert.match(qualifyPublicIp(temporary, interfaces, ifconfig).reason, /temporary/);
  assert.match(qualifyPublicIp("192.168.136.190", interfaces, ifconfig).reason, /not a globally routable/);
});

test("node endpoint requires port 9651 and normalizes equivalent IPv6 spellings", () => {
  assert.equal(nodeEndpointIp(`[${stable}]:9651`), stable);
  assert.throws(() => nodeEndpointIp(`[${stable}]:9650`), /port 9651/);
  assert.ok(sameIp("240a:4282:3002:9d:0c0e:ac8f:ad74:1e06", stable));
});
