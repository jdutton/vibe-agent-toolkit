import { isProtectedName, protectedEnvNames } from '@vibe-agent-toolkit/utils';
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

// A `MIN_NEEDLE_LENGTH = 8` floor lived here and has been REMOVED. Its stated
// rationale — that `--out /tmp/out` would otherwise fire on `/tmp/output.csv` — was
// already false when it was written: the path-boundary match added in the SAME
// commit rejects that (`t` continues the segment). It was belt over braces, and the
// braces were harmful. It silently produced ZERO needles for any root under 8 chars,
// so `--out /tmp/x` disabled the harness-path detector entirely and an absolute
// reach straight into `<root>/staged/<skill>/SKILL.md` reported clean; a root whose
// last two segments were short lost the suffix needle, silencing every relative
// reach. Silent "clean" is the one failure this whole module exists to prevent.
// Do not reintroduce a length floor without a `degraded` signal on the verdict.

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
 * Needle 3 additionally requires a LEADING `/` (see {@link needsLeadingBoundary}),
 * without which `ls` of the temp dir stamps every clean run contaminated.
 */
/**
 * Split an ALREADY-NORMALIZED path into its meaningful segments.
 *
 * The `no-hardcoded-path-split` rule exists because splitting a raw path on `/`
 * breaks on Windows — but every caller here passes the output of
 * {@link normalizeForMatch}, which has already folded `\` to `/`. That is the
 * whole point of this module: it compares one canonical spelling, and a
 * `basename()` would reintroduce the platform separator the normalizer removed.
 */
const normalizedSegments = (normalized: string): string[] =>
  normalized.split('/').filter((s) => s !== '' && s !== '.');

