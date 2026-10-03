export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
  ) {
    super(message);
  }
}

export class CommandError extends Error {
  constructor(
    public readonly executable: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly timedOut: boolean,
  ) {
    const diagnostic = [...stderr.trim().split("\n"), ...stdout.trim().split("\n")].filter(Boolean).at(-1);
    super(`${executable} failed${timedOut ? " (timeout)" : ` with exit code ${exitCode ?? "unknown"}`}${diagnostic ? `: ${diagnostic}` : ""}`);
  }
}

export function sanitizeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(password|passphrase|private[ _-]?key|seed|mnemonic)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/0x[a-fA-F0-9]{64}/g, "[redacted-hex]")
    .replace(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, "[redacted-token]")
    .slice(0, 500);
}
