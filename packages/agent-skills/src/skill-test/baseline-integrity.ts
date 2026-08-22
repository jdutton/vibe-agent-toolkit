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

/**
 * Fold a path (or a haystack containing paths) into ONE comparable spelling.
 *
 * Three real divergences make a raw `indexOf` of an absolute path useless:
 *   - **Windows separators.** `safePath.join` forward-slashes every path VAT
 *     derives, while a child's output is backslashed — and inside stream-json
 *     those backslashes are ESCAPED, so the raw transcript holds `\\`. Folding
 *     backslashes to `/` therefore yields `//`, which still would not match a
 *     single-slash needle; the run-collapse is what closes that, and is why
 *     excerpts are taken from the NORMALIZED haystack (this step does not
 *     preserve length, so an index into it does not address the original).
 *   - **Windows case.** Paths are case-insensitive there; the child may echo a
 *     different case than we derived.
 *   - **8.3 short names** (`RUNNER~1`) — not folded here; the suffix matching in
 *     {@link harnessNeedles} is what survives those.
 */
function normalizeForMatch(value: string): string {
  const forward = value.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/**
 * The needles that mean "this transcript reached VAT's staged copies".
 *
 * Returns the full normalized root AND its last two path segments. The suffix is
 * the load-bearing one: the control arm's cwd and the harness root are siblings
 * under the OS temp dir, so the natural reach is RELATIVE
 * (`cat ../vat-skill-test/<key>/staged/...`) and the absolute root never appears in
 * the transcript at all. The suffix also survives an 8.3-short-named or
 * differently-realpathed prefix (macOS `$TMPDIR` is `/var/folders/…` while VAT
 * derives `/private/var/folders/…`), which is the difference between a detector
 * that works on one platform and one that works everywhere.
 *
 * Two segments, not one: a bare basename like `harness` under a custom `--out` is
 * too generic to be evidence of anything.
 */
export function harnessNeedles(harnessRoot: string): string[] {
  const normalized = normalizeForMatch(harnessRoot);
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  const needles = normalized === '' ? [] : [normalized];
  if (segments.length >= 2) needles.push(segments.slice(-2).join('/'));
  return needles;
}

/**
 * Env keys the control arm must never receive, regardless of value.
 *
 * `CLAUDE_PLUGIN_ROOT` points at the staged plugin root — inside the harness root,
 * holding the SKILL.md and every executable the skill ships. It is meaningless in
 * an arm spawned with `pluginDirs: []`, so withholding it costs the measurement
 * nothing and closes a channel that one `env | grep` turns into the whole treatment.
 */
const CONTROL_ARM_FORBIDDEN_ENV_KEYS = ['CLAUDE_PLUGIN_ROOT'] as const;

/**
 * Strip every channel by which the executor ENVIRONMENT would tell the skill-absent
 * arm where the skill is staged.
 *
 * A path reaches a child process through four channels — prompt, argv, cwd, and
 * env. The first three are handled at the call site; this is the fourth, and it is
 * the one that is easy to miss because nothing at the spawn call mentions it: the
 * run assembles ONE env and both arms were given it verbatim.
 *
 * Two rules, deliberately in this order:
 *   1. drop {@link CONTROL_ARM_FORBIDDEN_ENV_KEYS} by name;
 *   2. drop ANY entry whose value contains the harness root — which covers
 *      adopter-declared `env:` values that interpolated `${stagedSkillDir}` or
 *      `${harnessRoot}`, and, more importantly, covers the next such channel
 *      somebody adds without knowing this function exists.
 *
 * Rule 2 is a value scan rather than a longer key list on purpose: a key list only
 * ever knows about the leaks already found.
 *
 * `${fixturesDir}` resolves under the WORKSPACES root, not the harness root, so the
 * control arm keeps its declared input files — the arms stay identical in
 * everything except the skill itself.
 *
 * Pure. Returns the scrubbed env plus the names dropped, for the transparency line.
 */
export function scrubControlArmEnv(
  env: NodeJS.ProcessEnv,
  harnessRoot: string,
): { env: NodeJS.ProcessEnv; dropped: string[] } {
  const needle = normalizeForMatch(harnessRoot);
  const scrubbed: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const forbiddenKey = (CONTROL_ARM_FORBIDDEN_ENV_KEYS as readonly string[]).includes(key);
    const leaksPath = typeof value === 'string' && needle !== '' && normalizeForMatch(value).includes(needle);
    if (forbiddenKey || leaksPath) {
      dropped.push(key);
      continue;
    }
    scrubbed[key] = value;
  }

  return { env: scrubbed, dropped };
}

