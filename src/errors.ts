import { AxiError, exitCodeForError } from "axi-sdk-js";

export { AxiError, exitCodeForError };

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "ACTION_FAILED"
  | "NETWORK"
  | "PROTECTED"
  | "API_ERROR"
  | "UNKNOWN";

export function usageError(message: string, suggestions: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function axiError(
  message: string,
  code: ErrorCode,
  suggestions: string[] = [],
): AxiError {
  return new AxiError(message, code, suggestions);
}
