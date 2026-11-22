import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runWithConcurrency } from '../src/concurrency.ts';

describe('runWithConcurrency', () => {
  it('returns an empty array immediately for empty input', async () => {
    const results = await runWithConcurrency([], 5, async (value: number) => value * 2);
    assert.deepEqual(results, []);
  });

  it('preserves exact input order while enforcing bounded parallelism', async () => {
    const inputs = [10, 20, 30, 40, 50, 60];
    let activeWorkers = 0;
    let peakActiveWorkers = 0;

    const results = await runWithConcurrency(inputs, 3, async (value, itemIndex) => {
      activeWorkers += 1;
      peakActiveWorkers = Math.max(peakActiveWorkers, activeWorkers);
      // Stagger completion times inversely so fast later items resolve before earlier ones.
      await new Promise((resolve) => setTimeout(resolve, (inputs.length - itemIndex) * 4));
      activeWorkers -= 1;
      return `${itemIndex}:${value * 2}`;
    });

    assert.equal(peakActiveWorkers, 3);
    assert.deepEqual(results, ['0:20', '1:40', '2:60', '3:80', '4:100', '5:120']);
  });

  it('stops claiming new items fail-fast when any worker rejects', async () => {
    const inputs = [0, 1, 2, 3, 4, 5];
    const startedIndexes: number[] = [];

    await assert.rejects(
      () =>
        runWithConcurrency(inputs, 2, async (itemIndex) => {
          startedIndexes.push(itemIndex);
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (itemIndex === 0) {
            throw new Error('Worker 0 boom');
          }
          return itemIndex;
        }),
      /Worker 0 boom/,
    );

    assert.ok(startedIndexes.length < inputs.length);
  });

  it('aborts cleanly when AbortSignal is triggered', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('Cancelled by caller'));

    await assert.rejects(
      () =>
        runWithConcurrency(
          [1, 2, 3],
          2,
          async (value) => value,
          abortController.signal,
        ),
      /Cancelled by caller/,
    );
  });
});
