import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runWithConcurrency } from './concurrency.ts';
import { compileExcludeMatcher } from './ignore.ts';
import type { LocalFileEntry, LocalScanResult } from './types.ts';

/**
 * Default number of local files streamed and SHA1-hashed concurrently.
 */
const DEFAULT_LOCAL_HASH_CONCURRENCY = 8;

interface DiscoveredLocalFileCandidate {
  absolutePath: string;
  relativePath: string;
  sizeInBytes: number;
  modificationTime: Date;
}

/**
 * Computes the lowercase hexadecimal SHA1 digest of a local file using Node.js streams
 * so arbitrarily large files are hashed in constant memory without buffering into RAM.
 *
 * @param filePath - Absolute path to the regular file to hash.
 * @param abortSignal - Optional cancellation signal interrupting reading promptly.
 * @returns Lowercase 40-character hexadecimal SHA1 digest.
 */
export async function computeFileSha1Stream(
  filePath: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  abortSignal?.throwIfAborted();

  const sha1Hasher = crypto.createHash('sha1');
  const readStream = fs.createReadStream(filePath);

  const onAbort = () => {
    readStream.destroy(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('Operation aborted'));
  };

  abortSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of readStream) {
      abortSignal?.throwIfAborted();
      sha1Hasher.update(chunk);
    }
    return sha1Hasher.digest('hex');
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    readStream.destroy();
  }
}

/**
 * Recursively scans a local directory asynchronously, applying exclude globs and
 * computing streaming SHA1 digests concurrently across regular files.
 *
 * Symbolic links, FIFOs, sockets, and empty directories are skipped, while directory
 * exclude patterns prune traversal before descending into ignored subtrees.
 *
 * @param localRootDirectory - Absolute path to the local directory root.
 * @param excludePatterns - Optional glob patterns evaluated relative to `localRootDirectory`.
 * @param abortSignal - Optional cancellation signal checked throughout scanning.
 * @param hashConcurrency - Maximum number of concurrent file hash streams (defaults to `8`).
 * @returns Map of relative POSIX file paths to metadata plus cumulative byte size.
 */
export async function scanLocalDirectory(
  localRootDirectory: string,
  excludePatterns: readonly string[] = [],
  abortSignal?: AbortSignal,
  hashConcurrency = DEFAULT_LOCAL_HASH_CONCURRENCY,
): Promise<LocalScanResult> {
  const discoveredFiles: DiscoveredLocalFileCandidate[] = [];
  const excludeMatcher = compileExcludeMatcher(excludePatterns);

  async function traverseDirectory(currentDirectory: string): Promise<void> {
    abortSignal?.throwIfAborted();

    const directoryEntries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
    // Sort deterministically so log output and plans are reproducible across filesystems.
    directoryEntries.sort((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name));

    for (const directoryEntry of directoryEntries) {
      abortSignal?.throwIfAborted();

      const fullEntryPath = path.join(currentDirectory, directoryEntry.name);
      const relativePosixPath = path
        .relative(localRootDirectory, fullEntryPath)
        .split(path.sep)
        .join('/');

      if (directoryEntry.isDirectory()) {
        if (excludeMatcher.isExcluded(relativePosixPath, true)) {
          continue;
        }
        await traverseDirectory(fullEntryPath);
      } else if (directoryEntry.isFile()) {
        if (excludeMatcher.isExcluded(relativePosixPath, false)) {
          continue;
        }

        const fileStats = await fs.promises.stat(fullEntryPath);
        discoveredFiles.push({
          absolutePath: fullEntryPath,
          relativePath: relativePosixPath,
          sizeInBytes: fileStats.size,
          modificationTime: fileStats.mtime,
        });
      }
    }
  }

  await traverseDirectory(localRootDirectory);
  discoveredFiles.sort((firstFile, secondFile) =>
    firstFile.relativePath.localeCompare(secondFile.relativePath),
  );

  const computedHashes = await runWithConcurrency(
    discoveredFiles,
    hashConcurrency,
    (candidate) => computeFileSha1Stream(candidate.absolutePath, abortSignal),
    abortSignal,
  );

  const filesByRelativePath = new Map<string, LocalFileEntry>();
  let totalSizeInBytes = 0;

  for (let index = 0; index < discoveredFiles.length; index++) {
    const candidate = discoveredFiles[index];
    const sha1Hash = computedHashes[index];
    if (!candidate || sha1Hash === undefined) {
      continue;
    }

    filesByRelativePath.set(candidate.relativePath, {
      absolutePath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      sha1Hash,
      sizeInBytes: candidate.sizeInBytes,
      modificationTime: candidate.modificationTime,
    });
    totalSizeInBytes += candidate.sizeInBytes;
  }

  return {
    filesByRelativePath,
    totalSizeInBytes,
  };
}
