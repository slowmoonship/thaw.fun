export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const jsonLogger: StructuredLogger = {
  info(fields, message) { process.stdout.write(`${JSON.stringify({ level: "info", time: new Date().toISOString(), message, ...fields })}\n`); },
  warn(fields, message) { process.stderr.write(`${JSON.stringify({ level: "warn", time: new Date().toISOString(), message, ...fields })}\n`); },
  error(fields, message) { process.stderr.write(`${JSON.stringify({ level: "error", time: new Date().toISOString(), message, ...fields })}\n`); },
};
