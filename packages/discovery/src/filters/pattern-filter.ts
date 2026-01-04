import picomatch from 'picomatch';

export interface PatternFilterOptions {
  /** Include patterns (if specified, only matching files included) */
  include?: string[];

  /** Exclude patterns (applied after include) */
  exclude?: string[];
}

/**
 * Create a filter function for include/exclude patterns
 *
 * Uses picomatch for fast glob matching. Exclude patterns are applied after include.
 *
 * @param options - Pattern filter options
 * @returns Filter function (returns true if file should be included)
 */
export function createPatternFilter(
  options: PatternFilterOptions
): (filePath: string) => boolean {
  const { include, exclude } = options;

  // Compile patterns once for performance
  // Use { contains: true } to match paths containing patterns (e.g., 'node_modules' matches 'path/node_modules/file')
  const includeMatcher = include?.length
    ? picomatch(include, { contains: true })
    : null;

  const excludeMatcher = exclude?.length
    ? picomatch(exclude, { contains: true })
    : null;

  return (filePath: string): boolean => {
    // If include patterns specified, file must match at least one
    if (includeMatcher && !includeMatcher(filePath)) {
      return false;
    }

    // If exclude patterns specified, file must not match any
    if (excludeMatcher?.(filePath)) {
      return false;
    }

    return true;
  };
}
