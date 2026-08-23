import {
  isProtectedName,
  parseStreamJsonTranscript,
  protectedEnvNames,
  type ParsedTranscript,
} from '@vibe-agent-toolkit/utils';
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
 *     single-slash needle; the run-collapse is what closes that. ⚠️ THE
 *     RUN-COLLAPSE DOES NOT PRESERVE LENGTH, so an index into normalized text
 *     does not address the original. The structured scan therefore never mixes
 *     the two: it takes excerpts from the RAW command using the raw token's own
 *     index (which is also more useful for triage — the arm's own casing is
 *     preserved), and matches needles against separately-normalized RESOLVED
 *     paths. Only the degraded flat fallback indexes into normalized text, where
 *     needle and excerpt come from that same string.
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

/**
 * A haystack the flat/content scans search: the normalized text they MATCH in,
 * the raw text they QUOTE from, and the map between the two.
 *
 * WHY THE MAP EXISTS. `excerpt`'s whole job is triage — an operator takes it back
 * to their transcript and looks. Slicing it out of the normalized haystack made
 * that impossible: `SKILL.md` came back as `skill.md`, a Windows `\` came back as
 * `/`, a JSON-escaped `\n` came back as `/n`, and none of those strings are in the
 * file the operator greps. The structured scan never had this problem (it excerpts
 * from `PathReach.text`, which is the raw command), so this closes the gap for the
 * two remaining paths: the degraded flat match and the content signal.
 *
 * `source[i]` is the index in `raw` of the code unit that produced
 * `normalized[i]`. It is ABSENT when the two could not be kept in step — see
 * {@link scanHaystack} — in which case the excerpt falls back to the normalized
 * slice and is no worse than it was.
 */
interface ScanHaystack {
  raw: string;
  normalized: string;
  source?: number[];
}

/**
 * Build a {@link ScanHaystack} from raw text.
 *
 * The separator fold and the run-collapse are done by hand rather than by
 * `normalizeForMatch`'s two `replaceAll`s, because they are the length-CHANGING
 * steps and this is where the correspondence has to be recorded (the collapse
 * deletes code units, so an index into the output does not address the input —
 * the warning {@link normalizeForMatch} has carried since it was written).
 * Lowercasing is applied to the WHOLE folded string afterwards, exactly as
 * `normalizeForMatch` does — not per character. That is what makes the two provably
 * equal rather than approximately so: `toLowerCase` is context-sensitive (Greek
 * final sigma is the real case), so a per-character fold here would quietly disagree
 * with the needles, which are normalized the other way. Every needle-matching test
 * in this suite runs through both functions and would fail on a divergence.
 *
 * `toLowerCase()` changes LENGTH for a small number of code points (U+0130 is the
 * common one). That would desynchronize the map, so the map is dropped rather than
 * silently skewed — an approximate excerpt pointing at the wrong bytes is worse
 * than the folded one, because it looks precise.
 */
function scanHaystack(raw: string): ScanHaystack {
  const units: string[] = [];
  const source: number[] = [];
  let previousWasSlash = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    const folded = ch === '\\' ? '/' : ch;
    const isSlash = folded === '/';
    if (isSlash && previousWasSlash) continue;
    previousWasSlash = isSlash;
    units.push(folded);
    source.push(i);
  }
  const folded = units.join('');
  const normalized = folded.toLowerCase();
  return normalized.length === folded.length
    ? { raw, normalized, source }
    : { raw, normalized };
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
 * `vat-skill-test`), yes. Without it, `ls` of the OS temp dir stamps
 * `contaminated: true` on a completely clean run: the arm's cwd is
 * `<tmp>/vat-skill-test-ws-<token>/…`, so `ls ../../..` prints `vat-skill-test` on
 * its own line, and a NEWLINE is not in {@link PATH_SEGMENT_CONTINUATION}, so the
 * trailing boundary happily accepts it.
 *
 * ⚠️ SCOPE, since this rule used to be the ONLY thing standing between a listing
 * and a contaminated verdict: it now applies to the DEGRADED flat fallback only
 * (see {@link flatPathHits}). The structured scan never matches a needle against
 * tool OUTPUT at all, so a listing cannot reach a needle in the first place, and
 * every path the structured scan DOES match is resolved absolute — so a bare-name
 * needle always has its leading `/` there by construction.
 *
 * ⛔ AND THIS RULE IS WHY THE FLAT SCAN HAD TO GO. A leading `/` was claimed to
 * cost no real detection, on the grounds that every genuine reach carries one —
 * including `cd ../../vat-skill-test`, "which keeps its preceding slash". That is
 * true of a ONE-SHOT `cd` and false of the two-step chain an agent actually types:
 * the Bash tool KEEPS CWD ACROSS CALLS, so `cd ../../..` then `cd vat-skill-test`
 * then `cat staged/…/SKILL.md` never writes a slash before the name, and a control
 * arm that ran the skill's own bundled script read CLEAN with all four signals
 * reported "armed". A leading-slash rule cannot be patched into correctness,
 * because the missing slash is a consequence of a cwd the flat matcher cannot see.
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
  /**
   * The matched token — a path SUFFIX, a verbatim skill line, or the executable
   * basename.
   *
   * ⚠️ PATH MATCHES ARE TRUNCATED TO THEIR LAST TWO SEGMENTS ON PURPOSE, and that
   * is not cosmetic. Needle sets run longest-first, so the needle that matches a
   * full-path reach is the ENTIRE absolute root — on Windows
   * `C:/Users/<username>/AppData/Local/Temp/vat-skill-test/<key>`, which puts the
   * operator's login name in an artifact adopters attach to bug reports, in the one
   * field that reads like a short opaque token. The last two segments identify the
   * directory just as well (`vat-skill-test/<key>`) and name nobody. See
   * {@link redactPathMatch}; the untruncated path is still visible in `excerpt`,
   * which carries its own warning.
   *
   * A skill-content match is a verbatim line of the skill's own body and is NOT
   * truncated — it has no `/`-separated structure to trim, and the whole point of
   * that signal is that the operator can find the line in SKILL.md by eye.
   */
  match: z.string().min(1),
  /**
   * A short excerpt of the transcript around the match, for triage.
   *
   * RAW TRANSCRIPT — the arm's own bytes, its own casing, its own separators,
   * bounded and whitespace-collapsed. That is a promise this field has to keep to
   * be worth anything: its only use is to be carried back to the transcript and
   * searched for, and it once came from the NORMALIZED haystack instead, so
   * `SKILL.md` was reported as `skill.md` and a JSON-escaped `\n` as `/n` — an
   * operator grepping for the reported excerpt found nothing, in a field that
   * exists solely so they can. The structured scan quotes the raw tool input; the
   * flat and content scans map their match back through {@link ScanHaystack}.
   * (Whitespace collapse is the one transform that survives, and it is stated here:
   * grep for a distinctive WORD from the excerpt, not for the whole line.)
   *
   * NOT redacted. The most likely way a harness path reaches a transcript is an
   * `env` dump, so this window can capture adjacent environment values —
   * `GITHUB_TOKEN=…`, `HOME=/Users/<name>` have both been observed — and
   * `baseline.json` is a file adopters attach to reports. Treat it as sensitive;
   * `grading.json` already quotes transcripts verbatim, so this is the same
   * exposure, not a new one.
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

/**
 * One CONTROL-arm eval that produced no grade at all, and why.
 *
 * Distinct from {@link BaselineArmSkewSchema}, which describes two arms that both
 * graded and disagreed about how deep. This describes an arm that never got as far
 * as a verdict: its executor failed to spawn, stalled, hit the wall clock, or its
 * grader exited non-zero / wrote no fragment / wrote something unparseable / echoed
 * the wrong nonce / graded a different number of expectations than the eval declares.
 *
 * Every one of those used to propagate out of `runPipeline` and fail the WHOLE run
 * (exit 1) — discarding fully-billed treatment work that was perfectly good, and
 * writing no `grading.json` at all. The treatment arm still hard-fails that way,
 * because without a treatment result there is nothing to salvage; the control arm
 * does not, because the thing it feeds (the delta) has a way to say "I cannot be
 * computed" and the thing the operator paid for (the treatment grading) does not.
 *
 * `detail` is the arm-named error message verbatim — it already carries the eval id
 * and the failing stage, and it is the text an operator would otherwise have seen on
 * stderr before the run died.
 */
