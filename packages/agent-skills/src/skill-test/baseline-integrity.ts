import { z } from 'zod';

/**
 * Baseline-integrity detection for the skill-absent (WITHOUT) arm of a
 * `--baseline` run.
 *
 * WHY THIS EXISTS. `--baseline` withholds the skill's *declaration* from the
 * control arm (`pluginDirs: []` plus `--setting-sources ""`), which removes
 * DISCOVERY but not CAPABILITY: the executor runs with unrestricted Bash under
 * `--permission-mode bypassPermissions`, so any copy of the skill still on the
 * filesystem is reachable. vat now keeps its OWN copies out of the control arm's
 * reach (the prompt no longer names the staged subject, and the arm's cwd is a
 * per-eval workspace outside the harness root), but two classes of copy remain
 * that vat did not create and cannot remove:
 *
 *   1. the adopter's own repo / build output, and
 *   2. the user's installed plugin cache.
 *
 * A control arm that reaches either of those answers from the skill's own tool
 * and the reported delta stops being a measure of skill lift — silently, with a
 * well-formed `baseline.json` and exit 0. That silence is the actual defect: a
 * measurement that is quietly wrong is worse than one that is missing, because
 * it gets believed, written down, and acted on.
 *
 * So this module does not try to PREVENT contamination (it cannot, for the two
 * classes above). It DETECTS it and makes it loud.
 */

/** One piece of evidence that the skill-absent arm reached the skill anyway. */
export const BaselineContaminationHitSchema = z.object({
  /** What matched: a path under vat's harness root, or a declared executable's name. */
  kind: z.enum(['harness-path', 'declared-executable']),
  /** The matched token — the path prefix or the executable basename. */
  match: z.string().min(1),
  /** A short, redacted excerpt of the transcript around the match, for triage. */
  excerpt: z.string(),
}).strict();

export type BaselineContaminationHit = z.infer<typeof BaselineContaminationHitSchema>;

/** Per-eval contamination finding for the WITHOUT arm. */
export const BaselineContaminationSchema = z.object({
  evalId: z.string().min(1),
  hits: z.array(BaselineContaminationHitSchema).min(1),
}).strict();

export type BaselineContamination = z.infer<typeof BaselineContaminationSchema>;

/**
 * The run-level `baselineIntegrity` block stamped into `baseline.json`.
 *
 * `contaminated: true` means at least one WITHOUT-arm eval demonstrably reached
 * the skill; the A/B delta for the run is then NOT interpretable as skill lift.
 * The block is written on EVERY baseline run, clean or not, so its absence
 * always means "this baseline.json predates integrity checking" and never
 * "checked and clean".
 */
export const BaselineIntegritySchema = z.object({
  contaminated: z.boolean(),
  /** Human-readable verdict, safe to print verbatim. */
  summary: z.string().min(1),
  findings: z.array(BaselineContaminationSchema),
}).strict();

export type BaselineIntegrity = z.infer<typeof BaselineIntegritySchema>;

/** Characters of transcript to keep either side of a match in an excerpt. */
const EXCERPT_RADIUS = 60;

/**
 * A short excerpt around the first occurrence of `token`, collapsed to one line.
 * Bounded so a huge tool result cannot bloat `baseline.json`.
 */
function excerptAround(haystack: string, index: number, tokenLength: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(haystack.length, index + tokenLength + EXCERPT_RADIUS);
  const slice = haystack.slice(start, end).replaceAll(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < haystack.length ? '…' : ''}`;
}

export interface DetectBaselineContaminationInput {
  /** The WITHOUT arm's captured stream-json transcript. */
  transcript: string;
  /**
   * vat's harness root. Any mention of it in the control arm's transcript means
   * the arm reached into vat's own staged trees — which, now that neither the
   * prompt nor the cwd points there, it could only do by going looking.
   */
  harnessRoot: string;
  /**
   * Stable names of the skill's declared executables — the basename with the
   * extension stripped (`scripts/csvsum.py` → `csvsum`), as derived by
   * `deriveDeclaredExecutableNames`.
   */
  executableNames?: readonly string[];
}

/**
 * Shortest executable name worth matching. A one- or two-character name
 * (`x`, `go`) occurs constantly in ordinary prose and JSON and would fire on
 * every run; below this length the check is pure noise, so it is skipped and
 * detection falls back to the harness-path signal.
 */
const MIN_EXECUTABLE_NAME_LENGTH = 3;

/**
 * Scan the skill-absent arm's transcript for proof it reached the skill.
 *
 * Deliberately a raw-text scan rather than a structured walk of the stream-json
 * events: the evidence we care about (an absolute path in a Bash command, a tool
 * result quoting the bundle's output) shows up in several different event
 * shapes, and a scan cannot be defeated by an event type we failed to enumerate.
 * The cost of the looser match is a possible false POSITIVE, which produces a
 * warning the operator can dismiss — the right direction to err for a check
 * whose entire purpose is to stop a wrong number from being believed.
 *
 * Pure + unit-testable. Returns hits in a stable order (harness paths first,
 * then executables in declared order), at most one per distinct token.
 */
export function detectBaselineContamination(
  input: DetectBaselineContaminationInput,
): BaselineContaminationHit[] {
  const hits: BaselineContaminationHit[] = [];

  const harnessIndex = input.transcript.indexOf(input.harnessRoot);
  if (harnessIndex !== -1) {
    hits.push({
      kind: 'harness-path',
      match: input.harnessRoot,
      excerpt: excerptAround(input.transcript, harnessIndex, input.harnessRoot.length),
    });
  }

  for (const name of input.executableNames ?? []) {
    if (name.length < MIN_EXECUTABLE_NAME_LENGTH) continue;
    const index = input.transcript.indexOf(name);
    if (index === -1) continue;
    // A declared executable found via a harness path is already reported by the
    // hit above; recording it again would double-count one reach as two.
    if (harnessIndex !== -1 && hits.some(h => h.excerpt.includes(name))) continue;
    hits.push({
      kind: 'declared-executable',
      match: name,
      excerpt: excerptAround(input.transcript, index, name.length),
    });
  }

  return hits;
}

/**
 * Assemble the run-level integrity block from every WITHOUT-arm eval's findings.
 * `findings` is empty on a clean run — the block is still emitted, with
 * `contaminated: false`, so "checked and clean" is distinguishable from
 * "never checked".
 */
export function summarizeBaselineIntegrity(findings: BaselineContamination[]): BaselineIntegrity {
  if (findings.length === 0) {
    return {
      contaminated: false,
      summary:
        'No skill-absent eval was observed reaching the skill. The A/B delta is interpretable as instruction lift ' +
        '(note: both arms still share a filesystem — this is not a capability control).',
      findings: [],
    };
  }
  const ids = findings.map(f => f.evalId).join(', ');
  return {
    contaminated: true,
    summary:
      `BASELINE CONTAMINATED: the skill-absent arm reached the skill in ${findings.length} eval(s) [${ids}]. ` +
      'The reported delta is NOT a measure of skill lift — the control arm had the treatment. ' +
      'Most likely an ambient copy of the skill in this repo\'s build output or the installed plugin cache.',
    findings,
  };
}
