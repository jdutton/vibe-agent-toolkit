/**
 * The finding shape every repository-structure rule produces.
 *
 * Split out of `validate-repo-structure.ts` so rule modules can produce
 * findings without importing the gate that runs them — the gate imports the
 * rules, and a type that lived in the gate would make every rule module a
 * cycle waiting to happen.
 */

/** Validation error type constants. */
export const ERROR_TYPES = {
  DANGLING_CITATION: 'dangling-citation',
  DERIVED_ARTIFACT_STALE: 'derived-artifact-stale',
  FORBIDDEN_DIRECTORY: 'forbidden-directory',
  LARGE_FILE: 'large-file',
  SEVERITY_COUNTS: 'severity-counts',
  STALE_VENDOR_CLAIM: 'stale-vendor-claim',
  STRUCTURAL_VIOLATION: 'structural-violation',
} as const;

/** One finding of the structure gate. */
export interface ValidationError {
  type: (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];
  path: string;
  message: string;
  severity: 'error' | 'warning';
}