export const BaselineControlArmFailureSchema = z.object({
  evalId: z.string().min(1),
  detail: z.string().min(1),
}).strict();

export type BaselineControlArmFailure = z.infer<typeof BaselineControlArmFailureSchema>;

/**
 * What ONE arm actually graded for ONE eval: how many expectations it was graded
 * against, and how many of them passed.
 *
 * Deliberately ONE type feeding two consumers. {@link armExpectationSkew} reads only
 * `total` — whether subtracting the arms is legal at all — while the delta block
 * reads `passed` to do the subtraction. Deriving those from two separate shapes is
 * exactly the drift this module keeps warning about: the two blocks would be free to
 * disagree about what each arm graded, and the one that disagreed quietly would be
 * believed. `passed` is carried here even though the parity check ignores it so that
 * a single derivation at the call site feeds both.
 */
export interface ArmEvalGrade {
  evalId: string;
  passed: number;
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
 * THE ONE-ARM CASE IS NOW THE LOAD-BEARING ONE, and it is why this function did not
 * become redundant when the declared-count check landed. Both arms are pinned to the
 * eval's DECLARED expectation count at the grader boundary
 * (`assertExpectationCountDeclared` in eval-grader.ts), so two arms that both
 * produced a fragment can no longer disagree about `total` — which reads like this
 * check has nothing left to find. It has two live inputs it always had and only now
 * carries alone:
 *
 * - an eval the CONTROL arm never graded at all, because its executor or grader
 *   broke (see {@link BaselineControlArmFailureSchema}). That is not a hypothetical:
 *   it is the routine outcome the run no longer aborts on, so it arrives here on
 *   every such run.
 * - an eval graded on one arm only for any other reason — a fragment lost, an arm
 *   mislabelled, a future path that grades the arms from different suites.
 *
 * It is also the SINGLE AUTHORITY `computeBaselineDelta` consults before withholding
 * (see baseline-delta.ts). Deleting it would leave the delta with no way to say
 * "these two totals cannot be subtracted", which is the whole reason `null` exists.
 *
 * The declared-count check is the STRONGER cousin this docblock used to say was "NOT
 * here … it needs the suite threaded into the merge". That premise was wrong: the
 * declared list is already in hand at the grader boundary, one call before the
 * fragment is returned, so no threading was needed and the check now lives there.
 * It catches what parity structurally cannot — both graders drifting the SAME way,
 * which keeps parity satisfied while every reported number is wrong.
 */
export function armExpectationSkew(
  withArm: readonly ArmEvalGrade[],
  withoutArm: readonly ArmEvalGrade[],
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

/**
 * Why one eval's scan could not run at full strength.
 *
 * The structured scan ({@link detectBaselineContamination}) needs two things the
 * transcript is not contractually obliged to provide: parseable stream-json, and
 * a cwd it can follow from the arm's own workspace through every `cd`. When
 * either is missing the scan falls back to the flat text match this module used
 * to be — which both over-reports (a `find` that PRINTS a path reads as a reach)
 * and under-reports (a relative reach after a `cd` loses the leading slash a
 * bare-name needle requires).
 *
 * A fallback that is not announced is the failure mode this whole module exists
 * to prevent: `contaminated: false` from a degraded scan is written with exactly
 * the same bytes as `contaminated: false` from a scan that actually looked.
 * `signals` already separates "checked and clean" from "nothing was armed"; this
 * separates "checked and clean" from "checked with the blunt instrument".
 */
export const BASELINE_SCAN_DEGRADATION_REASONS = [
  /** The transcript yielded no stream-json events at all, so there was nothing structured to walk. */
  'transcript-unparsed',
  /** No `armWorkspaceDir` was threaded through, so no relative path can be anchored. */
  'cwd-unknown',
  /** A `cd` the walker could not evaluate (`cd "$SOMEVAR"`, `cd -`, bare `cd`) unanchored every later path. */
  'cwd-untracked',
] as const;

export const BaselineScanDegradationSchema = z.object({
  reason: z.enum(BASELINE_SCAN_DEGRADATION_REASONS),
  /** Human-readable specifics — the offending `cd`, or what the parse produced. */
  detail: z.string(),
  /** Which eval degraded. Absent on the value the detector returns; stamped by the caller. */
  evalId: z.string().min(1).optional(),
}).strict();

export type BaselineScanDegradation = z.infer<typeof BaselineScanDegradationSchema>;

export const BaselineIntegritySchema = z.object({
  contaminated: z.boolean(),
  /**
   * The evals whose scan fell back to the flat text match, and why. Empty means
   * every eval got the structured scan — which is the only state in which
   * `contaminated: false` means "looked properly and found nothing".
   */
  degraded: z.array(BaselineScanDegradationSchema),
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
  /**
   * Control-arm evals that produced no grade at all — see
   * {@link BaselineControlArmFailureSchema}.
   *
   * A SEPARATE field from `skew` even though every entry here also produces a skew
   * entry (an eval the control arm never graded has `withoutTotal: 0`), because the
   * two say different things to an operator: skew says "the two graders disagreed
   * about the job", this says "half the experiment did not run, and here is the
   * spawn/grader failure that stopped it". Collapsing them would report a dead
   * control arm as a grading-depth disagreement, which points triage at the grader
   * prompt instead of at the timeout.
   */
  controlArmFailures: z.array(BaselineControlArmFailureSchema),
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
 * ⚠️ KNOWN OPEN — nothing here is masked. The ±60 chars are raw transcript, and a
 * hit inside an `env` dump has been observed carrying `AWS_SECRET_ACCESS_KEY=…`,
 * `GITHUB_TOKEN=ghp_…` and `HOME=/Users/<name>` into `baseline.json` — the same
 * values `formatForwardedEnvLine` bothers to mask on stderr. Fix: mask `KEY=value`
 * pairs here. (The OTHER half of that note — that `match` leaked the absolute root
 * — is CLOSED: see {@link redactPathMatch}. Do not restore the leak by reporting a
 * raw needle.)
 */
function excerptAround(haystack: string, index: number, tokenLength: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(haystack.length, index + tokenLength + EXCERPT_RADIUS);
  const slice = haystack.slice(start, end).replaceAll(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < haystack.length ? '…' : ''}`;
}

/**
 * The same excerpt, but taken from the RAW text a {@link ScanHaystack} was built
 * from — so what is reported is what the arm actually typed.
 *
 * The span is mapped end-INCLUSIVE (`source[last] + 1`) rather than by looking up
 * `source[index + length]`, which would be out of range for a needle that runs to
 * the end of the haystack and would silently start the slice at 0.
 */
function excerptIn(haystack: ScanHaystack, index: number, length: number): string {
  const { source } = haystack;
  if (source === undefined) return excerptAround(haystack.normalized, index, length);
  const start = source[index] ?? 0;
  const end = (source[index + length - 1] ?? haystack.raw.length - 1) + 1;
  return excerptAround(haystack.raw, start, end - start);
}

/** Most trailing segments of a path needle worth reporting in `match`. */
const MATCH_SEGMENT_LIMIT = 2;

/**
 * A path needle, trimmed to something safe to write into an artifact.
 *
 * Needle sets are built longest-first, so the needle a full-path reach matches is
 * the whole absolute root — which on Windows is `C:/Users/<username>/AppData/…`,
 * and on macOS is routinely `/Users/<name>/…` when `--out` points into a checkout.
 * `match` is short, opaque-looking and quoted into bug reports, so it is the last
 * place anyone inspects for a username. The last two segments say exactly as much
 * about WHICH directory was reached and name nobody.
 *
 * A needle of two segments or fewer is returned unchanged: `vat-skill-test`,
 * `vat-skill-evals-` and a sibling-arm token carry no prefix to drop, and the
 * `…/` marker on `/tmp/x` would only make it look truncated when it is not.
 */
function redactPathMatch(needle: string): string {
  const segments = normalizedSegments(needle);
  if (segments.length <= MATCH_SEGMENT_LIMIT) return needle;
  return `…/${segments.slice(-MATCH_SEGMENT_LIMIT).join('/')}`;
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
   * The arm's actual STARTING working directory — the per-eval workspace
   * `<armWorkspaceDir>/<evalId>`, which is what the executor is spawned in.
   *
   * Distinct from `armWorkspaceDir` on purpose, and the difference is one
   * directory level that decides every relative reach in the transcript. The cwd
   * walk anchors here; containment ("is this the arm's own file?") is judged
   * against `armWorkspaceDir`, which covers the arm's whole tree. Anchoring the
   * walk one level too high would resolve `cd ../../..` to the temp dir's PARENT,
   * and every subsequent relative path — the entire class of reach this scan
   * exists to catch — would land somewhere no needle can see, reporting clean.
   *
   * Defaults to `armWorkspaceDir` when absent, which is the closest anchor
   * available and still better than none.
   */
  armCwd?: string;
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
 *   - headings, table rows and block quotes are skipped as structural.
 *
 * 📌 A rule that lines carrying `"` or `\` are unusable has been REMOVED. It was
 * true while the haystack was the RAW stream-json, where such characters are
 * escaped and {@link normalizeForMatch} then rewrites the escape, so the needle
 * could never match its own text. The content signal now reads
 * {@link contentHaystackFor} — the DECODED assistant text, tool inputs and tool
 * results — where there is no escaping to defeat, so those lines are usable
 * needles again, and dropping them was silently costing quote-heavy skills their
 * only signal. Re-add the rule only if the content haystack goes back to raw JSON.
 *
 * `excludedText` is every channel through which VAT ITSELF hands the arm text:
 * the run's eval prompts, its `expected_output`, its expectations, AND the
 * contents of the input `files` fixtures VAT stages into the arm's workspace and
 * tells it to work on. This is not optional care in any of the four. An adopter
 * who quotes a sentence of their SKILL.md in a prompt — or ships a fixture that
 * does — would otherwise stamp EVERY run contaminated, including the arm that
 * merely read the input it was given, and the attached triage instruction
 * ("uninstall the ambient copy of the plugin") would send the operator hunting
 * something that does not exist. The skill's own words reaching the arm through
 * vat are not the arm reaching the skill.
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
 * Re-adding either form needs a reach that only it catches.
 *
 * ⚠️ DEGRADED-MODE ONLY. This regex, {@link pathTokenEndingAt} and
 * {@link reachEscapesOwnWorkspace} are now reached solely by {@link flatPathHits}.
 * The structured scan gets the same answer from a resolved absolute path and a
 * prefix test ({@link pathEscapesWorkspace}), with no shape-guessing at all.
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

/**
 * Characters that continue a path token leftwards from a match.
 *
 * ⚠️ DEGRADED-MODE ONLY, and known-broken even there: SPACE is absent, so
 * `python3 "/Users/dev/My Projects/skill/scripts/csvsum.py"` truncates at the last
 * segment, the token loses its root, {@link reachEscapesOwnWorkspace} returns
 * false, and the reach reads CLEAN. The same defeats
 * `~/Library/Application Support/claude/plugins/…`, the standard macOS spelling of
 * the installed-plugin cache. It is not fixed here because it cannot be: a
 * character class scraping free text has no way to know where a quoted token ends.
 * The structured scan reads shell QUOTING instead ({@link readShellWord}), which
 * is where that class of path is now handled correctly.
 */
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
 * ⛔ THE "RESIDUAL, ACCEPTED" NOTE THAT USED TO END THIS BLOCK WAS THE DEFECT.
 * It said an arm that `cd`s elsewhere and then uses relative paths reads as clean
 * here, and that this was fine because "the `cd` carries the absolute path, and
 * that is the other detectors' job". It does not: `cd vat-skill-test` after
 * `cd ../../..` carries no absolute path and no leading slash, so no detector saw
 * it and the arm ran the skill's own script on a `contaminated: false` verdict.
 * A blind spot handed to a neighbour who is also blind is not a residual.
 * The structured scan resolves the cwd instead; this predicate is now reached
 * only from the degraded flat fallback, where the same hole is still open and is
 * declared as degradation rather than assumed away.
 */
/**
 * The FIRST invocation of `name` whose path escapes the arm's own workspace, as
 * `{ index, length }` into the normalized haystack — or `undefined` when every
 * occurrence is the arm's own file. Degraded-mode only; the structured scan reads
 * the same evidence off {@link PathReach}.
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

/* ══════════════════════════ the structured scan ══════════════════════════════
 *
 * WHAT REPLACED THE FLAT SCAN, AND WHY NO PATCH TO IT COULD WORK.
 *
 * This module used to flatten the whole stream-json transcript into one string
 * and hunt needles in it. That single rule was wrong in BOTH directions, and both
 * were demonstrated by running a control arm:
 *
 *   (a) It CLEARED a real reach. The Bash tool KEEPS CWD ACROSS CALLS, so
 *       `cd ../../..` → `cd vat-skill-test` → `cd <key>` → `cat staged/…/SKILL.md`
 *       → `python3 staged/…/scripts/csvsum.py` never writes a `/` before the
 *       harness directory NAME, and {@link needsLeadingBoundary} requires one. The
 *       arm ran the skill's own bundled script and the verdict was
 *       `contaminated: false` with all four signals reported "armed".
 *
 *   (b) It CONVICTED ordinary orientation. Anything that PRINTS a path supplies
 *       the slash, so `find ../../.. -maxdepth 1 -type d` produced two
 *       `vat-private-dir` hits — the verdict reserved for "reached the held answer
 *       key" — and `find /private/var/folders -name data.csv`, the arm hunting the
 *       fixture it was TOLD to work on, stamped `sibling-arm`. Nothing was opened
 *       in any of them.
 *
 * The root cause is not a tunable: a name-based needle in flat text cannot tell
 * "saw a name in a listing" from "reached in and read". `find` PRINTING a path and
 * `cat` CONSUMING one are identical bytes to a string matcher. The structure that
 * answers it was in the transcript the whole time and was being thrown away.
 *
 * So the scan now:
 *   1. parses the stream-json into TOOL CALLS (name + full input);
 *   2. tracks a virtual CWD from the arm's own workspace, interpreting `cd`
 *      (including `cd a && cd b`) so a relative path resolves against the cwd in
 *      force AT THAT POINT;
 *   3. classifies each call's INTENT — retrieval (consumes content), enumeration
 *      (lists names only), or other;
 *   4. matches PATH needles against the resolved ABSOLUTE paths in tool INPUT,
 *      never against tool OUTPUT. `find ../../..` has an input of `../../..`;
 *      only its output names the harness. That is the whole of (b);
 *   5. keeps CONTENT needles matching everything — inputs, outputs and assistant
 *      text — because that is where skill text legitimately proves the arm READ
 *      it: `grep -r "<phrase>" ../../..` must still fire, via content and not
 *      via path.
 *
 * When the transcript will not parse, or a `cd` cannot be evaluated, the scan
 * falls back to the flat match and says so — see {@link BaselineScanDegradation}.
 */

/** What a tool call DOES with the paths in its input. */
export type ToolIntent = 'retrieval' | 'enumeration' | 'other';

/**
 * One path a tool call named in its INPUT, resolved against the cwd in force at
 * that call, plus enough of the surrounding text to quote in an excerpt.
 */
interface PathReach {
  /** Normalized and absolute — or `~`/`$VAR`-rooted, which is "outside" by definition. */
  resolved: string;
  intent: ToolIntent;
  /** The raw text the token was read out of (a Bash command, or a tool input's JSON). */
  text: string;
  /** Where in `text` the raw token sat, so the excerpt quotes what the arm actually typed. */
  index: number;
  length: number;
}

/**
 * The first needle in `needles` that matches at a path boundary, as a hit of
 * `kind` — or `undefined` when none does. Needle sets are ordered longest-first,
 * so "first" is "most specific spelling that matched", and one reach is reported
 * once rather than once per spelling of itself.
 */
function firstNeedleHit(
  haystack: ScanHaystack,
  needles: readonly string[],
  kind: BaselineContaminationHit['kind'],
): BaselineContaminationHit | undefined {
  for (const needle of needles) {
    const index = indexOfPathAtBoundary(haystack.normalized, needle);
    if (index === -1) continue;
    return { kind, match: redactPathMatch(needle), excerpt: excerptIn(haystack, index, needle.length) };
  }
  return undefined;
}

/**
 * The first RESOLVED PATH matching any of `needles`, as a hit of `kind`.
 *
 * Needles run in their declared longest-first order in the OUTER loop, so one
 * reach is still reported at its most specific spelling; reaches run in
 * transcript order inside it. `claimed` records the resolved path so the
 * executable signal below does not report the same reach a second time.
 */
function firstReachHit(
  reaches: readonly PathReach[],
  needles: readonly string[],
  kind: BaselineContaminationHit['kind'],
  claimed: Set<string>,
): BaselineContaminationHit | undefined {
  for (const needle of needles) {
    for (const reach of reaches) {
      if (!containsPathAtBoundary(reach.resolved, needle)) continue;
      claimed.add(reach.resolved);
      return {
        kind,
        match: redactPathMatch(needle),
        excerpt: excerptAround(reach.text, reach.index, reach.length),
      };
    }
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
  haystack: ScanHaystack,
  needles: readonly string[],
): BaselineContaminationHit | undefined {
  for (const needle of needles) {
    const index = haystack.normalized.indexOf(needle);
    if (index !== -1) {
      return { kind: KIND_SKILL_CONTENT, match: needle, excerpt: excerptIn(haystack, index, needle.length) };
    }
  }
  return undefined;
}

/**
 * The haystack the CONTENT signal reads: assistant prose, every tool input, and
 * every tool RESULT — the decoded values, not the raw JSON line.
 *
 * Decoded matters twice over. Against the raw stream-json, a needle carrying a
 * `"` or a `\` could never match its own text (the transcript holds the ESCAPED
 * form), which is why {@link isNeedleCandidate} used to drop such lines on the
 * floor. Against the decoded values there is no escaping to defeat, so those
 * lines are usable needles again.
 *
 * Deliberately WIDER than "tool output and assistant text": an arm that writes a
 * sentence of the skill into a file (`echo "<skill prose>" > notes.md`) has
 * demonstrably seen it, and that evidence lives in a tool INPUT. Unlike a path,
 * a verbatim line of skill prose cannot arrive by orientation — there is no `ls`
 * that prints one — so widening the content haystack cannot reproduce defect (b).
 */
function contentHaystackFor(parsed: ParsedTranscript, transcript: string): ScanHaystack {
  const parts = [parsed.text];
  for (const use of parsed.toolUses) parts.push(use.command ?? renderToolInput(use.input));
  for (const result of parsed.toolResults) parts.push(result.content);
  const joined = parts.join('\n');
  // A transcript we could not decode at all still gets scanned, in its raw form:
  // a content needle found in escaped JSON is still a content needle found.
  //
  // The DECODED join is what the excerpt quotes from when there is one, which is
  // the right raw text here: it is the arm's own prose and its own commands, with
  // the stream-json escaping already undone. Quoting the JSON line instead would
  // hand the operator a string that is not in their transcript either.
  return scanHaystack(joined.trim() === '' ? transcript : joined);
}

function renderToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === undefined || input === null) return '';
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/**
 * Did the transcript decode into anything at all?
 *
 * `parseStreamJsonTranscript` is deliberately tolerant — an unparseable line is
 * skipped, not thrown on — so "it returned an object" is not evidence it worked.
 * A non-empty transcript that produced no text, no tool calls, no tool results
 * and no terminal `result` event was not stream-json, and the structured scan has
 * nothing to walk.
 */
function transcriptDecoded(parsed: ParsedTranscript): boolean {
  return (
    parsed.text !== '' ||
    parsed.toolUses.length > 0 ||
    parsed.toolResults.length > 0 ||
    parsed.result !== undefined
  );
}

/** The tool names whose input paths are LISTED rather than consumed. */
const ENUMERATION_TOOLS = new Set(['glob', 'ls', 'listdir']);
/** The tool names that read a file's CONTENT. */
const RETRIEVAL_TOOLS = new Set(['read', 'grep', 'notebookread']);

function toolIntent(name: string): ToolIntent {
  const lower = name.toLowerCase();
  if (ENUMERATION_TOOLS.has(lower)) return 'enumeration';
  if (RETRIEVAL_TOOLS.has(lower)) return 'retrieval';
  return 'other';
}

/**
 * Walk the transcript's tool calls in order, resolving every path they name
 * against the cwd in force at that point.
 *
 * `untracked` is set the moment a `cd` cannot be evaluated. Everything after such
 * a `cd` is anchored to a cwd we know to be wrong, so the caller throws the whole
 * structured result away rather than reporting half of it — a half-tracked walk
 * is exactly the "quietly wrong measurement" this module exists to prevent.
 */
function walkToolReaches(
  parsed: ParsedTranscript,
  startCwd: string,
): { reaches: PathReach[]; untracked?: BaselineScanDegradation } {
  const reaches: PathReach[] = [];
  let cwd = startCwd;

  for (const use of parsed.toolUses) {
    if (use.command !== undefined) {
      const walked = walkBashCommand(use.command, cwd);
      reaches.push(...walked.reaches);
      cwd = walked.cwd;
      if (walked.untracked !== undefined) return { reaches, untracked: walked.untracked };
      continue;
    }
    reaches.push(...structuredToolReaches(use.name, use.input, cwd));
  }
  return { reaches };
}

/**
 * Paths named by a NON-Bash tool call.
 *
 * Every string leaf of the input is considered, rather than a per-tool list of
 * "the field that holds the path": the tool surface is the vendor's and changes
 * without notice, and a detector that only knows `Read.file_path` goes silently
 * blind the day a tool renames it. {@link isPathCandidate} is what keeps that
 * cheap — a leaf with no separator in it is not a path and is skipped.
 */
function structuredToolReaches(name: string, input: unknown, cwd: string): PathReach[] {
  const intent = toolIntent(name);
  const text = renderToolInput(input);
  const reaches: PathReach[] = [];
  for (const leaf of stringLeaves(input)) {
    if (!isPathCandidate(leaf)) continue;
    const resolved = resolvePathToken(leaf, cwd);
    if (resolved === undefined) continue;
    const index = text.indexOf(leaf);
    reaches.push({
      resolved,
      intent,
      text,
      index: index === -1 ? 0 : index,
      length: index === -1 ? text.length : leaf.length,
    });
  }
  return reaches;
}

/** Every string in a tool input, however deeply nested. Bounded by the input itself. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => stringLeaves(v));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) => stringLeaves(v));
  }
  return [];
}

/* ────────────────────────── shell reading ────────────────────────── */

/**
 * Shell control operators, LONGEST FIRST so `&&` is never read as two `&` and
 * `>>` is never read as two `>`.
 *
 * The first six end a command; `<`, `>` and `>>` only end a WORD, because their
 * operand belongs to the command that owns them (`sort < ../../skill/notes.md`
 * reaches through a redirect, not through a new command).
 */
const SHELL_OPERATORS = ['&&', '||', '>>', ';', '|', '&', '<', '>', '\n'] as const;
const SEGMENT_OPERATORS = new Set(['&&', '||', ';', '|', '&', '\n']);
const INPUT_REDIRECT = '<';

/**
 * Characters a backslash may escape.
 *
 * Deliberately a SET rather than "the next character, whatever it is": a Windows
 * path (`C:\repo\dist\summary.mjs`) is a perfectly ordinary token in a transcript,
 * and an unconditional escape rule eats its separators and leaves
 * `c:repodistsummary.mjs` — which matches no needle and reports clean. The
 * members here are the ones a shell actually needs escaped, and `\ ` is the one
 * that matters: `/Users/dev/My\ Projects/…` is a single path token.
 */
const SHELL_ESCAPABLE = new Set([' ', '\t', '"', "'", '\\', '$', '&', '|', ';', '(', ')', '<', '>', '*', '?', '`']);

interface ShellToken {
  /** The token with quoting and escapes resolved. */
  text: string;
  /** Index of the token in the ORIGINAL command, so an excerpt quotes what was typed. */
  index: number;
  /** Length in the ORIGINAL command, quotes included. */
  length: number;
  /** True for a control operator rather than a word. */
  operator: boolean;
}

function matchOperator(command: string, at: number): string | undefined {
  return SHELL_OPERATORS.find((op) => command.startsWith(op, at));
}

/**
 * Read one shell WORD, honouring `'…'`, `"…"` and backslash escapes.
 *
 * Quote-awareness is not cosmetic. `PATH_TOKEN_CHARS` — the flat scan's way of
 * finding a path — excludes space, so it truncated `python3 "/Users/dev/My
 * Projects/skill/scripts/csvsum.py"` at the last segment, left the token with no
 * root, and reported CLEAN. The same held for
 * `~/Library/Application Support/claude/plugins/…`, which is the standard macOS
 * spelling of the installed-plugin cache this detector mainly exists to catch.
 */
function readShellWord(command: string, start: number): ShellToken {
  let text = '';
  let i = start;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r') break;
    if (matchOperator(command, i) !== undefined) break;
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      if (close === -1) {
        text += command.slice(i + 1);
        i = command.length;
        break;
      }
      text += command.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '\\' && SHELL_ESCAPABLE.has(command.charAt(i + 1))) {
      text += command.charAt(i + 1);
      i += 2;
      continue;
    }
    text += ch;
    i += 1;
  }
  return { text, index: start, length: i - start, operator: false };
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    const operator = matchOperator(command, i);
    if (operator !== undefined) {
      tokens.push({ text: operator, index: i, length: operator.length, operator: true });
      i += operator.length;
      continue;
    }
    const word = readShellWord(command, i);
    tokens.push(word);
    // A zero-length word would spin forever; it cannot happen (the operator and
    // whitespace branches above consume every character that would produce one),
    // so this is a guard on the invariant rather than a case.
    i = word.length === 0 ? i + 1 : word.index + word.length;
  }
  return tokens;
}

/** Split a tokenized command at the operators that END a command. */
function shellSegments(tokens: readonly ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [[]];
  for (const token of tokens) {
    if (token.operator && SEGMENT_OPERATORS.has(token.text)) {
      segments.push([]);
      continue;
    }
    segments.at(-1)?.push(token);
  }
  return segments.filter((s) => s.length > 0);
}

/* ────────────────────────── intent ────────────────────────── */

/**
 * Commands that CONSUME a file's content. An interpreter is here because running
 * a script is the strongest possible form of reading it.
 */
const RETRIEVAL_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'xxd', 'od', 'strings', 'tac', 'rev',
  'source', '.',
  'grep', 'rg', 'egrep', 'fgrep', 'ack', 'ag',
  'awk', 'sed', 'jq', 'yq', 'cut', 'tr', 'sort', 'uniq', 'wc',
  'python', 'python3', 'node', 'bun', 'deno', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'php', 'osascript',
  'cp', 'mv', 'rsync', 'install', 'tar', 'unzip', 'gunzip', 'zcat',
  'diff', 'cmp', 'md5', 'md5sum', 'sha1sum', 'sha256sum', 'shasum',
  'open', 'code', 'vim', 'vi', 'nano', 'emacs',
]);

