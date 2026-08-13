/**
 * Narrowing unknown errors to something a person can read.
 *
 * Every catch in this pane routes through here and surfaces the result in the
 * UI. Nothing is swallowed.
 */

const FALLBACK_MESSAGE = 'Something went wrong.';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return FALLBACK_MESSAGE;
}