/** One piece of evidence that the skill-absent arm reached the skill anyway. */
export const BaselineContaminationHitSchema = z.object({
  /** What matched: a path under vat's harness root, or a declared executable's name. */
  kind: z.enum(['harness-path', 'declared-executable']),
  /** The matched token — the path prefix or the executable basename. */
  match: z.string().min(1),
  /**
   * A short excerpt of the transcript around the match, for triage.
   *
   * NOT redacted — it is raw transcript, bounded and whitespace-collapsed. The
   * most likely way a harness path reaches a transcript is an `env` dump, so this
   * window can capture adjacent environment values, and `baseline.json` is a file
   * adopters attach to reports. Treat it as sensitive; `grading.json` already
   * quotes transcripts verbatim, so this is the same exposure, not a new one.
   */
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
 * Match an executable name only where it is being INVOKED or pointed at, never as
 * a bare word.
 *
 * `deriveDeclaredExecutableNames` strips the extension, so `scripts/summary.py`
 * becomes the needle `summary` — a word that appears in ordinary assistant prose
 * on almost every run. A bare `indexOf` therefore reports `contaminated: true` on
 * clean runs, and the operator instruction attached to that verdict is "discard
 * the delta". A check that routinely destroys good runs trains people to ignore
 * the one warning that matters, so a false positive here is NOT the safe
 * direction — it is a different way to lose the measurement.
 *
 * Two accepted forms, both of which mean the name is a FILE:
 *   - preceded by a path separator: `scripts/summary`, `./summary`
 *   - followed by an extension: `summary.py`, `summary.mjs`
 */
function executableInvocationPattern(name: string): RegExp {
  // Every regex metacharacter in `name` is escaped first, so the constructed
  // source is a literal match for an adopter-declared basename and cannot inject
  // pattern syntax. `name` also has no user-controlled quantifier, so this is not
  // a ReDoS surface.
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // eslint-disable-next-line security/detect-non-literal-regexp -- source is built from the escaped literal above
  return new RegExp(String.raw`(?:[/\\]${escaped}(?![\w-])|\b${escaped}\.[A-Za-z0-9]+)`);
}

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
 * Both sides are folded through {@link normalizeForMatch} before comparing, and
 * the harness signal matches {@link harnessNeedles} rather than one literal
 * spelling — without that, the check is dead on Windows (separator direction),
 * roughly a coin-flip on macOS (`$TMPDIR` vs the realpath), and blind to a
 * relative reach on every platform. Excerpts are taken from the NORMALIZED
 * haystack so a reported index always addresses the text that matched.
 *
 * Pure + unit-testable. Returns hits in a stable order (harness paths first,
 * then executables in declared order), at most one per distinct token.
 */
export function detectBaselineContamination(
  input: DetectBaselineContaminationInput,
): BaselineContaminationHit[] {
  const hits: BaselineContaminationHit[] = [];
  const haystack = normalizeForMatch(input.transcript);

  // First needle wins: the needles run longest-first (full root, then suffix), so
  // one reach is reported once, at the most specific spelling that matched.
  for (const needle of harnessNeedles(input.harnessRoot)) {
    const index = haystack.indexOf(needle);
    if (index === -1) continue;
    hits.push({
      kind: 'harness-path',
      match: needle,
      excerpt: excerptAround(haystack, index, needle.length),
    });
    break;
  }

  const harnessHit = hits.length > 0;
  for (const name of input.executableNames ?? []) {
    if (name.length < MIN_EXECUTABLE_NAME_LENGTH) continue;
    const match = executableInvocationPattern(normalizeForMatch(name)).exec(haystack);
    if (match === null) continue;
    // A declared executable found via a harness path is already reported by the
    // hit above; recording it again would double-count one reach as two.
    if (harnessHit && hits.some(h => h.excerpt.includes(name))) continue;
    hits.push({
      kind: 'declared-executable',
      match: name,
      excerpt: excerptAround(haystack, match.index, match[0].length),
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
