/**
 * Unified validation issue type.
 *
 * `ValidationIssue` is the single shape every VAT validator emits. Its `code`
 * spans the FULL code space: registry codes (overridable via config), plus
 * `InfoCode` and `NonOverridableCode` (structural reports / prerequisites that
 * bypass the severity-override framework).
 */

import { z } from 'zod';

import {
  CODE_REGISTRY,
  type InfoCode,
  type IssueCode,
  type IssueSeverity,
  type NonOverridableCode,
} from './validation-codes.js';

/** Full code space: registry codes (overridable) + info codes + structural/non-overridable codes. */
export type ValidationIssueCode = IssueCode | InfoCode | NonOverridableCode;

export const ValidationIssueSchema = z.object({
  code: z.string(),                                  // full code space; narrowed in the TS type below
  severity: z.enum(['error', 'warning', 'info', 'ignore']),
  message: z.string(),
  location: z.string().optional(),
  line: z.number().int().positive().optional(),
  link: z.string().optional(),
  fix: z.string().optional(),
  reference: z.string().optional(),
  suggestion: z.string().optional(),
}).strict();

// Schema validates structure; the TS type narrows code+severity and uses exact
// optional properties (no `| undefined`) to match how validators construct issues
// under `exactOptionalPropertyTypes`.
export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: IssueSeverity;
  message: string;
  location?: string;
  line?: number;
  link?: string;
  fix?: string;
  reference?: string;
  suggestion?: string;
}

/** Build an issue from the registry, filling severity/fix/reference from the code entry. */
export function createRegistryIssue(
  code: IssueCode,
  message: string,
  extras: Partial<Pick<ValidationIssue, 'location' | 'line' | 'link' | 'suggestion'>> = {},
): ValidationIssue {
  const e = CODE_REGISTRY[code];
  return { code, severity: e.defaultSeverity, message, fix: e.fix, reference: e.reference, ...extras };
}
