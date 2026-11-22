/**
 * Lightweight, zero-dependency glob matcher used to evaluate exclude/ignore rules
 * against relative POSIX paths during local directory scanning.
 */

/**
 * Compiled exclude rule matcher evaluating relative POSIX file and folder paths.
 */
export interface ExcludeMatcher {
  /**
   * Returns `true` when the entry should be excluded from scanning and synchronization.
   *
   * @param relativePosixPath - Path relative to the mapping's local root using `/` separators.
   * @param isDirectory - Whether the filesystem entry is a directory.
   */
  isExcluded(relativePosixPath: string, isDirectory: boolean): boolean;
}

interface CompiledRule {
  directoryOnly: boolean;
  matchMode: 'segment' | 'anchored';
  regularExpression: RegExp;
}

/**
 * Escapes regex metacharacters while preserving `*` and `?` for glob conversion.
 *
 * @param rawSegment - Raw string segment without glob conversion yet.
 * @returns Regex-safe escaped string.
 */
function escapeRegularExpressionCharacters(rawSegment: string): string {
  return rawSegment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts a glob pattern into an anchored regular expression supporting `**`, `*`, and `?`.
 *
 * @param pattern - Normalized glob pattern without trailing slash.
 * @returns Compiled case-sensitive `RegExp` anchored to start and end.
 */
function globPatternToRegExp(pattern: string): RegExp {
  let regularExpressionSource = '^';
  let characterIndex = 0;

  while (characterIndex < pattern.length) {
    const currentCharacter = pattern[characterIndex] ?? '';

    if (currentCharacter === '*') {
      const nextCharacter = pattern[characterIndex + 1];
      if (nextCharacter === '*') {
        // Handle `**/` so it matches zero or more leading directory segments.
        const characterAfterDoubleStar = pattern[characterIndex + 2];
        if (characterAfterDoubleStar === '/') {
          regularExpressionSource += '(?:.*/)?';
          characterIndex += 3;
          continue;
        }
        regularExpressionSource += '.*';
        characterIndex += 2;
        continue;
      }

      regularExpressionSource += '[^/]*';
      characterIndex += 1;
      continue;
    }

    if (currentCharacter === '?') {
      regularExpressionSource += '[^/]';
      characterIndex += 1;
      continue;
    }

    regularExpressionSource += escapeRegularExpressionCharacters(currentCharacter);
    characterIndex += 1;
  }

  regularExpressionSource += '$';
  return new RegExp(regularExpressionSource);
}

/**
 * Compiles one glob pattern into an internal matching rule.
 *
 * - Patterns ending with `/` only match directories (and indirectly prune their descendants).
 * - Patterns without `/` (after stripping a trailing `/`) match any path segment or full path.
 * - Patterns containing `/` match relative to the mapping root (with leading `/` stripped).
 *
 * @param rawPattern - User-supplied glob pattern.
 * @returns Compiled rule, or `null` if the pattern is blank or a comment.
 */
function compileSinglePattern(rawPattern: string): CompiledRule | null {
  const trimmedPattern = rawPattern.trim();
  if (!trimmedPattern || trimmedPattern.startsWith('#')) {
    return null;
  }

  let normalizedPattern = trimmedPattern.replace(/\\/g, '/');
  if (normalizedPattern.startsWith('./')) {
    normalizedPattern = normalizedPattern.slice(2);
  }

  const directoryOnly = normalizedPattern.endsWith('/');
  if (directoryOnly) {
    normalizedPattern = normalizedPattern.replace(/\/+$/, '');
  }

  if (!normalizedPattern) {
    return null;
  }

  const hasLeadingSlash = normalizedPattern.startsWith('/');
  if (hasLeadingSlash) {
    normalizedPattern = normalizedPattern.replace(/^\/+/, '');
  }

  const containsPathSeparator = hasLeadingSlash || normalizedPattern.includes('/');
  return {
    directoryOnly,
    matchMode: containsPathSeparator ? 'anchored' : 'segment',
    regularExpression: globPatternToRegExp(normalizedPattern),
  };
}

/**
 * Compiles a list of glob exclude patterns into a fast reusable {@link ExcludeMatcher}.
 *
 * @param patterns - List of glob exclude patterns.
 * @returns Matcher instance evaluating relative POSIX paths.
 */
export function compileExcludeMatcher(patterns: readonly string[]): ExcludeMatcher {
  const compiledRules: CompiledRule[] = [];

  for (const pattern of patterns) {
    const rule = compileSinglePattern(pattern);
    if (rule) {
      compiledRules.push(rule);
    }
  }

  return {
    isExcluded(relativePosixPath: string, isDirectory: boolean): boolean {
      if (compiledRules.length === 0) {
        return false;
      }

      const normalizedPath = relativePosixPath
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+|\/+$/g, '');

      if (!normalizedPath) {
        return false;
      }

      const pathSegments = normalizedPath.split('/');

      for (const rule of compiledRules) {
        if (rule.directoryOnly && !isDirectory) {
          // Check whether any ancestor directory segment matches a directory-only pattern.
          const ancestorSegments = pathSegments.slice(0, -1);
          if (rule.matchMode === 'segment') {
            if (ancestorSegments.some((segment) => rule.regularExpression.test(segment))) {
              return true;
            }
          } else {
            for (let segmentCount = 1; segmentCount <= ancestorSegments.length; segmentCount++) {
              const ancestorPath = ancestorSegments.slice(0, segmentCount).join('/');
              if (rule.regularExpression.test(ancestorPath)) {
                return true;
              }
            }
          }
          continue;
        }

        if (rule.matchMode === 'segment') {
          if (
            rule.regularExpression.test(normalizedPath) ||
            pathSegments.some((segment) => rule.regularExpression.test(segment))
          ) {
            return true;
          }
        } else {
          if (rule.regularExpression.test(normalizedPath)) {
            return true;
          }
          // When testing a file inside an excluded anchored directory, match ancestor prefixes too.
          for (let segmentCount = 1; segmentCount < pathSegments.length; segmentCount++) {
            const ancestorPath = pathSegments.slice(0, segmentCount).join('/');
            if (rule.regularExpression.test(ancestorPath)) {
              return true;
            }
          }
        }
      }

      return false;
    },
  };
}