export function harnessNeedles(harnessRoot: string): string[] {
  const normalized = normalizeForMatch(harnessRoot);
  if (normalized === '') return [];
  const segments = normalizedSegments(normalized);
  const needles: string[] = [normalized];
  if (segments.length >= 2) needles.push(segments.slice(-2).join('/'));
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

/**
 * Does this needle also require a `/` immediately BEFORE it?
 *
 * For a bare directory-NAME needle (one with no separator of its own, i.e.
 * `vat-skill-test`), yes — and it is not optional. Without it, `ls` of the OS temp
 * dir stamps `contaminated: true` on a completely clean run: the arm's cwd is
 * `<tmp>/vat-skill-test-ws-<token>/…`, so `ls ../../..` prints `vat-skill-test` on
 * its own line, and a NEWLINE is not in {@link PATH_SEGMENT_CONTINUATION}, so the
 * trailing boundary happily accepts it. "Where am I, what's around me" is the most
 * common opening move an agent makes in an empty scratch directory — the arm saw a
 * directory NAME, it did not read the skill, and the instruction attached to that
 * verdict is "discard the delta".
 *
 * A leading `/` costs no real detection: every genuine reach carries one
 * (`../../vat-skill-test/…`, `find ../../vat-skill-test`, `$TMPDIR/vat-skill-test`,
 * and even `cd ../../vat-skill-test`, which keeps its preceding slash without a
 * trailing one). A bare basename in a listing does not. The same rule stops this
 * repo's own source and CHANGELOG — ~10 tracked files carry the literal — from
 * firing when vat is dogfooded on itself.
 *
 * Needles 1 and 2 already contain a separator, so this returns false for them and
 * their existing behavior is unchanged.
 */
function needsLeadingBoundary(needle: string): boolean {
  return !needle.includes('/');
}

// A `prefixNeedle` mode lived here — needles ending in `-` skipping the TRAILING
// boundary check, so `vat-skill-evals-` could match with the run's token still
// attached. It is REMOVED: nothing needed it. The reach it was written for is
// `cat $TMPDIR/vat-skill-evals-*/evals.json`, and `*` is not in
// PATH_SEGMENT_CONTINUATION, so the ORDINARY trailing check already accepts it;
// every reach carrying the real token matches the full-path or whole-name needle
// first. Proven by mutation: disabling the mode left all 53 tests green, which is
// the definition of a special case nobody is standing on. See the MIN_NEEDLE_LENGTH
// note above for the same lesson, and do not reintroduce this without a reach that
// ONLY it can catch.

function indexOfPathAtBoundary(haystack: string, needle: string): number {
  if (needle === '') return -1;
  const requireLeading = needsLeadingBoundary(needle);
  for (let from = 0; ; ) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    const nextChar = haystack.charAt(index + needle.length);
    const trailingOk = nextChar === '' || !PATH_SEGMENT_CONTINUATION.test(nextChar);
    const leadingOk = !requireLeading || (index > 0 && haystack.charAt(index - 1) === '/');
    if (trailingOk && leadingOk) return index;
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
 * Rule 2 exempts {@link protectedEnvNames}, which is WIDER than the three names the
 * paragraph below uses as its example: it is every process essential, the auth
 * allowlist, every inference credential, the whole `CREDENTIAL_ROUTING_DENY` list,
 * AND this run's `modelVars`. The model vars are the ones that matter most here and
 * were missing until they were threaded in: dropping a model var because its value
 * happens to sit under `--out` runs the control arm ON A DIFFERENT MODEL, which is
 * a far worse confound than the missing PATH this exemption exists to prevent, and
 * one no operator would think to look for.
 *
 * The three named below are the illustration. An `--out` under any of their values (e.g.
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
 * Pure. Returns the scrubbed env and three disjoint name lists for the transparency
 * lines: the rule-1 drops, the rule-2 drops, and the protected names RETAINED
 * despite naming the harness root.
 *
 * The two drop lists are separate because they mean opposite things to an operator.
 * A rule-1 drop is routine — `CLAUDE_PLUGIN_ROOT` is withheld on every plugin-layout
 * baseline run by design, and its value may name nothing in the harness at all (the
 * installed-plugin-cache case). A rule-2 drop says the operator's OWN declared `env:`
 * named the harness root, which is the one worth acting on. Merged into one list under
 * one "naming the harness root" sentence, the routine drop was both mislabelled and
 * loud enough to bury the interesting one.
 */
export function scrubControlArmEnv(
  env: NodeJS.ProcessEnv,
  harnessRoot: string,
  /**
   * This run's model env var names. REQUIRED, not defaulted: an omitted list
   * silently narrows the exemption set, and the var it drops decides which model
   * the control arm runs — a defect that reads as skill lift and is invisible in
   * the output. Pass `[]` when the run genuinely has none.
   */
  modelVars: readonly string[],
): {
  env: NodeJS.ProcessEnv;
  /** Rule 1: dropped by NAME, whatever the value. */
  droppedForbiddenKey: string[];
  /** Rule 2: dropped because the VALUE names the harness root. */
  droppedNamingRoot: string[];
  retainedLeaks: string[];
} {
  const needle = normalizeForMatch(harnessRoot);
  const protectedNames = protectedEnvNames(modelVars);
  const scrubbed: NodeJS.ProcessEnv = {};
  const droppedForbiddenKey: string[] = [];
  const droppedNamingRoot: string[] = [];
  const retainedLeaks: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const forbiddenKey = (CONTROL_ARM_FORBIDDEN_ENV_KEYS as readonly string[]).includes(key);
    const leaksPath =
      typeof value === 'string' && containsPathAtBoundary(normalizeForMatch(value), needle);
    // `isProtectedName`, not `protectedNames.has`: on win32 env names are
    // case-insensitive, so a `Path` that names the harness root would miss the
    // exemption and be dropped — spawning the control arm with no PATH on the one
    // platform where the spelling varies.
    if (leaksPath && !forbiddenKey && isProtectedName(key, protectedNames)) {
      retainedLeaks.push(key);
      scrubbed[key] = value;
      continue;
    }
    // Rule 1 first, and it wins outright: a forbidden key is withheld whatever its
    // value, so reporting it as "its value named the harness root" would be a guess
    // that is wrong whenever the key points somewhere else entirely.
    if (forbiddenKey) {
      droppedForbiddenKey.push(key);
      continue;
    }
    if (leaksPath) {
      droppedNamingRoot.push(key);
      continue;
    }
    scrubbed[key] = value;
  }

  return { env: scrubbed, droppedForbiddenKey, droppedNamingRoot, retainedLeaks };
}

/** One piece of evidence that the skill-absent arm reached the skill anyway. */
/**
 * Every kind of contamination hit, which is also every DETECTOR — the two are
 * 1:1, so one list serves both (see {@link ContaminationSignalSchema}).
 */
const CONTAMINATION_KINDS = [
  'harness-path',
  'declared-executable',
  'sibling-arm',
  'vat-private-dir',
  'skill-content',
] as const;

/** Named so the push sites below do not restate the string literals. */
const KIND_HARNESS_PATH = 'harness-path';
const KIND_DECLARED_EXECUTABLE = 'declared-executable';
const KIND_SIBLING_ARM = 'sibling-arm';
const KIND_VAT_PRIVATE_DIR = 'vat-private-dir';
const KIND_SKILL_CONTENT = 'skill-content';

export const BaselineContaminationHitSchema = z.object({
  /**
   * What matched: a path under vat's harness root, a declared executable's name,
   * the OTHER arm's workspace directory, or one of vat's private tmp dirs.
   *
   * `sibling-arm` is a materially different finding from the first two. Those mean
   * the arm found a copy of the skill; this one means it read the treatment arm's
   * live working directory, so the control may be echoing an answer the treatment
   * produced seconds earlier rather than solving anything.
   *
   * `vat-private-dir` is worse than all of them. It means the arm reached the held
   * eval suite (the `expected_output` ANSWER KEY) or the grader dir (the run's
   * integrity nonce). Reaching a copy of the skill inflates the control arm;
   * reaching the answer key inflates BOTH arms, so it does not even show up as a
   * shrunken delta — see {@link vatPrivateDirNeedles}.
   */
  kind: z.enum(CONTAMINATION_KINDS),
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
/**
 * A detector that can be ARMED for a run.
 *
 * Deliberately the SAME enum as a hit's `kind`, not a parallel list: each
 * detector produces exactly one kind of hit, so two lists would be a drift
 * hazard for no expressive gain. Which detectors were armed is the difference
 * between "checked and clean" and "nothing was looking":
 *
 * - `harness-path` — vat's staged trees ({@link harnessNeedles}). Always armed.
 * - `sibling-arm` — the other arm's live workspace. Armed only when there is one.
 * - `vat-private-dir` — the held answer key and the grader dir
 *   ({@link vatPrivateDirNeedles}).
 * - `declared-executable` — the skill's executables by name. Armed ONLY for a
 *   skill that ships executables; an instruction-only skill (the common case)
 *   has no such name, so this signal is absent.
 * - `skill-content` — verbatim lines of the staged SKILL.md
 *   ({@link skillContentNeedles}). The one signal that does not need the arm to
 *   name a path or an executable, and therefore the only cover an
 *   instruction-only skill has. Unarmed when the body yields no line distinctive
 *   enough to accuse anyone with, which is itself worth seeing.
 */
export const ContaminationSignalSchema = BaselineContaminationHitSchema.shape.kind;

export type ContaminationSignal = z.infer<typeof ContaminationSignalSchema>;

/** One eval whose two arms were graded against a different number of expectations. */
export const BaselineArmSkewSchema = z.object({
  evalId: z.string().min(1),
  withTotal: z.number().int().nonnegative(),
  withoutTotal: z.number().int().nonnegative(),
}).strict();

export type BaselineArmSkew = z.infer<typeof BaselineArmSkewSchema>;

/** An eval's graded-expectation count on one arm, for the parity check. */
export interface ArmEvalCount {
  evalId: string;
  total: number;
}

/**
 * Evals whose two arms were graded against DIFFERENT numbers of expectations.
 *
 * `--baseline` sells a DELTA, and a delta between two differently-sized
 * denominators is not a delta. vat computes each arm's `summary` from the
 * fragments it received, so both reports are internally consistent by
 * construction and `reconcileGrading` cannot see this — a grader that emitted 2
 * entries for a 3-expectation eval on the control arm yields
 * `baseline.summary = {passed:2,total:2}`, which reads as **100% without the
 * skill**. That is the most damaging direction the number can be wrong in: it
 * says the skill did nothing.
 *
 * Both directions count, and so does an eval graded on only one arm — the missing
 * side is reported as 0 rather than dropped, since a silently absent eval skews
 * the run total exactly as a short-graded one does.
 *
 * A stronger cousin exists and is NOT here: comparing each arm's count against the
 * number of expectations the eval DECLARED, which would also catch a WITH arm
 * grading short. It needs the suite threaded into the merge, and it does not
 * protect the delta any better than parity does — parity is what the two arms
 * being comparable actually means.
 */
export function armExpectationSkew(
  withArm: readonly ArmEvalCount[],
  withoutArm: readonly ArmEvalCount[],
): BaselineArmSkew[] {
  const withoutById = new Map(withoutArm.map((c) => [c.evalId, c.total]));
  const skew: BaselineArmSkew[] = [];

  for (const { evalId, total } of withArm) {
    const withoutTotal = withoutById.get(evalId) ?? 0;
    if (withoutTotal !== total) skew.push({ evalId, withTotal: total, withoutTotal });
  }
  // Evals the control arm graded and the treatment did not. Same disease, other
  // direction, and invisible to the loop above.
  const withIds = new Set(withArm.map((c) => c.evalId));
  for (const { evalId, total } of withoutArm) {
    if (!withIds.has(evalId)) skew.push({ evalId, withTotal: 0, withoutTotal: total });
  }
  return skew;
}

export const BaselineIntegritySchema = z.object({
  contaminated: z.boolean(),
  /**
   * Whether the two arms were graded against the same expectations, and so
   * whether subtracting one summary from the other means anything.
   *
   * Separate from `contaminated` because they fail differently: contamination
   * says the control HAD the treatment, comparability says the two numbers were
   * never measuring the same thing. A run can be clean and incomparable.
   */
  comparable: z.boolean(),
  /** The evals behind a `comparable: false`; empty when the arms agree. */
  skew: z.array(BaselineArmSkewSchema),
  /** Human-readable verdict, safe to print verbatim. */
  summary: z.string().min(1),
  /**
   * Which detectors were ARMED for this run.
   *
   * Without it, `contaminated: false` is written identically whether four signals
   * were active or one, so a clean verdict cannot be told apart from a blind one
   * — and the difference is large: the executable-name signal is the only one
   * that sees an ambient copy of the skill in the adopter's own repo, and it does
   * not exist for a skill that ships no executables.
   *
   * An empty array is the loudest case: nothing was looking, and `contaminated`
   * says nothing at all.
   */
  signals: z.array(ContaminationSignalSchema),
  findings: z.array(BaselineContaminationSchema),
}).strict();

export type BaselineIntegrity = z.infer<typeof BaselineIntegritySchema>;

/** Characters of transcript to keep either side of a match in an excerpt. */
const EXCERPT_RADIUS = 60;

/**
 * A short excerpt around the first occurrence of `token`, collapsed to one line.
 * Bounded so a huge tool result cannot bloat `baseline.json`.
 *
 * ⚠️ KNOWN OPEN — nothing here is redacted, and two things leak. (1) The ±60 chars
 * are raw transcript: a hit inside an `env` dump has been observed carrying
 * `AWS_SECRET_ACCESS_KEY=…`, `GITHUB_TOKEN=ghp_…` and `HOME=/Users/<name>` into
 * `baseline.json` — the same values `formatForwardedEnvLine` bothers to mask on
 * stderr. (2) Needles run longest-first, so `match` on a full-path reach is the
 * entire absolute harness root, which on Windows is
 * `C:/Users/<username>/AppData/…` — putting the username in a field whose own
 * docstring carries no sensitivity note. Fix: mask `KEY=value` pairs here, and
 * report only the suffix needle in `match`.
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
  /**
   * The control arm's OWN workspace root, so a path under it is recognised as the
   * arm's own scratch file rather than a reach. The executor prompt states the
   * working directory absolutely, so the arm reuses that absolute path routinely;
   * without this every such mention would read as an escape.
   *
   * Absent → nothing is suppressed, which is the conservative direction for a
   * caller that has not threaded it: the check gets noisier, never blinder.
   */
  armWorkspaceDir?: string;
  /**
   * Verbatim lines lifted from the staged SKILL.md by {@link skillContentNeedles}
   * — the ONLY signal that sees an ambient copy of an instruction-only skill,
   * which ships nothing this module could match by name or path.
   */
  skillContentNeedles?: readonly string[];
  /**
   * The OTHER arm's workspace directory — for a skill-absent eval, the treatment
   * arm's live working directory.
   *
   * Not a path into vat's staged copies, so no harness needle can see it: the two
   * arm dirs are siblings under one workspaces root, and `existsSync` on
   * `../<sibling>/<id>/fixtures/input.md` from the control arm returns TRUE. Round 3
   * gave each arm its own directory, which stopped them writing over each other; it
   * did not stop one READING the other, and reading the treatment arm's output
   * mid-run lets the control score like the treatment while producing a transcript
   * with no harness path in it at all.
   *
   * Prevention is now the opaque per-arm token (the sibling's directory name is
   * unguessable and no longer spells `with`), so this is the detection half: if the
   * arm names it anyway — because it enumerated `..` — say so.
   *
   * The ABSOLUTE path to that directory; the needles are derived from it.
   */
  siblingArmDir?: string;
  /**
   * VAT's private tmp dirs for this run — the held eval suite (the answer key) and
   * the grader dir (the integrity nonce). Absolute paths; see
   * {@link vatPrivateDirNeedles} for why these need a detector of their own and
   * why the useful needle is a name PREFIX rather than the token.
   *
   * Never pass the workspaces root here: it is the arm's own legitimate cwd, and a
   * prefix needle built from it fires on every clean run.
   */
  vatPrivateDirs?: readonly (string | undefined)[];
}

/**
 * The needles that mean "this transcript named the OTHER arm's workspace".
 *
 * Two: the full path, and the bare per-arm token. The token is 16 hex characters
 * minted per run, so a boundary-anchored match on it is essentially free of false
 * positives — the arm's own token is different, and nothing else on the machine
 * spells it.
 *
 * The LEADING `/` requirement (via {@link needsLeadingBoundary}) is what keeps
 * `ls ..` honest: listing the parent prints the sibling's directory name as a bare
 * basename on its own line, which is "I looked around", not "I read the other arm".
 * Every genuine reach — `cat ../<token>/e1/out.md`, an absolute path, `find ..
 * -name '*.md'` printing `../<token>/…` — carries the slash.
 */
export function siblingArmNeedles(siblingArmDir: string): string[] {
  const full = normalizeForMatch(siblingArmDir);
  if (full === '') return [];
  const token = normalizedSegments(full).at(-1);
  // Longest first, so one reach is reported at its most specific spelling.
  return token === undefined || token === full ? [full] : [full, token];
}

/**
 * The needles that mean "this transcript reached a dir only VAT is supposed to
 * see" — the held eval suite (`<tmp>/vat-skill-evals-<token>`, which holds the
 * `expected_output` ANSWER KEY for a fetched-artifact subject) and the grader dir
 * (`<tmp>/vat-skill-grade-<token>`, which holds the run's integrity nonce).
 *
 * These are a FOURTH reachable class the harness-path detector cannot see: they
 * are siblings of the arm's cwd under the OS temp dir, contain no harness path,
 * and are two hops (`ls ../..`) or one `$TMPDIR` expansion away. Worse than
 * reaching the skill — reaching the answer key inflates BOTH arms, so it cannot
 * show up as a shrunken delta at all.
 *
 * Three needles, longest-first: the full path, the whole dir NAME, and the
 * dir-name prefix with the per-run token stripped (`vat-skill-evals-`).
 *
 * The prefix is what catches the reach an arm can actually type. The token is 16
 * random hex it has no way to know, so it globs — `cat $TMPDIR/vat-skill-evals-&#42;/
 * evals.json` — and that string contains neither the full path nor the name. (One
 * `&#42;` defeating a needle that embeds a random key is the same trap that once
 * made the whole harness-suffix scheme inert.)
 *
 * The prefix needle carries no `/`, so {@link needsLeadingBoundary} requires one
 * before it — without that, `ls $TMPDIR` printing `vat-skill-evals-abc` on its own
 * line stamps a clean run contaminated. That rule is also why this must NEVER be
 * built for the workspaces root: `vat-skill-test-ws-` is the arm's own legitimate
 * cwd and its absolute path is in the arm's own prompt, so the needle would fire
 * on every single clean run.
 */
export function vatPrivateDirNeedles(dir: string): string[] {
  const full = normalizeForMatch(dir);
  if (full === '') return [];
  const segments = normalizedSegments(full);
  const name = segments.at(-1);
  if (name === undefined || name === full) return [full];
  const needles = [full, name];
  // Everything up to and including the final `-`, i.e. the part that is NOT the
  // per-run token. Absent when the dir name carries no `-` at all.
  const lastHyphen = name.lastIndexOf('-');
  if (lastHyphen > 0) needles.push(name.slice(0, lastHyphen + 1));
  return needles;
}

/** How many verbatim lines to lift from the skill body as content needles. */
const SKILL_CONTENT_NEEDLE_COUNT = 3;

/**
 * Shortest line worth using as a content needle.
 *
 * A needle this long is verbatim prose an arm does not reproduce by coincidence,
 * which is what lets this signal skip the path-boundary machinery the other
 * needles need: there is no shorter spelling of a 48-character sentence to guard
 * against, and no `ls` output that prints one by accident.
 */
const MIN_SKILL_CONTENT_NEEDLE_LENGTH = 48;

/** Line prefixes that make a line structural rather than distinctive prose. */
const STRUCTURAL_LINE_PREFIXES = ['#', '|', '>', '---', '```'];

/**
 * Verbatim lines from the skill body that mean "this transcript SAW the skill".
 *
 * THE GAP THIS FILLS. Every other signal in this module needs the arm to name a
 * PATH or an executable. An instruction-only skill — the common case — ships no
 * executable, and the two ambient classes vat cannot remove (the adopter's own
 * repo/build output, the installed plugin cache) produce no harness path. So
 * `grep -rl "<phrase>" .` → `Read` → answer was completely invisible, and
 * `contaminated: false` meant "saw no evidence" while reading as "verified none".
 * Content is the only thing that survives all three of those steps: a `grep` hit
 * line, a `Read` echo, and an answer that quotes the skill with no path attached.
 *
 * Selection is deterministic and needs no corpus: LONGEST first, because length is
 * rarity for free. A candidate must be plain body prose —
 *
 *   - frontmatter is skipped (the `name:` is the skill's own identifier and shows
 *     up in ordinary config and prose; it is not distinctive enough to accuse
 *     anyone with);
 *   - fenced code is skipped, since a code block is often copied from a shared
 *     upstream and is the same in every skill that wraps the same tool;
 *   - headings, table rows and block quotes are skipped as structural;
 *   - a line carrying `"` or `\` is skipped: the transcript is stream-json, so
 *     those are ESCAPED inside it and {@link normalizeForMatch} then rewrites the
 *     escape — the needle would never match its own text.
 *
 * `excludedText` is the run's own eval prompts and expectations, and it is not
 * optional care: an adopter who quotes a sentence of their SKILL.md in an eval
 * prompt would otherwise stamp EVERY run contaminated, including the arm that
 * merely read the prompt it was given. The skill's own words reaching the arm
 * through vat are not the arm reaching the skill.
 */
export function skillContentNeedles(skillMarkdown: string, excludedText = ''): string[] {
  const excluded = normalizeForMatch(excludedText);
  const candidates: string[] = [];

  for (const line of skillBodyLines(skillMarkdown)) {
    if (!isNeedleCandidate(line)) continue;
    const needle = normalizeForMatch(line);
    if (excluded.includes(needle)) continue;
    if (!candidates.includes(needle)) candidates.push(needle);
  }

  // Longest first; ties keep document order, so the list is stable across runs of
  // the same skill and a reported `match` can be found in SKILL.md by eye.
  return candidates
    .map((needle, order) => ({ needle, order }))
    .sort((a, b) => b.needle.length - a.needle.length || a.order - b.order)
    .slice(0, SKILL_CONTENT_NEEDLE_COUNT)
    .map((c) => c.needle);
}

/** Trimmed body lines: frontmatter and fenced code stripped, everything else kept. */
function skillBodyLines(skillMarkdown: string): string[] {
  const lines = skillMarkdown.split('\n').map((line) => line.trim());
  const body: string[] = [];
  let inFrontmatter = lines[0] === '---';
  let inCode = false;

  for (const [index, line] of lines.entries()) {
    if (index === 0 && inFrontmatter) continue;
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      continue;
    }
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (!inCode) body.push(line);
  }
  return body;
}

/** Is this body line distinctive enough that quoting it means seeing the skill? */
function isNeedleCandidate(line: string): boolean {
  if (line.length < MIN_SKILL_CONTENT_NEEDLE_LENGTH) return false;
  // stream-json ESCAPES these, and `normalizeForMatch` then rewrites the escape —
  // such a needle could never match its own text, so it would occupy one of the
  // three slots while being silently dead.
  if (line.includes('"') || line.includes('\\')) return false;
  return !STRUCTURAL_LINE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * Shortest executable name worth matching. A one- or two-character name
 * (`x`, `go`) occurs constantly in ordinary prose and JSON and would fire on
 * every run; below this length the check is pure noise, so it is skipped and
 * detection falls back to the harness-path signal.
 */
const MIN_EXECUTABLE_NAME_LENGTH = 3;

/**
 * Match an executable name only where it is pointed at BY A PATH, never as a bare
 * word and never as a bare filename.
 *
 * `deriveDeclaredExecutableNames` strips the extension, so `scripts/summary.py`
 * becomes the needle `summary` — a word that appears in ordinary assistant prose
 * on almost every run. A bare `indexOf` therefore reports `contaminated: true` on
 * clean runs, and the operator instruction attached to that verdict is "discard
 * the delta". A check that routinely destroys good runs trains people to ignore
 * the one warning that matters, so a false positive here is NOT the safe
 * direction — it is a different way to lose the measurement.
 *
 * This used to accept a second form, `name` followed by an extension anywhere
 * (`summary.py`, `report.md`), and that form was the defect: a review found 8/8
 * realistic CLEAN pairs firing, and 5 of them were exactly it — `python3
 * analyze.py`, `Wrote report.md`, `saved to summary.txt`, `built index.json`,
 * `created run.sh`. A control arm denied the skill writes its own script and gives
 * it the obvious name; a filename with no directory in front of it says nothing
 * about WHOSE file it is, so it can never be evidence. Only the path can be, and
 * a path is what {@link reachEscapesOwnWorkspace} then judges.
 *
 * The cost is the case this was already blind to and stays blind to: an executable
 * invoked bare on PATH (`csvsum data.csv`), or invoked by basename after a `cd`
 * into an ambient copy. The `cd` itself carries the path, which is what the other
 * detectors read.
 *
 * 📌 MEASURED, so nobody re-derives it: restoring the extension branch leaves the
 * whole suite green, because {@link reachEscapesOwnWorkspace} rejects a token with
 * no path root anyway. The branch is DEAD given that predicate, not merely
 * redundant — which is why it is deleted rather than kept as belt-and-braces.
 * Removing the predicate instead fails 4 tests, so that is where the work happens.
 * Re-adding either form needs a reach that only it catches.
 */
function executableInvocationPattern(name: string): RegExp {
  // Every regex metacharacter in `name` is escaped first, so the constructed
  // source is a literal match for an adopter-declared basename and cannot inject
  // pattern syntax. `name` also has no user-controlled quantifier, so this is not
  // a ReDoS surface.
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // Global because the caller walks EVERY occurrence — see `firstEscapingInvocation`.
  // A fresh instance is built per name per call, so the stateful `lastIndex` of a
  // `g` regex is never shared.
  // eslint-disable-next-line security/detect-non-literal-regexp -- source is built from the escaped literal above
  return new RegExp(String.raw`[/\\]${escaped}(?![\w-])`, 'g');
}

/** Characters that continue a path token leftwards from a match. */
const PATH_TOKEN_CHARS = /[\w./~$:-]/;

/**
 * Expand left from `index` to the start of the path token the match sits in, and
 * return the token from there through the end of the match.
 *
 * The haystack is already normalized, so separators are `/` and the text is
 * lowercased — this walks characters, not path components, because the token is
 * embedded in free-form transcript text with no delimiters to parse against.
 */
function pathTokenEndingAt(haystack: string, index: number, length: number): string {
  let start = index;
  while (start > 0 && PATH_TOKEN_CHARS.test(haystack.charAt(start - 1))) start -= 1;
  return haystack.slice(start, index + length);
}

/**
 * Does this path reach OUTSIDE the control arm's own working tree?
 *
 * The whole question the executable-name signal has to answer is whose copy the
 * arm ran, and the answer is in the path root, not the name. The arm's cwd IS its
 * per-eval workspace, so a plain relative path is by definition its own scratch
 * file and is not evidence; a reach into an ambient copy — the adopter's repo, the
 * installed plugin cache — is absolute, `~`- or `$VAR`-rooted, or climbs out.
 *
 * Threading `armWorkspaceDir` in matters for exactly one form, and it is a real
 * one: the executor prompt states the arm's working directory ABSOLUTELY, so the
 * arm echoes and reuses that absolute path constantly. Without this suppression
 * every such self-reference would read as an escape.
 *
 * Worked cases, all against a normalized token:
 *   `<armWorkspaceDir>/analyze.py`     → false, the arm's own file, named absolutely
 *   `scripts/analyze.py`, `./run.sh`   → false, relative to the arm's own cwd
 *   `docs.example.com/report`          → false, a bare head is not a path root
 *   `https://docs.example.com/report`  → false, a URI is not a filesystem path
 *   `/users/dev/repo/dist/…/analyze`   → true, absolute and outside
 *   `~/.claude/plugins/…/analyze.py`   → true, home-rooted
 *   `$tmpdir/…/analyze`, `c:/…/analyze`→ true, variable- and drive-rooted
 *   `../../repo/dist/…/analyze`        → true, climbs out
 *
 * Residual, accepted: an arm that `cd`s elsewhere and then uses relative paths
 * reads as clean here. The `cd` carries the absolute path, and that is the other
 * detectors' job — this one is not the last line of defence.
 */
/**
 * The FIRST invocation of `name` whose path escapes the arm's own workspace, as
 * `{ index, length }` into the normalized haystack — or `undefined` when every
 * occurrence is the arm's own file.
 *
 * Scanning every occurrence rather than testing the first is the difference
 * between a working detector and a decorative one: a control arm that writes
 * `scripts/analyze.py` and later reads an ambient copy mentions the benign form
 * first almost every time.
 */
function firstEscapingInvocation(
  haystack: string,
  normalizedName: string,
  armWorkspaceDir: string,
): { index: number; length: number } | undefined {
  for (const match of haystack.matchAll(executableInvocationPattern(normalizedName))) {
    const token = pathTokenEndingAt(haystack, match.index, match[0].length);
    if (reachEscapesOwnWorkspace(token, armWorkspaceDir)) {
      return { index: match.index, length: match[0].length };
    }
  }
  return undefined;
}

function reachEscapesOwnWorkspace(token: string, armWorkspaceDir: string): boolean {
  if (armWorkspaceDir !== '' && token.startsWith(armWorkspaceDir)) return false;
  if (token.startsWith('/')) return true;
  if (token.includes('../')) return true;
  const separator = token.indexOf('/');
  // No separator at all means no path root, so nothing says whose file it is —
  // the plain `report.md` an arm writes and reports. The pattern above cannot
  // currently produce such a token (it starts AT a separator), so this is stated
  // rather than relied on: it is what makes the pattern's narrowness a statement
  // of intent instead of the only thing holding the check together.
  if (separator === -1) return false;
  const head = token.slice(0, separator);
  // A URI is not a filesystem path, so it can never be evidence that anything
  // RAN. It reaches here because `https:/…` (the run-collapse eats the double
  // slash) has the same shape as a Windows drive root — and the two are told
  // apart by length, because a drive is exactly one letter.
  if (head.endsWith(':')) return head.length === 2;
  return !/^[\w.-]*$/.test(head);
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
/**
 * The first needle in `needles` that matches at a path boundary, as a hit of
 * `kind` — or `undefined` when none does. Needle sets are ordered longest-first,
 * so "first" is "most specific spelling that matched", and one reach is reported
 * once rather than once per spelling of itself.
 */
function firstNeedleHit(
  haystack: string,
  needles: readonly string[],
  kind: BaselineContaminationHit['kind'],
): BaselineContaminationHit | undefined {
  for (const needle of needles) {
    const index = indexOfPathAtBoundary(haystack, needle);
    if (index === -1) continue;
    return { kind, match: needle, excerpt: excerptAround(haystack, index, needle.length) };
  }
  return undefined;
}

/**
 * The first content needle present in the transcript, as a hit — or `undefined`.
 *
 * A plain substring test, deliberately: these needles are whole verbatim lines,
 * not paths, so there is no boundary to enforce and no shorter spelling of one to
 * be defeated by. First match wins, as in every other group — one reach, one hit.
 */
function firstContentHit(
  haystack: string,
  needles: readonly string[],
): BaselineContaminationHit | undefined {
  for (const needle of needles) {
    const index = haystack.indexOf(needle);
    if (index !== -1) {
      return { kind: KIND_SKILL_CONTENT, match: needle, excerpt: excerptAround(haystack, index, needle.length) };
    }
  }
  return undefined;
}

export function detectBaselineContamination(
  input: DetectBaselineContaminationInput,
): BaselineContaminationHit[] {
  const hits: BaselineContaminationHit[] = [];
  const haystack = normalizeForMatch(input.transcript);

  // First needle wins, per group: every needle set runs longest-first, so one
  // reach is reported once, at the most specific spelling that matched.
  //
  // Harness needles = full root, its last two segments, VAT's own dir name.
  const harnessMatch = firstNeedleHit(haystack, harnessNeedles(input.harnessRoot), KIND_HARNESS_PATH);
  if (harnessMatch !== undefined) hits.push(harnessMatch);

  // The other arm's working directory. Reported independently of the harness
  // needles above: a reach here contains no harness path at all, which is exactly
  // why the four-channel audit and the harness-path detector both missed it.
  const siblingMatch = firstNeedleHit(haystack, siblingArmNeedles(input.siblingArmDir ?? ''), KIND_SIBLING_ARM);
  if (siblingMatch !== undefined) hits.push(siblingMatch);

  // VAT's private tmp dirs, scanned PER DIR rather than first-match-wins across
  // all of them: reaching the answer key and reaching the grader dir are two
  // different capabilities, and an operator triaging a contaminated run needs to
  // see both. Within one dir the needles still run longest-first and stop.
  for (const dir of input.vatPrivateDirs ?? []) {
    const privateMatch = firstNeedleHit(haystack, vatPrivateDirNeedles(dir ?? ''), KIND_VAT_PRIVATE_DIR);
    if (privateMatch !== undefined) hits.push(privateMatch);
  }

  // Content, which needs no path boundary: these needles are whole verbatim lines
  // of prose, and there is no shorter spelling of one to guard against.
  const contentMatch = firstContentHit(haystack, input.skillContentNeedles ?? []);
  if (contentMatch !== undefined) hits.push(contentMatch);

  const harnessHit = hits.length > 0;
  const armDir = normalizeForMatch(input.armWorkspaceDir ?? '');
  for (const name of input.executableNames ?? []) {
    if (name.length < MIN_EXECUTABLE_NAME_LENGTH) continue;
    // Every occurrence, not just the first: the arm's own `scripts/analyze.py`
    // routinely appears BEFORE any reach into an ambient copy, and stopping at the
    // first match would let one benign mention hide every real one behind it.
    const match = firstEscapingInvocation(haystack, normalizeForMatch(name), armDir);
    if (match === undefined) continue;
    // A declared executable found via a harness path is already reported by the
    // hit above; recording it again would double-count one reach as two.
    // Compare the NORMALIZED name: excerpts come from the normalized haystack,
    // which round 3 made unconditionally lowercased. Comparing the raw declared
    // basename against it means any name carrying a capital (`Summarize`,
    // `ParseCSV`) never matches its own excerpt, so one reach is reported twice.
    // This dedupe worked on macOS/Linux until the fold became unconditional —
    // widening a normalizer requires auditing every consumer of its output.
    if (harnessHit && hits.some(h => h.excerpt.includes(normalizeForMatch(name)))) continue;
    hits.push({
      kind: KIND_DECLARED_EXECUTABLE,
      match: name,
      excerpt: excerptAround(haystack, match.index, match.length),
    });
  }

  return hits;
}

/**
 * Which contamination detectors are ARMED for a run, derived from the SAME input
 * object handed to {@link detectBaselineContamination} so the two cannot disagree
 * about what was checked. A signal counts as armed only when it has a non-empty
 * needle set — a dir that was never threaded through produces no needles and must
 * not be reported as "checked".
 */
export function activeContaminationSignals(
  input: DetectBaselineContaminationInput,
): ContaminationSignal[] {
  const signals: ContaminationSignal[] = [];
  if (harnessNeedles(input.harnessRoot).length > 0) signals.push(KIND_HARNESS_PATH);
  if (siblingArmNeedles(input.siblingArmDir ?? '').length > 0) signals.push(KIND_SIBLING_ARM);
  if ((input.vatPrivateDirs ?? []).some((dir) => vatPrivateDirNeedles(dir ?? '').length > 0)) {
    signals.push(KIND_VAT_PRIVATE_DIR);
  }
  if ((input.skillContentNeedles ?? []).length > 0) signals.push(KIND_SKILL_CONTENT);
  if ((input.executableNames ?? []).some((name) => name.length >= MIN_EXECUTABLE_NAME_LENGTH)) {
    signals.push(KIND_DECLARED_EXECUTABLE);
  }
  return signals;
}

/** Render the armed-signal list for the human-readable summary line. */
function describeSignals(signals: readonly ContaminationSignal[]): string {
  return signals.length === 0
    ? 'NO detector was armed for this run, so this verdict is not evidence of anything'
    : `checked by: ${[...signals].join(', ')}`;
}

/**
 * Assemble the run-level integrity block from every WITHOUT-arm eval's findings.
 * `findings` is empty on a clean run — the block is still emitted, with
 * `contaminated: false`, so "checked and clean" is distinguishable from
 * "never checked".
 *
 * `signals` is REQUIRED, not defaulted. A default would silently make every
 * caller's verdict claim more coverage than it had, which is the exact failure
 * this field exists to expose — and "clean" is the direction where an overclaim
 * gets believed.
 */
export function summarizeBaselineIntegrity(
  findings: BaselineContamination[],
  signals: readonly ContaminationSignal[],
  skew: readonly BaselineArmSkew[],
): BaselineIntegrity {
  const base = { signals: [...signals], skew: [...skew], comparable: skew.length === 0 };
  const skewNote =
    skew.length === 0
      ? ''
      : ` ARMS NOT COMPARABLE: ${skew.length} eval(s) [${skew.map((s) => s.evalId).join(', ')}] were graded ` +
        'against a different number of expectations on each arm, so the two summaries have different ' +
        'denominators and subtracting them is meaningless — a short-graded control reads as a skill that did nothing.';

  if (findings.length === 0) {
    return {
      ...base,
      contaminated: false,
      summary:
        'No skill-absent eval was observed reaching the skill. The A/B delta is interpretable as instruction lift ' +
        `(note: both arms still share a filesystem — this is not a capability control; ${describeSignals(signals)}).` +
        skewNote,
      findings: [],
    };
  }
  const ids = findings.map(f => f.evalId).join(', ');
  return {
    ...base,
    contaminated: true,
    summary:
      `BASELINE CONTAMINATED: the skill-absent arm reached the skill in ${findings.length} eval(s) [${ids}]. ` +
      'The reported delta is NOT a measure of skill lift — the control arm had the treatment. ' +
      'Most likely an ambient copy of the skill in this repo\'s build output or the installed plugin cache.' +
      skewNote,
    findings,
  };
}
