/**
 * Pure, fail-fast bounded-concurrency execution utilities keeping local hashing,
 * remote tree discovery, folder creation, and encrypted file uploads parallelized
 * without exceeding API rate limits or memory budgets.
 */

/**
 * Processes an ordered array of items using a bounded pool of concurrent async workers
 * while preserving the original input order in the returned output array.
 *
 * Execution stops claiming new items immediately when any worker throws or when
 * `abortSignal` triggers, allowing already in-flight tasks to settle cleanly before
 * rethrowing the failure.
 *
 * @param items - Input items to process.
 * @param concurrencyLimit - Maximum number of workers running simultaneously (`>= 1`).
 * @param worker - Async callback invoked for each item and its zero-based index.
 * @param abortSignal - Optional cancellation signal checked before each new item is claimed.
 * @returns Results mapped 1-to-1 with `items`.
 */
export async function runWithConcurrency<InputItem, OutputItem>(
  items: readonly InputItem[],
  concurrencyLimit: number,
  worker: (item: InputItem, itemIndex: number) => Promise<OutputItem>,
  abortSignal?: AbortSignal,
): Promise<OutputItem[]> {
  if (items.length === 0) {
    return [];
  }

  const normalizedConcurrency = Number.isFinite(concurrencyLimit) ? Math.floor(concurrencyLimit) : 1;
  const workerCount = Math.max(1, Math.min(normalizedConcurrency, items.length));
  const results = new Array<OutputItem>(items.length);

  let nextItemIndex = 0;
  let hasEncounteredFailure = false;
  let firstError: unknown = undefined;

  async function executeWorkerLoop(): Promise<void> {
    while (!hasEncounteredFailure) {
      if (abortSignal?.aborted) {
        if (!hasEncounteredFailure) {
          hasEncounteredFailure = true;
          firstError =
            abortSignal.reason instanceof Error
              ? abortSignal.reason
              : new Error('Operation aborted');
        }
        return;
      }

      const currentIndex = nextItemIndex;
      if (currentIndex >= items.length) {
        return;
      }
      nextItemIndex += 1;

      const currentItem = items[currentIndex];
      if (currentItem === undefined && !(currentIndex in items)) {
        return;
      }

      try {
        results[currentIndex] = await worker(currentItem as InputItem, currentIndex);
      } catch (workerError: unknown) {
        if (!hasEncounteredFailure) {
          hasEncounteredFailure = true;
          firstError = workerError;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => executeWorkerLoop()));

  if (hasEncounteredFailure) {
    throw firstError;
  }

  return results;
}
