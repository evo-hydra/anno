/**
 * Extract a useful error message, including error.cause for Node.js fetch errors.
 * Node's fetch() throws TypeError("fetch failed") with the real reason in error.cause.
 */
export function extractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: Error }).cause;
  if (cause?.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}
