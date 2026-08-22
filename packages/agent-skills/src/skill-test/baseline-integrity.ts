import { protectedEnvNames } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

/**
 * Baseline-integrity detection for the skill-absent (WITHOUT) arm of a
 * `--baseline` run.
 *
 * WHY THIS EXISTS. `--baseline` withholds the skill's *declaration* from the
 * control arm (`pluginDirs: []` plus `--setting-sources ""`), which removes
 * DISCOVERY but not CAPABILITY: the executor runs with unrestricted Bash under
 * `--permission-mode bypassPermissions`, so any copy of the skill still on the
 * filesystem is reachable. vat no longer ESCORTS the control arm to its own staged
 * copies — the prompt does not name the staged subject, the arm's cwd is a per-arm
 * per-eval workspace outside the harness root, `pluginDirs` is empty, and the env is
 * scrubbed — but "not escorted" is not "cannot reach", and three classes of copy
 * remain reachable by an arm that goes looking:
 *
 *   1. the adopter's own repo / build output,
 *   2. the user's installed plugin cache, and
 *   3. vat's OWN staged tree, which is a sibling of the arm's cwd under the shared
 *      OS temp dir. `resolveHarnessRoot` derives `<tmp>/vat-skill-test/<name>-<hash8>`
 *      with no random token, so `ls ../..` reaches it and a `*` glob makes the hash
 *      irrelevant. Closing this needs a per-run random token on the harness root, and
 *      is NOT done — which is why the harness-directory needle below exists.
 *
 * Do not restore a claim here that vat's copies are out of reach. They are one
 * directory climb away, the detector is what covers them, and an overstated comment
 * is how the last two rounds of this fix each shipped believing they were finished.
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
 *   - **Case.** Folded UNCONDITIONALLY, not just on win32. Windows is the obvious
 *     case-insensitive filesystem, but macOS ships case-insensitive APFS/HFS+ by
 *     default, so `cat /PRIVATE/VAR/…/VAT-SKILL-TEST/…/SKILL.md` succeeds there and
 *     read as clean while the win32-gated fold was in force. Case-folding both
 *     sides cannot create a false positive that the path-boundary match would not
 *     already have rejected, so there is no cost to paying it everywhere.
 *
 * 8.3 short names (`VAT-SK~1`) are NOT handled — neither here nor, contrary to what
 * this comment used to claim, by {@link harnessNeedles}, whose segments are all
 * longer than 8 characters and are therefore exactly what Windows shortens.
 */
function normalizeForMatch(value: string): string {
  return value.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/').toLowerCase();
}

/** The directory name VAT puts every harness root under. See {@link harnessNeedles}. */
const VAT_HARNESS_DIR_NAME = 'vat-skill-test';

/**
 * Shortest needle we will match on. Below this a needle stops being evidence and
 * starts being noise: `--out /tmp/out` yields the suffix `tmp/out`, which fires on
 * `/tmp/output.csv` in a transcript that never went near the harness.
 */
const MIN_NEEDLE_LENGTH = 8;

/**
 * The needles that mean "this transcript reached VAT's staged copies".
 *
 * Three, in longest-first order, and every one of them is matched at a PATH
 * BOUNDARY (see {@link containsPathAtBoundary}) rather than by bare substring:
 *
 *   1. the full normalized root;
 *   2. its last two path segments — the load-bearing one for a RELATIVE reach.
 *      The control arm's cwd and the harness root are siblings under the OS temp
 *      dir, so `cat ../../vat-skill-test/<key>/staged/…` never contains the
 *      absolute root. The suffix also survives an 8.3-short-named or
 *      differently-realpathed prefix (macOS `$TMPDIR` is `/var/folders/…` while
 *      VAT derives `/private/var/folders/…`);
 *   3. VAT's own harness directory NAME, when the root is actually under one.
 *
 * Needle 3 exists because needles 1 and 2 both require the arm to spell the 8-hex
 * harness key — which it has no way to know and no reason to type. Every natural
 * reach enumerates instead: `cat ../../vat-skill-test/&#42;/staged/SKILL.md`,
 * `find ../../vat-skill-test -name SKILL.md`, or `K=$(ls ../../vat-skill-test)`.
 * One `&#42;` defeated the entire suffix scheme. The boundary match is what keeps
 * needle 3 honest: the control arm's OWN legitimate cwd is
 * `vat-skill-test-ws-<token>/…`, where the next character is `-` rather than `/`,
 * so it is not a hit — which is the constraint any change here must preserve.
 *
 * A root too short or too generic to be evidence (`--out /`, `--out /tmp/out`)
 * yields NO harness needle rather than one that fires on every run.
 */