/**
 * Commands that only produce NAMES. Their input paths still count as a reach —
 * `find ../../vat-skill-test` chose vat's staged tree as its search root, which
 * the arm could only do by going looking — but their OUTPUT is never scanned, and
 * they can never be evidence that a declared executable RAN.
 */
const ENUMERATION_COMMANDS = new Set([
  'ls', 'dir', 'find', 'tree', 'fd', 'du', 'df', 'stat', 'file',
  'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'which', 'type', 'test', '[',
]);

/** Words that prefix a command without being it. */
const COMMAND_PREFIXES = new Set(['sudo', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'xargs']);

/**
 * The last `/`- or `\`-separated segment of a token.
 *
 * Both separators, and no `basename()`: the input here is a raw shell token that
 * may carry EITHER platform's separator regardless of the platform we are running
 * on (a Windows path can appear in a transcript captured anywhere), which is the
 * one case `node:path` cannot answer.
 */
function basenameOf(token: string): string {
  const at = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return at === -1 ? token : token.slice(at + 1);
}

/**
 * The command a segment actually runs, skipping `VAR=value` prefixes and wrappers
 * like `sudo`. Returns the head token too, because `./scripts/run.sh` is both the
 * command AND a path reach into whatever it points at.
 */
function segmentHead(words: readonly ShellToken[]): { head: string; headToken?: ShellToken; args: ShellToken[] } {
  for (const [index, token] of words.entries()) {
    if (/^[A-Za-z_]\w*=/.test(token.text)) continue;
    const base = basenameOf(token.text).toLowerCase();
    if (COMMAND_PREFIXES.has(base)) continue;
    return { head: base, headToken: token, args: words.slice(index + 1) };
  }
  return { head: '', args: [] };
}

function commandIntent(head: string, headToken: ShellToken | undefined, words: readonly ShellToken[]): ToolIntent {
  if (ENUMERATION_COMMANDS.has(head)) return 'enumeration';
  if (RETRIEVAL_COMMANDS.has(head)) return 'retrieval';
  // `< file` feeds a file's CONTENT to whatever runs, whether or not we recognise
  // the command — so the redirect decides the intent when the command name did not.
  if (words.some((t) => t.operator && t.text === INPUT_REDIRECT)) return 'retrieval';
  // `./tool` or `/opt/bin/tool`: executing a file by path is retrieval regardless
  // of what it is called, and this is the branch that covers a skill's own bundled
  // script invoked directly rather than through an interpreter.
  if (headToken !== undefined && isPathCandidate(headToken.text)) return 'retrieval';
  return 'other';
}

/* ────────────────────────── path resolution ────────────────────────── */

/**
 * Is this token worth resolving as a path at all?
 *
 * A BARE WORD IS NOT A PATH, and that rule is load-bearing in both directions.
 * Without it `grep -rn vat-skill-test src` — vat dogfooded on its own checkout,
 * where ~10 tracked files carry the literal — resolves `vat-skill-test` against
 * the cwd and stamps the run contaminated. With it, the only cost is a reach into
 * the arm's OWN cwd by bare filename, which is not evidence of anything.
 */
function isPathCandidate(word: string): boolean {
  if (word === '') return false;
  // A `--flag` with a separator in it (`--out=/tmp/x`) still names a path; one
  // without (`-maxdepth`, `-type`) never does.
  if (/^-{1,2}[A-Za-z]/.test(word) && !word.includes('/') && !word.includes('\\')) return false;
  return (
    word.includes('/') ||
    word.includes('\\') ||
    word.startsWith('~') ||
    /^\$\w/.test(word) ||
    /^[A-Za-z]:$/.test(word)
  );
}

/** `scheme://` on the RAW token — {@link normalizeForMatch} collapses the `//` away. */
const URI_SCHEME = /^[A-Za-z][\w+.-]*:\/\//;

/**
 * Fold `.` and `..` out of an already-normalized path.
 *
 * `..` beyond the root is clamped rather than escaping, which is what a real
 * filesystem does, and what makes `cd ../../../../..` from a temp workspace land
 * at `/` instead of producing a token no needle can match.
 *
 * Splitting on `/` is safe here for the same reason it is in
 * {@link normalizedSegments}: the input has already been through
 * {@link normalizeForMatch}, which folded every `\` away. A `basename()` would
 * reintroduce the platform separator the normalizer just removed.
 */
function normalizeDotSegments(normalized: string): string {
  const absolute = normalized.startsWith('/');
  const out: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop();
      continue;
    }
    out.push(segment);
  }
  return (absolute ? '/' : '') + out.join('/');
}

