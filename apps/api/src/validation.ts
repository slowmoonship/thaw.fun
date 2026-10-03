import { AppError } from "./errors.js";
import type { CreateChainInput } from "./domain.js";

const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const SYMBOL = /^[A-Z][A-Z0-9]{1,9}$/;

export function validateCreateInput(value: unknown): CreateChainInput {
  if (!value || typeof value !== "object") throw new AppError("INVALID_INPUT", "request body must be an object", 400);
  const body = value as Record<string, unknown>;
  if (typeof body.name !== "string" || !DISPLAY_NAME.test(body.name)) {
    throw new AppError("INVALID_NAME", "name must be 1-40 safe ASCII characters", 400);
  }
  if (typeof body.symbol !== "string" || !SYMBOL.test(body.symbol)) {
    throw new AppError("INVALID_SYMBOL", "symbol must be 2-10 uppercase ASCII letters or digits", 400);
  }
  if (!Number.isInteger(body.lifetimeSeconds) || (body.lifetimeSeconds as number) < 60 || (body.lifetimeSeconds as number) > 604800) {
    throw new AppError("INVALID_LIFETIME", "lifetimeSeconds must be an integer from 60 to 604800", 400);
  }
  return { name: body.name.trim(), symbol: body.symbol, lifetimeSeconds: body.lifetimeSeconds as number };
}