export function harnessNeedles(harnessRoot: string): string[] {
  const normalized = normalizeForMatch(harnessRoot);
  if (normalized === '') return [];
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  const needles: string[] = [];
  if (normalized.length >= MIN_NEEDLE_LENGTH) needles.push(normalized);
  if (segments.length >= 2) {
    const suffix = segments.slice(-2).join('/');
    if (suffix.length >= MIN_NEEDLE_LENGTH) needles.push(suffix);
  }
  const vatDir = normalizeForMatch(VAT_HARNESS_DIR_NAME);
  if (segments.includes(vatDir)) needles.push(vatDir);
  return needles;
}

/**
 * Does `value` contain `needle` as a whole PATH PREFIX — i.e. ending at a `/` or at
 * the end of the string, never mid-segment?
 *
 * A bare `includes` over-matches in exactly the layout VAT ships: the default
 * harness root `<tmp>/vat-skill-test/<key>` is a string prefix of the workspaces
 * root `<tmp>/vat-skill-test-ws-<token>`, so `--out <tmp>/vat-skill-test` made every
 * `${fixturesDir}` value look like a harness leak and stripped the control arm's own
 * declared input files. It also made a `--out /tmp/out` needle fire on `/tmp/output.csv`.
 * Both directions of that error are expensive, so the boundary is not optional.
 */
/**
 * Characters that CONTINUE a path segment. A needle followed by one of these
 * matched mid-name and is not evidence; a needle followed by anything else (`/`,
 * whitespace, a quote, end of string) ended where we said it did.
 *
 * Hyphen is the load-bearing member: VAT's own `vat-skill-test-ws-<token>` — the
 * control arm's LEGITIMATE workspace — shares a prefix with the `vat-skill-test`
 * needle, and it is the `-` that must disqualify it. Whitespace must NOT be in
 * this set: `find ../../vat-skill-test -name SKILL.md` and `ls -R ../../vat-skill-test`
 * are real reaches that end the path at a space.
 */
const PATH_SEGMENT_CONTINUATION = /[\w-]/;

function indexOfPathAtBoundary(haystack: string, needle: string): number {
  if (needle === '') return -1;
  for (let from = 0; ; ) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    const nextChar = haystack.charAt(index + needle.length);
    if (nextChar === '' || !PATH_SEGMENT_CONTINUATION.test(nextChar)) return index;
    from = index + 1;
  }
}

function containsPathAtBoundary(haystack: string, needle: string): boolean {
  return indexOfPathAtBoundary(haystack, needle) !== -1;
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
 * ever knows about the leaks already found. It is accident-catching HYGIENE, not an
 * adversarial control — a determined skill author splits the path across two vars
 * (`A=/tmp/vat-skill-test` + `B=/<key>/…`) and the per-value scan never joins them.
 * The adversarial control is that the path is not REACHABLE, not that it is unnamed.
 *
 * Rule 2 exempts {@link protectedEnvNames}. Those are the vars a child cannot run
 * without — `PATH`, `HOME`, `TMPDIR` — and an `--out` under any of their values (e.g.
 * `--out .` from a repo root, which puts `<repo>/node_modules/.bin` on PATH inside a
 * `bun run`) would otherwise spawn the control arm with no PATH at all. That does not
 * fail; it DEGRADES the control, which scores lower, which reports as skill lift. A
 * scrub that manufactures the very delta the product sells is worse than the leak it
 * closes, so a protected var that names the harness root is RETAINED and reported
 * loudly instead — the operator can see it and move `--out`.
 *
 * `${fixturesDir}` resolves under the WORKSPACES root, not the harness root, so the
 * control arm keeps its declared input files — the arms stay identical in
 * everything except the skill itself.
 *
 * Pure. Returns the scrubbed env, the names dropped, and the protected names retained
 * despite naming the harness root — all three for the transparency line.
 */
export function scrubControlArmEnv(
  env: NodeJS.ProcessEnv,
  harnessRoot: string,
): { env: NodeJS.ProcessEnv; dropped: string[]; retainedLeaks: string[] } {
  const needle = normalizeForMatch(harnessRoot);
  const protectedNames = protectedEnvNames();
  const scrubbed: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  const retainedLeaks: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const forbiddenKey = (CONTROL_ARM_FORBIDDEN_ENV_KEYS as readonly string[]).includes(key);
    const leaksPath =
      typeof value === 'string' && containsPathAtBoundary(normalizeForMatch(value), needle);
    if (leaksPath && !forbiddenKey && protectedNames.has(key)) {
      retainedLeaks.push(key);
      scrubbed[key] = value;
      continue;
    }
    if (forbiddenKey || leaksPath) {
      dropped.push(key);
      continue;
    }
    scrubbed[key] = value;
  }

  return { env: scrubbed, dropped, retainedLeaks };
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

  // First needle wins: the needles run longest-first (full root, suffix, VAT's own
  // dir name), so one reach is reported once, at the most specific spelling that
  // matched. Boundary-matched, so a needle never fires mid-segment — see
  // containsPathAtBoundary for the two live false positives that required.
  for (const needle of harnessNeedles(input.harnessRoot)) {
    const index = indexOfPathAtBoundary(haystack, needle);
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