/**
 * Resolve one token to a comparable absolute path, or `undefined` when it is not
 * a filesystem path at all.
 *
 * A `~`- or `$VAR`-rooted token is returned AS WRITTEN. We cannot expand it, and
 * we must not: pretending `~/x` is relative would resolve it inside the arm's own
 * workspace and suppress exactly the installed-plugin-cache reach this detector
 * exists for. Left unexpanded it is not under the arm's workspace, so it reads as
 * an escape — the conservative direction.
 */
function resolvePathToken(token: string, cwd: string): string | undefined {
  if (URI_SCHEME.test(token)) return undefined;
  const normalized = normalizeForMatch(token);
  if (normalized === '') return undefined;
  if (normalized.startsWith('~') || normalized.startsWith('$')) return normalized;
  if (normalized.startsWith('/') || /^[a-z]:\//.test(normalized)) return normalizeDotSegments(normalized);
  return normalizeDotSegments(`${cwd}/${normalized}`);
}

/* ────────────────────────── the Bash walk ────────────────────────── */

/** A `cd` argument we cannot evaluate — everything after it is anchored to a lie. */
function untrackableCd(target: string | undefined): boolean {
  if (target === undefined || target === '' || target === '-') return true;
  return target.includes('$') || target.includes('`');
}

function firstOperand(args: readonly ShellToken[]): ShellToken | undefined {
  return args.find((t) => !t.operator && !/^-{1,2}[A-Za-z]/.test(t.text));
}

/**
 * Walk ONE Bash command: collect the paths its segments name and carry the cwd
 * forward across them.
 *
 * Carrying cwd ACROSS calls (the caller's job) and across `&&` within one call
 * (this function's) is the entire fix for defect (a). The Bash tool keeps its
 * working directory between invocations, so a `cd` in call 3 governs call 9.
 */
function walkBashCommand(
  command: string,
  startCwd: string,
): { reaches: PathReach[]; cwd: string; untracked?: BaselineScanDegradation } {
  const reaches: PathReach[] = [];
  let cwd = startCwd;

  for (const segment of shellSegments(tokenizeShell(command))) {
    const { head, headToken, args } = segmentHead(segment);
    if (head === 'cd') {
      const target = firstOperand(args);
      if (untrackableCd(target?.text)) return { reaches, cwd, untracked: untrackedCd(target?.text) };
      const moved = cdReach(target, cwd, command);
      if (moved !== undefined) {
        reaches.push(moved);
        cwd = moved.resolved;
      }
      continue;
    }
    const candidates = headToken === undefined ? args : [headToken, ...args];
    reaches.push(...segmentReaches(candidates, commandIntent(head, headToken, segment), cwd, command));
  }
  return { reaches, cwd };
}

/**
 * Where a `cd` landed, as a reach in its own right.
 *
 * A `cd` argument is ALWAYS resolved, even when it is a BARE NAME that
 * {@link isPathCandidate} would reject everywhere else — `cd vat-skill-test`
 * after `cd ../../..` is precisely the step the flat scan could not see, and
 * skipping it would leave the cwd stale and the rest of the walk anchored wrong.
 * The rejection rule exists to stop a `grep` PATTERN being read as a path; a `cd`
 * operand is never a pattern.
 *
 * The target is reported as a reach because navigating INTO vat's staged tree is
 * not orientation, whatever the arm does once it is there.
 */
function cdReach(target: ShellToken | undefined, cwd: string, command: string): PathReach | undefined {
  if (target === undefined) return undefined;
  const resolved = resolvePathToken(target.text, cwd);
  if (resolved === undefined) return undefined;
  return { resolved, intent: 'other', text: command, index: target.index, length: target.length };
}

function untrackedCd(target: string | undefined): BaselineScanDegradation {
  const spelled = `cd ${target ?? ''}`;
  return {
    reason: 'cwd-untracked',
    detail: `could not evaluate "${spelled}" — every later relative path is unanchored`,
  };
}

/** Every path one segment's words name, resolved against the cwd in force there. */
function segmentReaches(
  words: ReadonlyArray<ShellToken | undefined>,
  intent: ToolIntent,
  cwd: string,
  command: string,
): PathReach[] {
  const reaches: PathReach[] = [];
  for (const word of words) {
    if (word === undefined || word.operator || !isPathCandidate(word.text)) continue;
    const resolved = resolvePathToken(word.text, cwd);
    if (resolved === undefined) continue;
    reaches.push({ resolved, intent, text: command, index: word.index, length: word.length });
  }
  return reaches;
}

/* ────────────────────────── assembling the verdict ────────────────────────── */

/** The stem of a path's basename, extension stripped — `bucket-map.mjs` → `bucket-map`. */
function executableStem(resolved: string): { base: string; stem: string } {
  const base = basenameOf(resolved);
  const dot = base.lastIndexOf('.');
  return { base, stem: dot > 0 ? base.slice(0, dot) : base };
}

/**
 * Does this resolved path lie OUTSIDE the arm's own workspace?
 *
 * In the structured scan this is the whole of the question the old
 * {@link reachEscapesOwnWorkspace} answered by inspecting the token's shape: the
 * path is already absolute, so containment is a prefix test and nothing else. The
 * shape-inspection version survives only in the degraded flat fallback, where
 * there is no cwd to resolve against.
 */
function pathEscapesWorkspace(resolved: string, armWorkspaceDir: string): boolean {
  if (armWorkspaceDir === '') return true;
  return resolved !== armWorkspaceDir && !resolved.startsWith(`${armWorkspaceDir}/`);
}

function structuredExecutableHits(
  input: DetectBaselineContaminationInput,
  reaches: readonly PathReach[],
  armWorkspaceDir: string,
  claimed: ReadonlySet<string>,
): BaselineContaminationHit[] {
  const hits: BaselineContaminationHit[] = [];
  for (const name of input.executableNames ?? []) {
    if (name.length < MIN_EXECUTABLE_NAME_LENGTH) continue;
    const needle = normalizeForMatch(name);
    // Every reach, not just the first: the arm's own `scripts/analyze.py`
    // routinely appears BEFORE any reach into an ambient copy, and stopping at the
    // first mention would let one benign one hide every real one behind it.
    const reach = reaches.find((r) => {
      if (r.intent !== 'retrieval') return false;
      const { base, stem } = executableStem(r.resolved);
      return (base === needle || stem === needle) && pathEscapesWorkspace(r.resolved, armWorkspaceDir);
    });
    // A reach already reported as a harness / sibling / private-dir hit is ONE
    // reach; reporting it again as an executable would double-count it. Deduping
    // on the RESOLVED PATH rather than on excerpt text is what makes this
    // case-proof — the old excerpt-substring test compared a raw declared name
    // against an unconditionally lowercased excerpt, so any name with a capital
    // (`Summarize`) escaped the dedupe and was reported twice.
    if (reach === undefined || claimed.has(reach.resolved)) continue;
    hits.push({
      kind: KIND_DECLARED_EXECUTABLE,
      match: name,
      excerpt: excerptAround(reach.text, reach.index, reach.length),
    });
  }
  return hits;
}

/** Path/dir hits from the structured walk, in the stable per-group order. */
function structuredPathHits(
  input: DetectBaselineContaminationInput,
  reaches: readonly PathReach[],
  armWorkspaceDir: string,
): { dirHits: BaselineContaminationHit[]; executableHits: BaselineContaminationHit[] } {
  const dirHits: BaselineContaminationHit[] = [];
  const claimed = new Set<string>();
  const push = (hit: BaselineContaminationHit | undefined): void => {
    if (hit !== undefined) dirHits.push(hit);
  };

  push(firstReachHit(reaches, harnessNeedles(input.harnessRoot), KIND_HARNESS_PATH, claimed));
  push(firstReachHit(reaches, siblingArmNeedles(input.siblingArmDir ?? ''), KIND_SIBLING_ARM, claimed));
  // Per dir, not first-match-wins across all of them: reaching the answer key and
  // reaching the grader dir are two different capabilities, and an operator
  // triaging a contaminated run needs to see both.
  for (const dir of input.vatPrivateDirs ?? []) {
    push(firstReachHit(reaches, vatPrivateDirNeedles(dir ?? ''), KIND_VAT_PRIVATE_DIR, claimed));
  }
  return { dirHits, executableHits: structuredExecutableHits(input, reaches, armWorkspaceDir, claimed) };
}

/**
 * The DEGRADED scan: the flat text match this module used to be.
 *
 * Kept verbatim in behaviour, not because it is right — the module docblock above
 * lists both directions in which it is wrong — but because "no scan at all" is
 * worse than "a scan that over- and under-reports and SAYS SO". Every caller of
 * this path attaches a {@link BaselineScanDegradation}.
 */
function flatPathHits(
  input: DetectBaselineContaminationInput,
): { dirHits: BaselineContaminationHit[]; executableHits: BaselineContaminationHit[] } {
  const haystack = scanHaystack(input.transcript);
  const dirHits: BaselineContaminationHit[] = [];
  const dirNeedles: string[] = [];
  const push = (needles: readonly string[], kind: BaselineContaminationHit['kind']): void => {
    const hit = firstNeedleHit(haystack, needles, kind);
    if (hit === undefined) return;
    dirHits.push(hit);
    // The needle as MATCHED, not as reported: `hit.match` has been through
    // {@link redactPathMatch} and is no longer a substring of anything.
    dirNeedles.push(...needles);
  };

  push(harnessNeedles(input.harnessRoot), KIND_HARNESS_PATH);
  push(siblingArmNeedles(input.siblingArmDir ?? ''), KIND_SIBLING_ARM);
  for (const dir of input.vatPrivateDirs ?? []) {
    push(vatPrivateDirNeedles(dir ?? ''), KIND_VAT_PRIVATE_DIR);
  }

  const armDir = normalizeForMatch(input.armWorkspaceDir ?? '');
  const executableHits: BaselineContaminationHit[] = [];
  for (const name of input.executableNames ?? []) {
    if (name.length < MIN_EXECUTABLE_NAME_LENGTH) continue;
    const match = firstEscapingInvocation(haystack.normalized, normalizeForMatch(name), armDir);
    if (match === undefined) continue;
    if (reachedViaReportedDir(haystack.normalized, match, dirNeedles)) continue;
    executableHits.push({
      kind: KIND_DECLARED_EXECUTABLE,
      match: name,
      excerpt: excerptIn(haystack, match.index, match.length),
    });
  }
  return { dirHits, executableHits };
}

/**
 * Was this executable invocation reached THROUGH a directory already reported?
 *
 * The dedupe this replaces asked a much weaker question: "does any dir hit's
 * EXCERPT contain the executable's name?" — where the excerpt is ±60 characters of
 * surrounding transcript, and the guard was armed by `hits.length > 0` over the
 * sibling-arm and private-dir hits as well as the harness one. A SKILL.md line
 * naming the script it ships sits well inside 60 characters of any path to that
 * SKILL.md, so the normal case suppressed the second signal — and that second
 * signal is the whole difference between "the arm READ an ambient copy" and "the
 * arm RAN it", which is the first thing an operator triaging a contaminated run
 * wants to know.
 *
 * The right question is about ONE REACH, not about proximity: the executable's own
 * path token either contains a reported directory or it does not. `cat
 * <root>/staged/s/scripts/csvsum.py` is one reach reported twice and is still
 * deduped; a `csvsum` run from an ambient copy sixty characters away from an
 * unrelated `find ../..` is two reaches and is now reported as two.
 *
 * Degraded-mode only. The structured scan dedupes on the RESOLVED PATH (`claimed`),
 * which is the same question asked where the answer is exact.
 */
function reachedViaReportedDir(
  haystack: string,
  match: { index: number; length: number },
  dirNeedles: readonly string[],
): boolean {
  if (dirNeedles.length === 0) return false;
  const token = pathTokenEndingAt(haystack, match.index, match.length);
  return dirNeedles.some((needle) => containsPathAtBoundary(token, needle));
}

/** What a scan of one skill-absent transcript produced. */
export interface BaselineContaminationScan {
  /**
   * Stable order: harness path, sibling arm, vat private dirs, skill content,
   * then declared executables in declared order. At most one per group.
   */
  hits: BaselineContaminationHit[];
  /** Present only when the structured scan could not run — see the schema. */
  degraded?: BaselineScanDegradation;
}

/**
 * Which scan can run for this transcript, and why not the good one.
 *
 * Order matters: an unparseable transcript is reported as such even when
 * `armWorkspaceDir` is also missing, because it is the more fundamental failure
 * and the one an operator can act on (the executor did not capture stream-json).
 */
function scanDegradation(
  input: DetectBaselineContaminationInput,
  parsed: ParsedTranscript,
): BaselineScanDegradation | undefined {
  if (input.transcript.trim() !== '' && !transcriptDecoded(parsed)) {
    return {
      reason: 'transcript-unparsed',
      detail: `${input.transcript.length} chars of transcript yielded no stream-json events`,
    };
  }
  if (normalizeForMatch(input.armWorkspaceDir ?? '') === '') {
    return {
      reason: 'cwd-unknown',
      detail: 'no armWorkspaceDir was supplied, so no relative path in the transcript can be anchored',
    };
  }
  return undefined;
}

/**
 * Scan the skill-absent arm's transcript for proof it reached the skill.
 *
 * Pure + unit-testable. See the module-level block above {@link ToolIntent} for
 * the architecture and for the two demonstrated defects that forced it.
 */
export function detectBaselineContamination(
  input: DetectBaselineContaminationInput,
): BaselineContaminationScan {
  const parsed = parseStreamJsonTranscript(input.transcript);
  // Content is scanned identically in both modes: a verbatim line of skill prose
  // is evidence wherever it appears, and unlike a path it cannot arrive by
  // orientation. So degradation never costs this signal anything.
  const contentHit = firstContentHit(
    contentHaystackFor(parsed, input.transcript),
    input.skillContentNeedles ?? [],
  );

  const degraded = scanDegradation(input, parsed);
  const armDir = normalizeForMatch(input.armWorkspaceDir ?? '');
  const startCwd = normalizeForMatch(input.armCwd ?? '') || armDir;
  const walked = degraded === undefined ? walkToolReaches(parsed, startCwd) : undefined;
  const fellBack = degraded ?? walked?.untracked;

  const { dirHits, executableHits } =
    walked === undefined || walked.untracked !== undefined
      ? flatPathHits(input)
      : structuredPathHits(input, walked.reaches, armDir);

  return {
    hits: [...dirHits, ...(contentHit === undefined ? [] : [contentHit]), ...executableHits],
    ...(fellBack === undefined ? {} : { degraded: fellBack }),
  };
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
 * Everything the run-level integrity block is assembled from.
 *
 * An OBJECT, and every field REQUIRED — no optionals, no defaults. Each of these
 * five is a coverage claim, and every one of them is believed in the same
 * direction: an absent `signals` reads as "checked by nothing", an absent
 * `degraded` reads as "every scan was structured", an absent `controlArmFailures`
 * reads as "both arms ran". A default on any of them lets a caller overclaim
 * silently; a required field is a compile error the day a new call site appears.
 *
 * `degraded` was defaulted to `[]` for exactly one release and the harness never
 * passed it, so `baseline.json` read identically whether the contamination scan
 * walked the transcript or fell back blind. That is the whole reason the rule is
 * written down here rather than assumed.
 */
export interface SummarizeBaselineIntegrityInput {
  /** Per-eval contamination findings; empty on a clean run. */
  findings: readonly BaselineContamination[];
  /** Which detectors were ARMED for this run — see {@link activeContaminationSignals}. */
  signals: readonly ContaminationSignal[];
  /** Evals whose two arms are not comparable — see {@link armExpectationSkew}. */
  skew: readonly BaselineArmSkew[];
  /** Evals whose scan fell back to flat matching — see {@link BaselineScanDegradationSchema}. */
  degraded: readonly BaselineScanDegradation[];
  /** Control-arm evals that never produced a grade — see {@link BaselineControlArmFailureSchema}. */
  controlArmFailures: readonly BaselineControlArmFailure[];
}

/**
 * Assemble the run-level integrity block from every WITHOUT-arm eval's findings.
 * `findings` is empty on a clean run — the block is still emitted, with
 * `contaminated: false`, so "checked and clean" is distinguishable from
 * "never checked".
 *
 * `comparable` is derived from `skew` ALONE, deliberately, even though a
 * `controlArmFailures` entry also means the arms cannot be subtracted. `skew` is
 * the single authority `computeBaselineDelta` consults, and a second input to
 * `comparable` here would let this block say "not comparable" while the delta block
 * beside it printed a number — the exact two-blocks-disagreeing failure this module
 * keeps warning about. It costs nothing: a control-arm failure removes that eval's
 * control grade entirely, and {@link armExpectationSkew} reports a one-armed eval as
 * skew by construction, so the two always agree. See the run-harness test that pins
 * that derivation end to end rather than trusting this sentence.
 */
export function summarizeBaselineIntegrity(input: SummarizeBaselineIntegrityInput): BaselineIntegrity {
  const { findings, signals, skew, degraded, controlArmFailures } = input;
  const base = {
    signals: [...signals],
    skew: [...skew],
    comparable: skew.length === 0,
    degraded: [...degraded],
    controlArmFailures: [...controlArmFailures],
  };
  const degradedIds = degraded.map((d) => `${d.evalId ?? '?'}: ${d.reason}`).join('; ');
  const degradedNote =
    degraded.length === 0
      ? ''
      : ` ⚠️ DEGRADED SCAN: ${degraded.length} eval(s) fell back to flat text matching ` +
        `[${degradedIds}], which both over- and under-reports. A clean verdict from a degraded ` +
        'scan is not the same claim as a clean structured scan.';
  const skewNote =
    skew.length === 0
      ? ''
      : ` ARMS NOT COMPARABLE: ${skew.length} eval(s) [${skew.map((s) => s.evalId).join(', ')}] were graded ` +
        'against a different number of expectations on each arm, so the two summaries have different ' +
        'denominators and subtracting them is meaningless — a short-graded control reads as a skill that did nothing.';
  // Printed BEFORE the skew note it causes: a dead control arm is also a skew
  // entry, and an operator who reads only the skew sentence goes and audits the
  // grader prompt for a run whose grader never got to speak.
  const controlCauses = controlArmFailures.map((f) => `${f.evalId}: ${f.detail}`).join('; ');
  const controlNote =
    controlArmFailures.length === 0
      ? ''
      : ` CONTROL ARM DID NOT RUN: ${controlArmFailures.length} eval(s) produced no skill-absent grade — ` +
        `${controlCauses}. ` +
        'The treatment arm was graded and its artifacts are complete; only the comparison is missing. ' +
        'Re-run --baseline to recover the delta — the treatment result you already paid for stands.';

  if (findings.length === 0) {
    return {
      ...base,
      contaminated: false,
      summary:
        'No skill-absent eval was observed reaching the skill. The A/B delta is interpretable as instruction lift ' +
        `(note: both arms still share a filesystem — this is not a capability control; ${describeSignals(signals)}).` +
        controlNote +
        skewNote +
        degradedNote,
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
      controlNote +
      skewNote +
      degradedNote,
    findings: [...findings],
  };
}
