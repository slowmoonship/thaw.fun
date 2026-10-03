import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

function normalized(value) {
  if (isIP(value) === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return value;
}

function globallyRoutable(value) {
  if (isIP(value) === 6) {
    const first = Number.parseInt(normalized(value).split(":")[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !normalized(value).startsWith("2001:db8:");
  }
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 192 && b === 0)
    && !(a === 198 && (b === 18 || b === 19 || b === 51))
    && !(a === 203 && b === 0 && value.split(".")[2] === "113");
}

export function qualifyPublicIp(advertisedIp, interfaces, ifconfigText) {
  if (!globallyRoutable(advertisedIp)) return { qualified: false, reason: "advertised IP is not a globally routable unicast address" };
  const expected = normalized(advertisedIp);
  const entries = Object.entries(interfaces).flatMap(([name, addresses]) => (addresses ?? []).map((address) => ({ name, ...address })));
  const match = entries.find((entry) => !entry.internal && entry.scopeid !== undefined && normalized(entry.address) === expected)
    ?? entries.find((entry) => !entry.internal && normalized(entry.address) === expected);
  if (!match) return { qualified: false, reason: "advertised IP is absent from current local interfaces" };
  if (isIP(advertisedIp) === 6) {
    const line = ifconfigText.split("\n").find((entry) => {
      const address = entry.match(/^\s*inet6\s+([^\s%]+)/)?.[1];
      return address && normalized(address) === expected;
    });
    if (!line) return { qualified: false, reason: "advertised IPv6 is not present in ifconfig output" };
    if (/\b(temporary|deprecated|tentative|detached)\b/i.test(line)) return { qualified: false, reason: "advertised IPv6 is temporary or not usable" };
  }
  return { qualified: true, reason: `current non-temporary global address on ${match.name}` };
}

export function currentPublicIpStatus(advertisedIp) {
  const ifconfig = process.platform === "darwin"
    ? execFileSync("/sbin/ifconfig", ["-a"], { encoding: "utf8", timeout: 10_000 })
    : "";
  return qualifyPublicIp(advertisedIp, networkInterfaces(), ifconfig);
}

export function nodeEndpointIp(endpoint) {
  if (typeof endpoint !== "string") throw new Error("node did not report a public endpoint");
  const match = endpoint.match(/^\[([^\]]+)\]:(\d+)$/) ?? endpoint.match(/^([^:]+):(\d+)$/);
  if (!match || isIP(match[1]) === 0 || Number(match[2]) !== 9651) throw new Error("node public endpoint is not an IP on port 9651");
  return match[1];
}

export function sameIp(left, right) { return isIP(left) !== 0 && isIP(left) === isIP(right) && normalized(left) === normalized(right); }
