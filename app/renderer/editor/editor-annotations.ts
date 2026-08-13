/**
 * Transaction annotations shared between the cell's setup and its host hook.
 */

import { Annotation } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';

/**
 * Marks a document replacement the host performed (accepting a ✦ preview,
 * reloading a cell) rather than something the author typed. Annotated
 * transactions must not be echoed back out as an edit, or accepting a
 * suggestion would immediately re-save it as if it were fresh authoring.
 */
export const EXTERNAL_UPDATE = Annotation.define<boolean>();

export function isExternalUpdate(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) => transaction.annotation(EXTERNAL_UPDATE) === true);
}
