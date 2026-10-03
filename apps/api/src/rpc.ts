export async function rpcCall<T>(url: string, method: string, params: unknown[] = [], timeoutMs = 5_000): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message ?? "unknown error"}`);
  if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return body.result;
}

export function hexQuantityToNumber(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`invalid ${label} RPC quantity`);
  const number = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds JavaScript safe integer range`);
  return number;
}
