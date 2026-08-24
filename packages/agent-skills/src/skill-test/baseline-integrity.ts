import {
  isProtectedName,
  parseStreamJsonTranscript,
  protectedEnvNames,
  type ParsedTranscript,
} from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { sanitizeGraderText } from './grader-text.js';

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
 * The canonical spelling of a path a CALLER declared, for use as a needle.
 *
 * ⚠️ THE RULE THIS ENCODES, because this class has now bitten twice: A SIGNAL MUST
 * BE ARMED BY THE SAME VALUE THE MATCHER USES. `signals` answers "which detectors
 * actually looked?", so a detector reporting itself armed over a needle that cannot
 * match writes "checked and clean" where the truth is "nothing looked" — and the
 * two are byte-identical in `baseline.json`. Where a value can be armed-but-INERT,
 * that is a defect regardless of how it got there. It is not a cosmetic
 * disagreement between two code paths; it is the one claim this module exists to
 * make, made falsely.
 *
 * So every caller-declared path is folded HERE, ONCE, and both the arming test and
 * the matcher read the result — they cannot disagree because there is only one
 * string. {@link normalizeForMatch} folds separators and case;
 * {@link normalizeDotSegments} folds `.` and `..`, which is what the RESOLVED side
 * of every comparison has already had done to it. A needle carrying a `.` segment
 * is inert BY CONSTRUCTION: no resolved path can contain one.
 *
 * 📌 MEASURED: without the dot fold, `harnessRoot: '.'` and `'./'` reported
 * `harness-path` armed over the needles `.` and `./`, which fire on nothing.
 * `harnessRoot: '/'` is NOT in that set — its needle is degenerate but `cat /`
 * does match it, so it stays armed.
 */
function foldDeclaredPath(value: string): string {
  return normalizeDotSegments(normalizeForMatch(value));
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

export function harnessNeedles(harnessRoot: string): PathNeedle[] {
  const normalized = foldDeclaredPath(harnessRoot);
  if (normalized === '') return [];
  const segments = normalizedSegments(normalized);
  const loginNames = loginNameSegments(normalized);
  const needles: PathNeedle[] = [pathNeedle(normalized, loginNames, false)];
  if (segments.length >= 2) needles.push(pathNeedle(segments.slice(-2).join('/'), loginNames, true));
  const vatDir = normalizeForMatch(VAT_HARNESS_DIR_NAME);
  if (segments.includes(vatDir)) needles.push(pathNeedle(vatDir, loginNames, false));
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
 * tool OUTPUT at all, so a listing cannot reach a needle in the first place.
 *
 * ⛔ NOT because "every path the structured scan DOES match is resolved absolute",
 * which this used to claim and which is false in two ways: a `~`- or `$VAR`-rooted
 * token is returned AS WRITTEN by {@link resolvePathToken} precisely so it reads as
 * an escape, and after an unevaluable `cd` there is no cwd to resolve against at
 * all. The rule is harmless there anyway — `~/vat-skill-test/x` still carries the
 * slash the bare-name needle wants — but the reason it is harmless is the SHAPE of
 * what survives resolution, not a guarantee of absoluteness that does not hold.
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
  /**
   * The platform whose env-name casing rules apply. Defaults to this process's.
   * Threaded in ONLY so the win32 branch of {@link isProtectedName} is testable:
   * without it the case-insensitive lookup this function deliberately uses instead
   * of `protectedNames.has` was unexercised on every platform CI runs the unit
   * suite on, and swapping the two was green.
   */
  platform: string = process.platform,
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
    // `!forbiddenKey` is NOT dead, though `CLAUDE_PLUGIN_ROOT` is not in
    // `protectedEnvNames`: `modelVars` is caller-supplied and lands in the protected
    // set verbatim, so a run that declared the forbidden key as a model var would
    // exempt it and hand the control arm the staged plugin root. Rule 1 wins.
    if (leaksPath && !forbiddenKey && isProtectedName(key, protectedNames, platform)) {
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
 * The structured scan ({@link detectBaselineContamination}) needs three things the
 * transcript is not contractually obliged to provide: parseable stream-json with no
 * dropped lines, and a cwd it can follow from the arm's own workspace through every
 * `cd`.
 *
 * ⚠️ THE TWO FAILURES ARE NOT THE SAME SHAPE, and treating them alike was a defect
 * in its own right. An UNPARSEABLE transcript leaves nothing to walk, so the scan
 * falls back to the flat text match this module used to be — which both over-reports
 * (a `find` that PRINTS a path reads as a reach) and under-reports (a relative reach
 * after a `cd` loses the leading slash a bare-name needle requires). An unevaluable
 * `cd`, or a dropped line, leaves a HOLE instead: everything resolved before it is
 * still validly resolved and is kept, and only what came after and needed a cwd is
 * lost. Falling back for that case discarded good evidence AND reintroduced the flat
 * scanner's over-reporting — one leading `cd $HOME` was enough to turn a pure
 * directory listing into the "reached the answer key" verdict.
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
  /**
   * The transcript carried lines that were not JSON, so the structured walk saw a
   * transcript with holes in it.
   *
   * This is the one degradation that is invisible from the OUTSIDE: a corrupted
   * line is silently dropped by the parser, the surviving lines still decode, and
   * {@link transcriptDecoded} — an any-of test satisfied by the terminal `result`
   * line alone — still returns true. One truncated tool call therefore DELETES a
   * contamination hit and the verdict reads `contaminated: false` from a scan that
   * never saw the evidence.
   */
  'transcript-malformed',
  /**
   * A reach carried a glob the walk cannot expand, and no needle matched it.
   *
   * Needle 3 (VAT's own directory NAME) exists because one `*` defeated the
   * two-segment suffix scheme — but it is still a LITERAL segment, so a glob
   * standing for the directory name itself walks straight past all three:
   * `cat ../../vat-skill-test/&#42;/staged/&#42;/SKILL.md` fires and
   * `cat ../../vat-&#42;/&#42;/staged/&#42;/SKILL.md` reports `hits: []` with
   * `degraded: none`, which is byte-identical to a clean run. No expansion is
   * attempted — that would need the filesystem, which is long gone by scan time —
   * so the scan says it could not tell.
   */
  'glob-unexpanded',
] as const;

/*
 * ⛔ A `needle-seen-unresolved` REASON WAS BUILT HERE AND MEASURED OUT. DO NOT
 * REBUILD IT WITHOUT READING THIS.
 *
 * The proposal: run the flat substring scan for the three DIRECTORY needles
 * alongside the structured walk on every scan, and where the flat scan sees a
 * needle the walk produced no hit for, record a DEGRADATION (never a hit, so the
 * "a mention does not convict" ruling is untouched). The motivation is sound — the
 * walk statically interprets arbitrary LLM-written shell, so its blind spots are
 * unbounded, and several confirmed false negatives (shell variable indirection, a
 * heredoc, `awk`'s bare first operand) leave the literal harness path in the
 * transcript reading `hits: [] degraded: none`, byte-identical to a clean run.
 *
 * MEASURED AGAINST THIS SUITE'S OWN INNOCENT FIXTURES, in three progressively
 * narrower forms:
 *
 *   - over the whole transcript ......................... 23 clean fixtures degraded
 *   - only over Bash commands the walk resolved
 *     NOTHING out of (tool output and non-Bash inputs
 *     excluded) ......................................... 12 clean fixtures degraded
 *   - ...and only on the FULL-PATH needle of each group
 *     (dropping the two-segment suffix and bare-name
 *     spellings) ........................................  5 clean fixtures degraded
 *
 * A degradation costs what a false positive costs — it stamps `⚠️ DEGRADED SCAN`
 * on a verdict that was fine — and the previous round already had to narrow a new
 * degradation that fired on 11 of 14 innocent commands.
 *
 * THE FIVE THAT SURVIVE THE NARROWEST FORM ARE WHY IT CANNOT BE NARROWED FURTHER,
 * and they are all one shape: `find . -name "<root>/x"`, `sed -e "s|x|<root>/y|"
 * notes.md`, `echo "…<root>…" >> notes.md`, `curl https://example.com<root>/…`, and
 * a heredoc body. In every one the walk DID tokenize the needle-bearing word and
 * classified it as a pattern, a script, emitted text, a URI or data — decisions
 * this module spent four review rounds establishing. So the flat scan is not seeing
 * something the walk missed; it is seeing the same text and refusing to make the
 * distinction. Shipping the check means overturning five deliberate rulings.
 *
 * The one further narrowing considered — record every operand word the walk
 * EXAMINED, and degrade only where the needle is in none of them — clears four of
 * the five but keeps the heredoc (which contradicts "a heredoc body is DATA"), and
 * costs the `awk` true positive, whose program IS an examined operand. That leaves
 * the detector firing on one of the eight known false negatives, for new machinery
 * inside the walk. Not worth it.
 *
 * Anything that revisits this needs a signal the flat scan does not have, not a
 * narrower flat scan.
 */

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
   * The evals whose scan did not run at full strength, and why. Empty means every
   * eval got a complete structured scan — the only state in which
   * `contaminated: false` means "looked properly and found nothing".
   *
   * NOT all the same failure: `transcript-unparsed` fell back to the flat text
   * match, while `cwd-untracked` and `transcript-malformed` kept every reach they
   * had resolved and lost only what came after the hole. See
   * {@link BASELINE_SCAN_DEGRADATION_REASONS}.
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
 * Longest matched token an excerpt will quote in full.
 *
 * ⛔ THIS IS A BOUND, NOT A TUNING KNOB, AND IT USED TO BE ABSENT. `excerptAround`'s
 * window is `±EXCERPT_RADIUS` around a token whose LENGTH the caller supplies, so the
 * bound this function advertises is only real if that length is bounded too. It was
 * not: {@link structuredToolReaches} computed `length` as `text.indexOf(leaf) === -1 ?
 * text.length : leaf.length`, and `text` is `JSON.stringify(input)` — in which any leaf
 * carrying a newline, a `"` or a `\` is present only in ESCAPED form and so is never
 * found. One `Write` with an 8 KB `content` therefore produced an 8,097-character
 * excerpt carrying a planted `AWS_SECRET_ACCESS_KEY=…` straight into `baseline.json`,
 * which is a file adopters attach to bug reports. The `indexOf` is fixed at that call
 * site; this clamp is the second line, so no future caller can reopen it by passing a
 * length it did not measure.
 */
const MAX_EXCERPT_TOKEN = 200;

/**
 * A short excerpt around the first occurrence of `token`, collapsed to one line.
 * Bounded so a huge tool result cannot bloat `baseline.json` — see
 * {@link MAX_EXCERPT_TOKEN}, which is what makes that claim true rather than
 * merely intended.
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
  const bounded = Math.min(Math.max(tokenLength, 0), MAX_EXCERPT_TOKEN);
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(haystack.length, index + bounded + EXCERPT_RADIUS);
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

/** What replaces a segment that is somebody's login name. */
const USER_SEGMENT_MASK = '<user>';

/**
 * Directory names whose CHILD is a login name on some platform VAT runs on:
 * `/Users/<name>` (macOS, and `C:/Users/<name>` on Windows), `/home/<name>`
 * (Linux), and the pre-Vista Windows spelling.
 */
const HOME_PARENT_SEGMENTS = new Set(['users', 'home', 'documents and settings']);

/**
 * The segments of `fullPath` that are somebody's login name.
 *
 * ⛔ THE TWO-SEGMENT RULE ALONE DID NOT DO WHAT ITS DOCBLOCK CLAIMED. "The last two
 * segments … name nobody" is true of the DEFAULT root (`<tmp>/vat-skill-test/<key>`)
 * and false of the ordinary `--out ~/something` shape, which is a two-segment path
 * whose FIRST segment is the login name: `/Users/jeffdutton/vat-out` reported as
 * `…/jeffdutton/vat-out`, and `C:/Users/jeffdutton/out` as `…/jeffdutton/out`. The
 * truncation is a privacy rule, so it has to survive the case where the name is
 * inside the window it keeps — which is what this closes.
 */
function loginNameSegments(fullPath: string): Set<string> {
  const segments = normalizedSegments(fullPath);
  const names = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    const parent = index === 0 ? undefined : segments[index - 1];
    if (parent !== undefined && HOME_PARENT_SEGMENTS.has(parent)) names.add(segment);
  }
  return names;
}

/**
 * One needle plus the string that is safe to REPORT when it matches.
 *
 * The two are separate because they answer different questions and a single string
 * cannot do both: the needle has to be the arm's own spelling or it matches nothing,
 * while `match` is quoted into bug reports and must name no person. Computing the
 * report at CONSTRUCTION is also the only place the provenance is known — a
 * suffix needle looks like a complete two-segment path by the time a hit is built,
 * and that is exactly how it came to be emitted with no truncation marker.
 */
export interface PathNeedle {
  /** Normalized; matched at a path boundary. */
  needle: string;
  /** Redacted, and marked `…/` whenever it is not the whole thing it came from. */
  match: string;
}

/**
 * A needle, plus the string safe to write into an artifact when it matches.
 *
 * Two transforms, and both are load-bearing:
 *
 *   1. **Login names are masked.** See {@link loginNameSegments}.
 *   2. **Anything shorter than what it came from is marked `…/`.** Truncation is
 *      invisible otherwise, and a reader who cannot tell `vat-skill-test/<key>` was
 *      cut out of a longer path reads it as the whole path. `truncated` is passed
 *      by the needle BUILDER, because a two-segment suffix needle is
 *      indistinguishable from a two-segment root once it is just a string — which
 *      is the bug this parameter exists to make impossible to reintroduce.
 *
 * A whole NAME (`vat-skill-test`, `vat-skill-evals-`, a sibling-arm token) is not a
 * truncation of anything and is reported verbatim; an `…/` on it would advertise a
 * cut that never happened.
 */
function pathNeedle(needle: string, loginNames: ReadonlySet<string>, truncated: boolean): PathNeedle {
  const absolute = needle.startsWith('/');
  const segments = normalizedSegments(needle)
    .map((segment) => (loginNames.has(segment) ? USER_SEGMENT_MASK : segment));
  if (segments.length > MATCH_SEGMENT_LIMIT) {
    return { needle, match: `…/${segments.slice(-MATCH_SEGMENT_LIMIT).join('/')}` };
  }
  const body = segments.join('/');
  return { needle, match: `${truncated ? '…/' : ''}${absolute ? '/' : ''}${body}` };
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
   * The skill's declared executables as SKILL-RELATIVE PATHS, exactly as the
   * packaging config spells them (`scripts/csvsum.py`), from
   * `deriveDeclaredExecutableNames`.
   *
   * ⚠️ PATHS, NOT NAMES, and the difference is the whole signal — see
   * {@link reachIsDeclaredExecutable}. This field used to carry the
   * extension-stripped basename, which convicted a clean control arm for reading
   * its own `/tmp/summary.txt`.
   */
  executablePaths?: readonly string[];
  /**
   * ⛔ NOT A FIELD — A TRIPWIRE. `executableNames` was the previous spelling and
   * carried extension-stripped basenames; it is gone, and `never` is here so that a
   * caller still passing it FAILS TO COMPILE.
   *
   * Declared because the renaming alone was silent. The harness builds this object
   * with conditional SPREADS (`...(x === undefined ? {} : { executableNames: … })`),
   * and a spread is not a fresh object literal, so TypeScript applies no
   * excess-property check: dropping the old name simply left the property unread and
   * the `declared-executable` signal unarmed on every run — reported as
   * `contaminated: false` by a detector that was no longer looking. That is precisely
   * the "silently clean" failure this module exists to prevent, so the rename gets a
   * compile error rather than a comment.
   */
  executableNames?: never;
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
export function siblingArmNeedles(siblingArmDir: string): PathNeedle[] {
  const full = foldDeclaredPath(siblingArmDir);
  if (full === '') return [];
  const loginNames = loginNameSegments(full);
  const token = normalizedSegments(full).at(-1);
  // Longest first, so one reach is reported at its most specific spelling.
  if (token === undefined || token === full) return [pathNeedle(full, loginNames, false)];
  return [pathNeedle(full, loginNames, false), pathNeedle(token, loginNames, false)];
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
export function vatPrivateDirNeedles(dir: string): PathNeedle[] {
  const full = foldDeclaredPath(dir);
  if (full === '') return [];
  const segments = normalizedSegments(full);
  const loginNames = loginNameSegments(full);
  const name = segments.at(-1);
  if (name === undefined || name === full) return [pathNeedle(full, loginNames, false)];
  const needles = [pathNeedle(full, loginNames, false), pathNeedle(name, loginNames, false)];
  // Everything up to and including the final `-`, i.e. the part that is NOT the
  // per-run token. Absent when the dir name carries no `-` at all.
  const lastHyphen = name.lastIndexOf('-');
  if (lastHyphen > 0) needles.push(pathNeedle(name.slice(0, lastHyphen + 1), loginNames, false));
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
 * Shortest declared executable path worth matching. A one- or two-character
 * spelling (`x`, `go`) occurs constantly in ordinary prose and JSON and would fire
 * on every run; below this length the check is pure noise, so it is skipped and
 * detection falls back to the harness-path signal.
 */
const MIN_EXECUTABLE_PATH_LENGTH = 3;

/**
 * The needle for one declared executable, or `undefined` when the declaration
 * cannot produce one.
 *
 * ⛔ THE ONE PLACE THE FLOOR AND THE FOLD ARE APPLIED. Every consumer —
 * {@link activeContaminationSignals}, {@link structuredExecutableHits},
 * {@link flatPathHits}, and the walk's `declaredBasenames` — goes through here, so
 * "armed" and "can match" are the SAME TEST rather than two tests that have to
 * agree. See {@link foldDeclaredPath} for why that is not a style preference.
 *
 * The floor is applied to the FOLDED value, not the raw one, and that is the half
 * that makes `signals` honest: `'///'` and `'./ab'` are respectively 3 and 4
 * characters of raw string and each armed the detector, while folding to `''` and
 * `'ab'` — nothing a needle can be built from.
 *
 * A leading `/` is STRIPPED because `executablePaths` is skill-RELATIVE by
 * contract: `/scripts/summary.py` is a legal spelling of `scripts/summary.py` in
 * `vibe-agent-toolkit.config.yaml`, whose schema is `path: z.string().min(1)` with
 * no shape constraint at all. Left on, it produced the needle `/scripts/summary.py`
 * and the matcher then asked whether a resolved path ends with
 * `//scripts/summary.py`, which no normalized path ever does.
 */
function declaredExecutableNeedle(declared: string): string | undefined {
  const folded = foldDeclaredPath(declared);
  const relative = folded.startsWith('/') ? folded.slice(1) : folded;
  return relative.length < MIN_EXECUTABLE_PATH_LENGTH ? undefined : relative;
}

/**
 * Does this resolved reach point AT the skill's declared executable — i.e. does it
 * end with the declared relative path, at a path boundary?
 *
 * ⛔ THE STEM TEST THIS REPLACES WAS A FALSE-POSITIVE ENGINE. It compared the
 * extension-stripped basename of any escaping reach against the extension-stripped
 * basename of the declaration, so a skill shipping `scripts/summary.py` convicted a
 * control arm for `sort data.csv > /tmp/summary.txt` followed by `cat
 * /tmp/summary.txt`; also confirmed firing were `python3 /tmp/summary.py`, `bash
 * /tmp/run.sh`, `python3 ~/analyze.py`, `diff /tmp/summary.txt /tmp/other.txt` and —
 * for a skill shipping `scripts/hosts.sh` — `cat /etc/hosts`. Every one of those is
 * a clean arm doing exactly what a control arm is supposed to do, told to discard
 * its run and to uninstall an ambient copy that does not exist. A check that
 * routinely destroys good runs trains people to ignore the one warning that matters,
 * so a false positive here is NOT the conservative direction.
 *
 * The relative PATH is what separates them, and it costs no detection: an ambient
 * copy — the adopter's build output, the installed plugin cache — is a COPY, so it
 * preserves the skill's internal layout and reproduces `scripts/summary.py` under
 * whatever root it sits at. `/tmp/summary.txt` and `/etc/hosts` do not.
 *
 * The residual, stated rather than hidden: a skill that declares an executable at
 * its own root (`summary.py`, no directory) is matched on that one segment, so an
 * unrelated `/tmp/summary.py` still fires. Nothing distinguishes them — the
 * declaration carries no more information than the name.
 */
function reachIsDeclaredExecutable(resolved: string, declaredPath: string): boolean {
  return resolved.endsWith(`/${declaredPath}`);
}

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
 *   1. parses the stream-json into TOOL CALLS (name + full input), PARTITIONED BY
 *      `parentToolUseId` so a Task subagent's `cd` governs only its own calls;
 *   2. tracks a virtual CWD from the arm's own workspace, interpreting `cd`
 *      (including `cd a && cd b`) so a relative path resolves against the cwd in
 *      force AT THAT POINT — and DEGRADING, never guessing, on the forms it cannot
 *      evaluate (see {@link cdDestination} for the list and for why `||` degrades
 *      while `&&` does not);
 *   3. classifies each call's INTENT — retrieval (consumes content), enumeration
 *      (lists names only), write (the path is a DESTINATION), or other. Only
 *      `retrieval` can support the "the arm RAN the skill's tool" claim;
 *   4. matches PATH needles against the resolved paths a tool call names AS
 *      OPERANDS, never against tool OUTPUT and never against PROSE.
 *
 *      ⛔ "INPUT versus OUTPUT" IS NOT THE DISTINCTION, and stating it as "the whole
 *      of (b)" is how the redesign shipped over-reporting again. `echo "checked
 *      /tmp/vat-skill-test, empty" >> notes.md`, `grep -rn "/tmp/vat-skill-test" .`,
 *      a trailing `# comment`, a `sed` substitution script, a `TodoWrite` item and a
 *      `Task` prompt are all tool INPUT and none of them reaches anything. The line
 *      that holds is OPERAND versus PROSE: a token the command would hand to
 *      `open(2)` is evidence, a token it would print, match against, or store is not.
 *      For Bash that is per-command operand shape ({@link proseOperands}); for a
 *      structured tool it is per-tool FIELD ({@link TOOL_FIELDS});
 *   5. keeps CONTENT needles matching everything — inputs, outputs and assistant
 *      text — because that is where skill text legitimately proves the arm READ
 *      it: `grep -r "<phrase>" ../../..` must still fire, via content and not
 *      via path.
 *
 * When the transcript will not parse it falls back to the flat match and says so.
 * When a `cd` cannot be evaluated it does NOT: reaches already resolved stay, and
 * only what comes AFTER the uncertainty is degraded — see
 * {@link BaselineScanDegradation} and {@link walkToolReaches}.
 */

/**
 * What a tool call DOES with the paths in its input.
 *
 * `write` is the one that is not about reading at all, and it exists because its
 * absence was a false-positive engine. {@link segmentReaches} used to stamp every
 * path word in a segment with the segment's single intent, so the DESTINATION of a
 * redirect or a copy inherited `retrieval` from the command that produced the
 * bytes — and declared executable names are basenames minus extension, i.e.
 * `summary`, `report`, `index`, `run`. `sort data.csv > /tmp/summary.txt`,
 * `cp notes.md /tmp/summary.md` and `cat parts/*.json > /tmp/index.json` each
 * reported `declared-executable`: the arm was accused of RUNNING the skill's tool
 * on the strength of having written a file with an ordinary name. A write target
 * is not evidence that anything ran.
 */
export type ToolIntent = 'retrieval' | 'enumeration' | 'write' | 'other';

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
  needles: readonly PathNeedle[],
  kind: BaselineContaminationHit['kind'],
): BaselineContaminationHit | undefined {
  for (const { needle, match } of needles) {
    const index = indexOfPathAtBoundary(haystack.normalized, needle);
    if (index === -1) continue;
    return { kind, match, excerpt: excerptIn(haystack, index, needle.length) };
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
  needles: readonly PathNeedle[],
  kind: BaselineContaminationHit['kind'],
  claimed: Set<string>,
): BaselineContaminationHit | undefined {
  for (const { needle, match } of needles) {
    for (const reach of reaches) {
      if (!containsPathAtBoundary(reach.resolved, needle)) continue;
      claimed.add(reach.resolved);
      return { kind, match, excerpt: excerptAround(reach.text, reach.index, reach.length) };
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

/**
 * What a KNOWN tool does, and which of its fields name a path.
 *
 * ⛔ A PER-TOOL FIELD LIST IS THE POINT, and the docblock that used to sit on
 * {@link structuredToolReaches} argued the opposite: "every string leaf … rather
 * than a per-tool list of the field that holds the path", on the grounds that a
 * detector which only knows `Read.file_path` goes blind the day a tool renames it.
 * That reasoning is sound and its conclusion was still wrong, because walking every
 * leaf convicts PROSE: a `Write` whose `content` says "I searched
 * /tmp/vat-skill-test and found nothing", a `TodoWrite` item mentioning a path, a
 * `Task` prompt quoting one, and a `Grep` whose `pattern` IS the path all stamped
 * the run contaminated. The same field name means opposite things in two tools —
 * `Glob.pattern` is a path and `Grep.pattern` is a regex — which is precisely what
 * a per-tool map can express and a leaf walk cannot.
 *
 * The forward-compatibility argument is kept, not discarded, and this is the
 * balance: `paths` is an ALLOWLIST that bypasses every heuristic, `prose` is a
 * DENYLIST that nothing overrides, and any field on neither list — including every
 * field of a tool not in this map at all — still reaches
 * {@link heuristicPathField}. So a renamed `Read.file_path` and an unknown vendor
 * tool both still produce reaches; what they lose is only the right to convict on a
 * sentence.
 */
interface ToolFieldSpec {
  intent: ToolIntent;
  /** Always a path operand, whatever it looks like. */
  paths: readonly string[];
  /** Never a path operand, whatever it looks like. */
  prose: readonly string[];
}

const TOOL_FIELDS = new Map<string, ToolFieldSpec>([
  ['read', { intent: 'retrieval', paths: ['file_path', 'path', 'notebook_path'], prose: [] }],
  ['notebookread', { intent: 'retrieval', paths: ['notebook_path', 'path'], prose: [] }],
  ['grep', { intent: 'retrieval', paths: ['path', 'paths', 'glob'], prose: ['pattern', 'output_mode', 'type'] }],
  ['webfetch', { intent: 'retrieval', paths: ['url'], prose: ['prompt'] }],
  ['glob', { intent: 'enumeration', paths: ['pattern', 'path'], prose: [] }],
  ['ls', { intent: 'enumeration', paths: ['path', 'paths'], prose: ['ignore'] }],
  ['listdir', { intent: 'enumeration', paths: ['path', 'paths'], prose: [] }],
  ['write', { intent: 'write', paths: ['file_path', 'path'], prose: ['content'] }],
  ['edit', { intent: 'write', paths: ['file_path', 'path'], prose: ['old_string', 'new_string', 'content'] }],
  ['multiedit', { intent: 'write', paths: ['file_path', 'path'], prose: ['old_string', 'new_string', 'edits'] }],
  ['notebookedit', { intent: 'write', paths: ['notebook_path', 'path'], prose: ['new_source', 'old_source'] }],
  ['task', { intent: 'other', paths: [], prose: ['prompt', 'description', 'subagent_type'] }],
  ['todowrite', { intent: 'other', paths: [], prose: ['todos', 'content', 'activeform', 'status'] }],
  ['websearch', { intent: 'other', paths: [], prose: ['query'] }],
  ['bash', { intent: 'other', paths: [], prose: ['command', 'description'] }],
]);

/**
 * Field names that name a path in every tool anyone has shipped.
 *
 * This is the forward-compatibility half of {@link TOOL_FIELDS}: it is what still
 * fires on `SomeFutureReader({ target_document: … })`, a tool this code has never
 * heard of under a field name it has never heard of.
 */
const PATH_FIELD_NAME = /path|file|dir|url|uri|cwd|source|dest|target|glob|location|notebook|folder/;

/**
 * Is this leaf a path OPERAND, judged without knowing the tool?
 *
 * Two ways to qualify, and the second is what keeps prose out. A field NAME that
 * says "path" is taken at its word. Otherwise the value must be a LONE TOKEN —
 * no whitespace anywhere in it — because every confirmed false positive in this
 * class was a path embedded in a sentence, and a sentence has spaces. The cost is
 * stated rather than hidden: a quoted path containing a space, under an
 * unrecognised field name of an unrecognised tool, is not seen. Put the field on
 * that tool's `paths` list when such a tool appears; the allowlist bypasses this.
 */
function heuristicPathField(key: string, value: string): boolean {
  return PATH_FIELD_NAME.test(key) || !/\s/.test(value);
}

/** One string in a tool input, with the nearest object key that led to it. */
interface InputLeaf {
  key: string;
  value: string;
}

/**
 * Walk the transcript's tool calls in order, resolving every path they name
 * against the cwd in force at that point.
 *
 * TWO THINGS THIS GETS RIGHT THAT THE PREVIOUS VERSION DID NOT, both of which were
 * silent:
 *
 * **A Task subagent has its own working directory.** `parsed.toolUses` carries
 * `parentToolUseId` — the parser has always populated it and nothing read it — so a
 * subagent's `cd /elsewhere` re-anchored every later relative path of the MAIN
 * agent, and a subagent's `cd $VAR` degraded the main scan. Each parent id gets its
 * own cwd and its own degradation.
 *
 * **Degradation runs FORWARD, not backward.** The old docblock claimed "`untracked`
 * is set the moment a `cd` cannot be evaluated", and that was a description of the
 * flag, not of the coverage: the caller then threw away EVERY structured reach,
 * including the ones resolved BEFORE the bad `cd`, and reran the flat scanner over
 * the whole transcript. One leading `cd $HOME` therefore made the canonical
 * four-step reach chain read `hits: []`, and one leading `cd $HOME` plus a `find`
 * that merely LISTED the temp dir produced `vat-private-dir` — the "reached the
 * answer key" verdict — because that is what the flat scanner does with a listing.
 * Reaches resolved before the uncertainty are still validly resolved. After it, the
 * cwd becomes `undefined` and only tokens that do not need one (absolute,
 * drive-rooted, `~`- or `$VAR`-rooted, `file://`) are still resolved.
 */
function walkToolReaches(
  parsed: ParsedTranscript,
  startCwd: string,
  ctx: WalkContext,
): { reaches: PathReach[]; untracked?: BaselineScanDegradation } {
  const reaches: PathReach[] = [];
  const cwds = new Map<string | null, string | undefined>();
  const holes = noCwdHoles();

  for (const use of parsed.toolUses) {
    const context = use.parentToolUseId;
    const cwd = cwds.has(context) ? cwds.get(context) : startCwd;
    if (use.command === undefined) {
      reaches.push(...structuredToolReaches(use.name, use.input, cwd));
      continue;
    }
    const walked = walkBashCommand(use.command, cwd, ctx);
    reaches.push(...walked.reaches);
    cwds.set(context, walked.cwd);
    // ⛔ THE WIDEST HOLE, ACROSS CALLS TOO — not the first one the transcript
    // happened to contain. See {@link CwdHoles}.
    holes.full ??= walked.holes.full;
    holes.scoped ??= walked.holes.scoped;
  }
  const untracked = worstCwdHole(holes);
  return { reaches, ...(untracked === undefined ? {} : { untracked }) };
}

/** Paths named as OPERANDS by a NON-Bash tool call — see {@link TOOL_FIELDS}. */
function structuredToolReaches(name: string, input: unknown, cwd: string | undefined): PathReach[] {
  const spec = TOOL_FIELDS.get(name.toLowerCase());
  const text = renderToolInput(input);
  const reaches: PathReach[] = [];
  for (const { key, value } of stringLeaves(input, '')) {
    if (!isToolPathOperand(spec, key, value)) continue;
    const resolved = resolvePathToken(value, cwd);
    if (resolved === undefined) continue;
    // ⛔ `length` IS THE EXCERPT BOUND. It used to be `indexOf(leaf) === -1 ?
    // text.length : leaf.length`, and `text` is `JSON.stringify(input)` — in which a
    // leaf carrying a newline, a `"` or a `\` appears only escaped and so is never
    // found. That turned one `Write` into an 8,097-character excerpt carrying a
    // planted secret. The token's own length is the only bound that is always right.
    const index = text.indexOf(value);
    reaches.push({
      resolved,
      intent: spec?.intent ?? 'other',
      text,
      index: index === -1 ? 0 : index,
      length: value.length,
    });
  }
  return reaches;
}

function isToolPathOperand(spec: ToolFieldSpec | undefined, key: string, value: string): boolean {
  const field = key.toLowerCase();
  if (spec?.prose.includes(field) === true) return false;
  if (spec?.paths.includes(field) === true) return isPathCandidate(value);
  return isPathCandidate(value) && heuristicPathField(field, value);
}

/**
 * Every string in a tool input, however deeply nested, tagged with the nearest
 * object key. An array's elements inherit the key of the array itself, so
 * `{ paths: [a, b] }` and `{ todos: [{ content: … }] }` both classify correctly.
 * Bounded by the input itself.
 */
function stringLeaves(value: unknown, key: string): InputLeaf[] {
  if (typeof value === 'string') return [{ key, value }];
  if (Array.isArray(value)) return value.flatMap((v) => stringLeaves(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => stringLeaves(v, k));
  }
  return [];
}

/* ────────────────────────── shell reading ────────────────────────── */

/**
 * Shell control operators, LONGEST FIRST.
 *
 * ⚠️ ONE PAIR OF THIS ORDERING IS LOAD-BEARING AND THE REST IS READABILITY, which is
 * worth writing down because the old comment ("the first six end a command") was
 * self-contradicting — `>>` does not end a command and `\n` does, and neither was in
 * the six. `||` MUST precede `|`: {@link walkBashCommand} degrades a `cd` on the
 * right of a `||` and does not degrade one after a pipe, so reading `||` as two `|`
 * silently reopens the `cd one || cd two` false positive. Reordering `&&` before
 * `&`, or `>>` before `>`, was MEASURED to change no verdict — both spellings split
 * the same segments and mark the same redirect target — so do not add a test that
 * pretends otherwise; keep the order because a `&`-then-`&` token stream is a lie
 * about what the arm typed.
 *
 * `<`, `>` and `>>` end a WORD only: their operand belongs to the command that owns
 * them (`sort < ../../skill/notes.md` reaches through a redirect, not through a new
 * command). `(` and `)` end a command AND open/close a subshell — see
 * {@link walkBashCommand} for why the difference from a `{ … }` brace group is not
 * cosmetic.
 */
const SHELL_OPERATORS = ['&&', '||', '>>', ';', '|', '&', '<', '>', '(', ')', '\n'] as const;
const SEGMENT_OPERATORS = new Set(['&&', '||', ';', '|', '&', '(', ')', '\n']);
const INPUT_REDIRECT = '<';
const OUTPUT_REDIRECTS = new Set(['>', '>>']);
const SUBSHELL_OPEN = '(';
const SUBSHELL_CLOSE = ')';
const OR_ELSE = '||';

/** The character comments, heredoc bodies and line continuations are blanked to. */
const BLANK = ' ';

function blankRange(chars: string[], from: number, to: number): void {
  for (let i = Math.max(from, 0); i < to && i < chars.length; i += 1) chars[i] = BLANK;
}

function endOfLine(chars: readonly string[], from: number): number {
  const at = chars.indexOf('\n', from);
  return at === -1 ? chars.length : at;
}

/**
 * Blank `#` comments and join `\`-newline continuations, quote-aware.
 *
 * BLANKED RATHER THAN DELETED, and that is the whole trick: every
 * {@link ShellToken} carries an index into the ORIGINAL command so an excerpt can
 * quote what the arm actually typed, and deleting characters would skew every one
 * of them. Replacing with spaces is length-preserving, so the tokenizer sees a
 * command with the noise removed while the indices still address the real text.
 *
 * Both forms were parsed as ordinary command lines before this existed:
 * `ls -la  # nothing under /tmp/vat-skill-test` convicted on the COMMENT, and
 * `ls -la \` + newline + `<path>` made the path the segment HEAD, which
 * {@link commandIntent} then classified as retrieval ("executing a file by path")
 * and reported as a `declared-executable` run.
 */
function blankCommentsAndContinuations(chars: string[]): void {
  let quote: string | undefined;
  let atWordStart = true;
  let resumeAt = 0;
  for (const [i, ch] of chars.entries()) {
    if (i < resumeAt) continue;
    if (quote !== undefined) {
      quote = ch === quote ? undefined : quote;
      continue;
    }
    resumeAt = blankNoiseAt(chars, i, ch, atWordStart);
    if (ch === "'" || ch === '"') quote = ch;
    atWordStart = WORD_BOUNDARY_CHARS.has(ch);
  }
}

/**
 * Blank the comment or continuation starting at `i`, and return where scanning
 * resumes. A no-op (returns `i`) for every other character.
 */
function blankNoiseAt(chars: string[], i: number, ch: string, atWordStart: boolean): number {
  if (ch === '\\') {
    if (chars[i + 1] === '\n') blankRange(chars, i, i + 2);
    return i + 2;
  }
  if (ch !== '#' || !atWordStart) return i;
  const stop = endOfLine(chars, i + 1);
  blankRange(chars, i, stop);
  return stop;
}

/** Characters after which the next character begins a fresh shell word. */
const WORD_BOUNDARY_CHARS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '']);

/**
 * Blank every heredoc body and its `<<WORD` marker.
 *
 * A heredoc body is DATA, and it was being tokenized as command lines. A body
 * containing `cd /tmp/vat-skill-test/<key>` therefore both emitted a false
 * `harness-path` hit and poisoned the tracked cwd for the whole rest of the
 * transcript — the second of which is the worse half, because it is silent.
 */
const HEREDOC_MARKER = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g;

function blankHeredocBodies(chars: string[]): void {
  const text = chars.join('');
  for (const match of text.matchAll(HEREDOC_MARKER)) {
    const delimiter = match[2];
    if (delimiter === undefined) continue;
    blankRange(chars, match.index, match.index + match[0].length);
    const bodyStart = text.indexOf('\n', match.index + match[0].length);
    if (bodyStart === -1) continue;
    blankRange(chars, bodyStart, heredocBodyEnd(text, bodyStart + 1, delimiter));
  }
}

function heredocBodyEnd(text: string, from: number, delimiter: string): number {
  let cursor = from;
  while (cursor <= text.length) {
    const lineEnd = text.indexOf('\n', cursor);
    const stop = lineEnd === -1 ? text.length : lineEnd;
    if (text.slice(cursor, stop).trim() === delimiter) return stop;
    if (lineEnd === -1) return text.length;
    cursor = lineEnd + 1;
  }
  return text.length;
}

/**
 * The command with comments, heredoc bodies and continuations blanked out —
 * SAME LENGTH as the original, so every token index still addresses it.
 */
function sanitizeCommandText(command: string): string {
  // Code UNITS, not code points: every token index is a `String.prototype` index,
  // so a spread (which splits by code point) would desynchronize on an astral char.
  const chars = Array.from({ length: command.length }, (_, i) => command.charAt(i));
  blankCommentsAndContinuations(chars);
  blankHeredocBodies(chars);
  return chars.join('');
}

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
/**
 * The end of a `$( … )` or `` ` … ` `` substitution starting at `at`, or -1.
 *
 * Substitutions are swallowed WHOLE rather than tokenized, because `(` and `)` are
 * now segment operators: without this, `cat $(pwd)/notes.md` tokenizes as `$`, `(`,
 * `pwd`, `)`, `/notes.md` — and that last fragment resolves to the absolute path
 * `/notes.md`, a reach into the filesystem ROOT that the arm never made.
 */
/**
 * Every `$( … )` / `` ` … ` `` body in a command, with its offset.
 *
 * Swallowing a substitution whole keeps its EXPANSION out of the path model, which
 * is right — nothing here can know what `$(pwd)` is. It also hid the commands
 * INSIDE it, which is not: `echo done $(cat <ambient-copy>/summary.py)` really does
 * read that file. The bodies are walked separately, in subshell semantics (a `cd`
 * inside one cannot move the caller), and their reaches are rebased onto the outer
 * command so the excerpt still quotes what the arm typed.
 */
function substitutionBodies(command: string): Array<{ text: string; offset: number }> {
  const bodies: Array<{ text: string; offset: number }> = [];
  let i = 0;
  while (i < command.length) {
    const end = substitutionEnd(command, i);
    if (end === -1) {
      i += 1;
      continue;
    }
    const open = command.charAt(i) === '`' ? 1 : 2;
    bodies.push({ text: command.slice(i + open, end - 1), offset: i + open });
    i = end;
  }
  return bodies;
}

function substitutionEnd(command: string, at: number): number {
  if (command.startsWith('$(', at)) {
    const close = command.indexOf(')', at + 2);
    return close === -1 ? command.length : close + 1;
  }
  if (command.charAt(at) === '`') {
    const close = command.indexOf('`', at + 1);
    return close === -1 ? command.length : close + 1;
  }
  return -1;
}

function readShellWord(command: string, start: number): ShellToken {
  let text = '';
  let i = start;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r') break;
    const substitution = substitutionEnd(command, i);
    if (substitution !== -1) {
      text += command.slice(i, substitution);
      i = substitution;
      continue;
    }
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

function tokenizeShell(rawCommand: string): ShellToken[] {
  const command = sanitizeCommandText(rawCommand);
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

/**
 * One command in a `&&`/`||`/`;`/`|`-joined line, plus the operator that INTRODUCED
 * it.
 *
 * The separator is carried because the walker's answers depend on it and it used to
 * be thrown away: `(` and `)` decide whether a `cd` survives the group, and `||`
 * decides whether it can be believed at all.
 */
interface CommandSegment {
  words: ShellToken[];
  /** The operator immediately before this segment; `''` for the first. */
  separator: string;
}

/**
 * Split a tokenized command at the operators that END a command.
 *
 * EMPTY SEGMENTS ARE KEPT, unlike before. `( cd x )` ends with a `)` and nothing
 * after it, and dropping that empty tail would drop the only record that the
 * subshell CLOSED — leaving the `cd` applied to the caller's cwd, which is the one
 * thing a subshell guarantees does not happen.
 */
function shellSegments(tokens: readonly ShellToken[]): CommandSegment[] {
  const segments: CommandSegment[] = [{ words: [], separator: '' }];
  for (const token of tokens) {
    if (token.operator && SEGMENT_OPERATORS.has(token.text)) {
      segments.push({ words: [], separator: token.text });
      continue;
    }
    segments.at(-1)?.words.push(token);
  }
  return segments;
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
  'tsx', 'ts-node', 'pwsh', 'powershell', 'rscript',
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

/**
 * Words that prefix a command without being it.
 *
 * ⚠️ THE LAUNCHER FAMILY IS NOT OPTIONAL. The original eight covered the 1990s
 * spellings and missed every modern one, so `uv run <ambient-copy>`,
 * `timeout 30 python3 <ambient-copy>` and `env FOO=1 python3 <ambient-copy>` were
 * all exec-blind: the head resolved to `uv` / `timeout` / `env`, none of which is a
 * retrieval command, so the reach could never support the executable signal.
 */
const COMMAND_PREFIXES = new Set([
  'sudo', 'doas', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'xargs',
  'env', 'timeout', 'uv', 'uvx', 'npx', 'bunx', 'pnpm', 'yarn', 'poetry', 'pipx',
  'watch', 'script', 'stdbuf', 'setsid', 'ionice', 'chrt',
]);

/**
 * Words a launcher takes BEFORE the command it launches.
 *
 * `timeout 30 python3 x` and `nice -n 5 cat x` both put a non-command word between
 * the prefix and the command, so skipping the prefix alone left `30` / `-n` as the
 * head. Only skipped while still inside a prefix run, so a bare `run` or a leading
 * `-x` is never mistaken for a launcher argument.
 */
const PREFIX_ARGUMENTS = new Set(['run', 'exec', 'x', '--']);
const DURATION_ARGUMENT = /^\d[\d.]*[smhd]?$/;

/**
 * Shell keywords and grouping words that are not the command.
 *
 * ⛔ WITHOUT THESE THE `cd` IS INVISIBLE, silently. {@link segmentHead} skipped only
 * `VAR=` assignments and {@link COMMAND_PREFIXES}, so in `then cd vat-skill-test`
 * the head was `then` and the `cd` became an ARGUMENT — which
 * {@link isPathCandidate} discards for having no separator. The confirmed chain
 * `cd ../../..` / `if [ -d vat-skill-test ]; then cd vat-skill-test; fi` /
 * `cd <key>` / `cat staged/s/SKILL.md` produced `hits: []` and did NOT degrade,
 * which is the worst of the three possible answers.
 *
 * A `cd` under `then`/`else`/`do` is CONDITIONAL and is applied anyway. That is a
 * judgement, not an oversight: the branch the arm goes on to use is the branch it
 * took, and the alternative (degrade) would report the reach as unknowable on the
 * exact transcripts where it is plainly visible. `||` is different and DOES degrade
 * — see {@link walkBashCommand} — because there the two branches are mutually
 * exclusive and nothing later distinguishes them.
 */
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in',
  'case', 'esac', 'select', 'function', '{', '}', '!',
]);

/**
 * The last `/`-separated segment of a token.
 *
 * 📌 A BACKSLASH ARM WAS TRIED AND MEASURED OUT. It existed for "a Windows path can
 * appear in a transcript captured anywhere", which is true, but neither caller can
 * observe it: {@link segmentHead} is only ever handed text that has been through
 * the tokenizer and the normalizer (where `\` is already `/`), and a
 * Windows-spelled command HEAD reaches `retrieval` through
 * {@link commandIntent}'s head-is-a-path branch whether or not its basename is
 * recognised. Removing the arm left the whole suite green in both directions, so it
 * is deleted rather than kept as belt-and-braces. Callers must pass `/`-normalized
 * text; re-add it only with a reach that only it catches.
 */
function basenameOf(token: string): string {
  const at = token.lastIndexOf('/');
  return at === -1 ? token : token.slice(at + 1);
}

/** Is this token still part of the launcher prefix run rather than the command? */
function isPrefixArgument(text: string): boolean {
  return text.startsWith('-') || DURATION_ARGUMENT.test(text) || PREFIX_ARGUMENTS.has(text.toLowerCase());
}

/**
 * The command a segment actually runs, skipping `VAR=value` assignments, shell
 * keywords, and launcher wrappers with their own arguments. Returns the head token
 * too, because `./scripts/run.sh` is both the command AND a path reach into
 * whatever it points at.
 */
function segmentHead(words: readonly ShellToken[]): { head: string; headToken?: ShellToken; args: ShellToken[] } {
  let inPrefix = false;
  for (const [index, token] of words.entries()) {
    const base = basenameOf(token.text).toLowerCase();
    if (/^[A-Za-z_]\w*=/.test(token.text) || SHELL_KEYWORDS.has(base)) continue;
    if (COMMAND_PREFIXES.has(base)) {
      inPrefix = true;
      continue;
    }
    if (inPrefix && isPrefixArgument(token.text)) continue;
    return { head: base, headToken: token, args: words.slice(index + 1) };
  }
  return { head: '', args: [] };
}

function commandIntent(head: string, headToken: ShellToken | undefined, words: readonly ShellToken[]): ToolIntent {
  // Enumeration is tested BEFORE the head-is-a-path branch below, and that order is
  // the set's only consumer: `/bin/ls -l <ambient-copy>/summary.mjs` has a
  // path-shaped head, so without this it would read as "executed a file by path"
  // and report the arm as having RUN the skill's tool for listing a file.
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

/* ────────────────────────── operand versus prose ────────────────────────── */

/** Commands whose every operand is TEXT TO EMIT, never a file to open. */
const PROSE_ALL_OPERANDS = new Set(['echo', 'printf', 'print']);

/**
 * Commands whose FIRST operand is a pattern or a script rather than a path.
 *
 * `grep -rn "/tmp/vat-skill-test" .` names vat's harness root and opens nothing —
 * the string is what it searches FOR. `sed -i "s|foo|<harness>/x|" ./notes.md` is
 * the same shape with a substitution script. Both stamped clean arms contaminated.
 */
const PROSE_FIRST_OPERAND = new Set(['grep', 'rg', 'egrep', 'fgrep', 'ack', 'ag', 'sed', 'awk', 'jq', 'yq', 'expr']);

/**
 * Flags that CARRY the pattern/script, so the first operand is a path after all.
 *
 * ⛔ `-c` IS NOT ONE OF THEM, and listing it here was half of a silent blind spot.
 * On the {@link PROSE_FIRST_OPERAND} family `-c` means COUNT (`grep -c pat file`),
 * so treating it as script-carrying stopped `pat` being recognised as the pattern —
 * and `grep -c "/tmp/vat-skill-test" .` then resolved vat's own harness root as a
 * reach. On an interpreter it means the opposite of a pattern (see
 * {@link PATTERN_FLAGS}). It belongs on neither list.
 */
const SCRIPT_CARRYING_FLAGS = new Set(['-e', '-f', '--expression', '--file', '--regexp']);

/**
 * Flags whose VALUE is a pattern: `find -name SKILL.md`, `grep --include=*.md`.
 *
 * Split into the ones that mean "pattern" WHEREVER they appear and the ones that
 * mean it only on the grep/sed/awk family — see {@link patternFlagValues}.
 */
const PATTERN_FLAGS = new Set([
  '-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-wholename',
  '--include', '--exclude', '--glob',
]);

/**
 * Pattern flags that belong to ONE COMMAND FAMILY and mean something else elsewhere.
 *
 * ⛔ `-e` USED TO BE UNCONDITIONAL, and that blinded every interpreter
 * one-liner: `python3 -c "print(open('<harness>/staged/s/SKILL.md').read())"`
 * produced `hits: []` — and `python`/`node`/`perl`/`ruby` are not in
 * a nested shell, so NO degradation was recorded either and the verdict read
 * as a full-strength clean scan. The same command with `-Q` in place of `-c` fired
 * `harness-path`, which is how narrow the hole was. An interpreter's `-c`/`-e`
 * carries a SCRIPT, and a script contains real operands; only on the pattern family
 * is the token after it a thing to search FOR.
 *
 * ⛔ `-c` IS NOT A MEMBER — see {@link SCRIPT_CARRYING_FLAGS}, which says the same
 * thing from the other side. Scoping it to the family did not make it safe: on the
 * family `-c` means COUNT and takes NO VALUE, so marking the token after it as a
 * pattern swallowed the pattern AND left the first-operand rule to claim the next
 * unclaimed operand — THE FILE. `grep -c foo <harness>/staged/s/SKILL.md`,
 * `rg -c` and `jq -c` all produced `hits: []` with no degradation, which is the
 * same bytes as a clean scan; `grep -n` on the identical path fired. Left off both
 * lists, `grep -c pat file` reads as pattern-then-file, which is what it is.
 */
const FAMILY_PATTERN_FLAGS = new Set(['-e', '--expression', '--regexp']);

/**
 * ⚠️ THE CHARACTER CLASS EXCLUDES `-` ON PURPOSE. Widening it to `[A-Za-z-]` makes
 * the regex backtrack and classify the bare `-` and `--` as flags, which silently
 * duplicates two rules that ought to be stated where they mean something: `cd -`
 * goes wherever it was before ({@link cdDestination} rejects it by name) and `--`
 * ends the options ({@link END_OF_OPTIONS}). Measured: with the wider class, both of
 * those explicit rules could be deleted and the suite stayed green — belt and
 * braces, where the braces were an accident of regex backtracking.
 */
function isFlag(token: ShellToken): boolean {
  return !token.operator && /^-{1,2}[A-Za-z]/.test(token.text);
}

/**
 * The tokens in this segment that are PROSE — a pattern, a script, or text to emit
 * — and so can never be evidence that anything was reached.
 *
 * This is the Bash half of the operand-versus-prose line the module docblock
 * describes. Every member was a confirmed false positive on a clean control arm.
 */
function proseOperands(head: string, args: readonly ShellToken[]): Set<ShellToken> {
  const prose = new Set<ShellToken>();
  if (PROSE_ALL_OPERANDS.has(head)) {
    for (const token of args) if (!token.operator && !isFlag(token)) prose.add(token);
  }
  for (const value of patternFlagValues(head, args)) prose.add(value);
  // `grep -e '<pattern>' file` and `sed -e '<script>' file` put the pattern on the
  // FLAG, so the first operand is the file after all and must not be skipped.
  const carried = args.some((t) => !t.operator && SCRIPT_CARRYING_FLAGS.has(t.text.toLowerCase()));
  if (!carried && PROSE_FIRST_OPERAND.has(head)) {
    const first = args.find((t) => !t.operator && !isFlag(t) && !prose.has(t));
    if (first !== undefined) prose.add(first);
  }
  return prose;
}

/**
 * The value token of every `-name <pattern>`-shaped flag in this segment.
 *
 * {@link FAMILY_PATTERN_FLAGS} count only when the HEAD is a pattern command —
 * otherwise `python3 -c <script>` reads its script as a pattern and the reaches
 * inside it are never resolved.
 */
function patternFlagValues(head: string, args: readonly ShellToken[]): ShellToken[] {
  const values: ShellToken[] = [];
  const familyFlags = PROSE_FIRST_OPERAND.has(head);
  for (const [index, token] of args.entries()) {
    if (token.operator || !isFlag(token)) continue;
    const flag = token.text.toLowerCase();
    if (!PATTERN_FLAGS.has(flag) && !(familyFlags && FAMILY_PATTERN_FLAGS.has(flag))) continue;
    const value = args[index + 1];
    if (value !== undefined && !value.operator) values.push(value);
  }
  return values;
}

/** Commands whose LAST operand is where bytes are written, not read. */
const DESTINATION_LAST_OPERAND = new Set(['cp', 'mv', 'install', 'rsync', 'ln']);
/** Commands whose every operand is a write destination. */
const DESTINATION_ALL_OPERANDS = new Set(['tee']);

/**
 * The tokens in this segment that are WRITE DESTINATIONS.
 *
 * A redirect target (`> /tmp/summary.txt`) and a copy destination
 * (`cp notes.md /tmp/summary.md`) both used to inherit the segment's single intent,
 * so `sort`/`cat`/`wc` lent them `retrieval` and the arm was reported as having RUN
 * a declared executable for writing a file called `summary`. They remain REACHES —
 * writing into vat's staged tree is worth a `harness-path` hit — but they cannot
 * support the executable signal, which asks only whether something ran.
 */
function writeTargets(head: string, words: readonly ShellToken[], args: readonly ShellToken[]): Set<ShellToken> {
  const targets = new Set<ShellToken>();
  for (const [index, token] of words.entries()) {
    if (!token.operator || !OUTPUT_REDIRECTS.has(token.text)) continue;
    const next = words[index + 1];
    if (next !== undefined && !next.operator) targets.add(next);
  }
  const operands = args.filter((t) => !t.operator && !isFlag(t));
  if (DESTINATION_ALL_OPERANDS.has(head)) for (const t of operands) targets.add(t);
  const last = operands.at(-1);
  if (DESTINATION_LAST_OPERAND.has(head) && last !== undefined && operands.length > 1) targets.add(last);
  return targets;
}

/* ────────────────────────── path resolution ────────────────────────── */

/**
 * Is this token worth resolving as a path at all?
 *
 * A BARE WORD IS NOT A PATH, and that rule is load-bearing in both directions.
 * Without it `grep -rn vat-skill-test src` — vat dogfooded on its own checkout,
 * where ~10 tracked files carry the literal — resolves `vat-skill-test` against
 * the cwd and stamps the run contaminated.
 *
 * ⛔ THE COST IS NOT "a reach into the arm's OWN cwd by bare filename", which is
 * what this used to claim and which would indeed be harmless. `cd vat-skill-test`
 * after `cd ../../..` is a bare word too, and it is the single most important step
 * in the whole reach chain — which is why {@link cdDestination} resolves a `cd`
 * operand unconditionally and never asks this question. The real cost is a bare
 * name passed to some OTHER command after the arm has already `cd`ed into vat's
 * tree, and that reach is covered by the `cd` that put it there.
 *
 * 📌 THREE CLAUSES WERE MEASURED OUT: `~`-prefixed, `$VAR`-prefixed and a bare
 * drive (`C:`). Each was reachable only by a token with NO separator in it —
 * `~/x`, `$TMPDIR/x` and `C:/x` all qualify through the separator test — so the
 * clauses could only ever admit `~`, `$HOME` and `C:` standing alone, none of which
 * resolves to anything a needle can match. The `--flag` guard went with them: once
 * candidacy is "contains a separator", a flag without one is already rejected and a
 * flag with one (`--out=/tmp/x`) is a path the guard deliberately let through.
 */
function isPathCandidate(word: string): boolean {
  return word.includes('/') || word.includes('\\');
}

/** `scheme://` on the RAW token — {@link normalizeForMatch} collapses the `//` away. */
const URI_SCHEME = /^[A-Za-z][\w+.-]*:\/\//;

/** `file://` with an optional host, which is the only URI scheme that IS a path. */
const FILE_URI = /^file:\/\/[^/]*/i;

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
  // A `~`- or `$VAR`-rooted path has an UNEXPANDABLE root segment, and `..` must not
  // pop it: popping leaves `''`, and an empty cwd resolves every later relative token
  // against the filesystem root — which is how `cd ~ && cd ..` came to report the
  // arm's own script as an ambient copy. A real `cd ~/a && cd ../../..` stops at the
  // home directory for the same reason a real `/` climb stops at `/`.
  const unexpandableRoot = normalized.startsWith('~') || normalized.startsWith('$');
  const out: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    // 📌 BOTH GUARDS THIS `pop` USED TO CARRY ARE PROVABLY REDUNDANT, verified over
    // 39,060 generated paths. `out.length > 0` guarded a `pop` on an empty array,
    // which is already a no-op; `out.at(-1) !== '..'` guarded against popping a
    // `'..'`, which is never pushed — this branch is the only place `'..'` is seen
    // and it never pushes. The root clamp the docblock above promises is what
    // `[].pop()` does for free.
    if (segment === '..') {
      if (!(unexpandableRoot && out.length <= 1)) out.pop();
    } else out.push(segment);
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
 * an escape — the conservative direction FOR A TOKEN. ⚠️ It is the INVERTED
 * direction for a CWD, and this docblock did not use to distinguish the two: a
 * tracked `cd ~` produced the cwd `"~"`, `cd ~ && cd ..` produced `""`, and an
 * empty cwd then resolved every later relative token against `/` — which reported
 * `declared-executable` on an arm running its own script in its own workspace.
 * {@link cdDestination} refuses a `~` target for that reason.
 *
 * `file://` IS a filesystem path and is unwrapped. Every other scheme is not one
 * and returns `undefined`. Treating them alike made `curl
 * file:///…/vat-skill-test/<key>/staged/s/SKILL.md` invisible to EVERY signal —
 * `hits: []` and not degraded, which is the same silence as a clean run.
 *
 * `cwd` is `undefined` after a `cd` the walk could not evaluate. A relative token
 * then resolves to nothing rather than to a guess; an absolute one is unaffected,
 * which is what makes degradation forward-only.
 */
function resolvePathToken(token: string, cwd: string | undefined): string | undefined {
  const unwrapped = FILE_URI.test(token) ? token.replace(FILE_URI, '') : token;
  if (URI_SCHEME.test(unwrapped)) return undefined;
  const normalized = normalizeForMatch(unwrapped);
  if (normalized === '') return undefined;
  if (normalized.startsWith('~') || normalized.startsWith('$')) return normalized;
  if (normalized.startsWith('/') || /^[a-z]:\//.test(normalized)) return normalizeDotSegments(normalized);
  return cwd === undefined ? undefined : normalizeDotSegments(`${cwd}/${normalized}`);
}

/* ────────────────────────── the Bash walk ────────────────────────── */

/**
 * Where a `cd` lands, or why it cannot be known.
 *
 * ⛔ EVERY MEMBER OF THE `bad` SET WAS A SILENT WRONG ANSWER, and a wrong resolution
 * is worse than a recorded degradation because degradation is visible and wrongness
 * is not:
 *
 * - **no operand** (`cd`) — goes to `$HOME`. Already degraded, and the only member
 *   of this list that was.
 * - **`-`** — goes wherever it was before.
 * - **`$VAR` / backticks** — unexpandable.
 * - **`--`** — `firstOperand` rejected `^-{1,2}[A-Za-z]`, which `--` does not match,
 *   so `cd -- vat-skill-test` resolved to `<cwd>/--` and bare `cd --` (which goes to
 *   `$HOME`, exactly like bare `cd`) resolved to `<cwd>/--` as well. The end-of-
 *   options marker is now consumed, so `cd -- vat-skill-test` tracks correctly and
 *   `cd --` degrades like its twin.
 * - **`~`** — see {@link resolvePathToken}. `cd ~` gave the cwd `"~"`, `cd ~ && cd
 *   ..` gave `""`, and `cd ~ && cd .. && cd ..` gave `"/"`; an empty cwd resolved
 *   every later relative token against the filesystem root and reported
 *   `declared-executable` against an arm running its own script in its own tree.
 * - **two operands** (`cd olddir newdir`) — bash's substitution form, which lands
 *   somewhere neither operand names.
 */
type CdDestination =
  | { kind: 'ok'; token: ShellToken }
  | { kind: 'bad'; spelled: string };

const END_OF_OPTIONS = '--';

function cdDestination(args: readonly ShellToken[]): CdDestination {
  const operands: ShellToken[] = [];
  let literal = false;
  for (const token of args) {
    if (token.operator) continue;
    if (!literal && token.text === END_OF_OPTIONS) {
      literal = true;
      continue;
    }
    if (!literal && isFlag(token)) continue;
    operands.push(token);
  }
  const spelled = `cd ${args.filter((t) => !t.operator).map((t) => t.text).join(' ')}`.trim();
  if (operands.length !== 1) return { kind: 'bad', spelled };
  const target = operands[0];
  if (target === undefined) return { kind: 'bad', spelled };
  const { text } = target;
  // ⛔ ONLY A ROOTLESS `~` IS REFUSED, not every `~`-prefixed target. The reason the
  // docblock gives — cwd `"~"`, then `cd ..`, then `""`, then every relative token
  // resolving against `/` — is about the BARE form and about `~user`, which names a
  // home directory we cannot locate. `cd ~/sub` has neither problem:
  // {@link resolvePathToken} returns `~/sub` usably and {@link normalizeDotSegments}
  // now clamps `..` at the `~`. Refusing it wholesale cost the CANONICAL
  // installed-plugin-cache reach: `cd ~/.claude/plugins/<skill>/scripts` then
  // `python3 ./csvsum.py` read clean, while the one-shot spelling of the same reach
  // fired.
  const rootlessHome = text.startsWith('~') && !text.startsWith('~/');
  if (text === '' || text === '-' || rootlessHome || text.includes('$') || text.includes('`')) {
    return { kind: 'bad', spelled };
  }
  return { kind: 'ok', token: target };
}

/**
 * Commands that move the working directory WITHOUT being `cd`, and that the walk
 * has no way to follow.
 *
 * ⛔ THESE WERE STRICTLY WORSE THAN THE FORMS THAT DEGRADE: they left a stale cwd
 * in force with no degradation recorded at all, so every later relative path was
 * resolved against a directory the arm had already left, and the verdict said the
 * scan ran at full strength. `pushd`/`popd` persist across Bash tool calls exactly
 * as `cd` does.
 *
 * ⛔ `dirs` IS NOT ONE OF THEM and used to be listed here. It PRINTS the directory
 * stack and changes nothing whatsoever, so one `dirs` anywhere in a transcript
 * unanchored every relative path after it: the canonical `cd ../../..` → `cd
 * vat-skill-test` → `cat <key>/staged/s/SKILL.md` chain reported `hits: []` behind
 * it, where the identical chain without it fires `harness-path`.
 */
const DIRECTORY_STACK_COMMANDS = new Set(['pushd', 'popd']);
/**
 * ⚠️ CASE-SENSITIVE, and that is the point: `-C` changes directory while `-c`
 * carries a script. Folding them together made `git -C ../.. status` read as a
 * nested shell and fall through both branches, which is how `-C` shipped untracked.
 */
const CHDIR_FLAGS = new Set(['-C', '--directory', '--chdir', '-execdir']);
/** Commands for which `-C` means "change directory" rather than, say, grep's context. */
const CHDIR_FLAG_COMMANDS = new Set(['git', 'make', 'tar', 'env', 'docker', 'podman', 'cmake', 'ninja', 'find']);

function isChdirFlag(text: string): boolean {
  return CHDIR_FLAGS.has(text) || text.startsWith('--chdir=') || text.startsWith('--directory=');
}

/**
 * The `-C`/`-execdir` this segment carries, or `undefined`.
 *
 * ⚠️ SCOPED TO ONE COMMAND, which is what the docblock on {@link CHDIR_FLAGS} has
 * always said and what the code then ignored by setting the walk's cwd to
 * `undefined` PERMANENTLY. `git -C ../repo status` moves nothing the shell can see:
 * a leading one made the canonical `cd ../../..` → `cd vat-skill-test` → `cat
 * <key>/staged/s/SKILL.md` chain report `hits: []`, where the identical chain
 * without it fires `harness-path`. Only that segment's own operands are unanchored.
 *
 * ⛔ A NESTED SHELL IS NOT LISTED HERE ANY MORE. `sh -c "…"` cannot change its
 * CALLER's directory — the module already reasons this way for `( … )` subshells —
 * and treating it as an opaque move blinded the walk from that point on. The
 * segment now falls through to {@link segmentReaches}, where the `-c` operand is an
 * ordinary token: a script that spells a harness path is a reach the walk can see,
 * and a `cd` inside it correctly moves nothing.
 *
 * Scanned over the WHOLE segment rather than over `args`, because the owner of the
 * flag is not always the head: `env` is a launcher prefix, so `env -C ../.. ls`
 * resolves its head to `ls` and an args-only scan never sees who `-C` belongs to.
 */
function scopedCwdChange(words: readonly ShellToken[]): string | undefined {
  let owner: string | undefined;
  for (const { operator, text } of words) {
    if (operator) continue;
    const base = basenameOf(text).toLowerCase();
    if (CHDIR_FLAG_COMMANDS.has(base)) owner = base;
    else if (owner !== undefined && isChdirFlag(text)) return `${owner} ${text}`;
  }
  return undefined;
}

/**
 * Walk ONE Bash command: collect the paths its segments name and carry the cwd
 * forward across them.
 *
 * Carrying cwd ACROSS calls (the caller's job) and across `&&` within one call
 * (this function's) is the entire fix for defect (a). The Bash tool keeps its
 * working directory between invocations, so a `cd` in call 3 governs call 9.
 *
 * THREE CONTROL-FLOW FACTS THE WALK USED TO IGNORE, all of them silently:
 *
 * - **`( … )` does not leak its cwd; `{ …; }` does.** Probed on the shipped code:
 *   neither was tracked — `(` became the segment HEAD, so the `cd` inside it was a
 *   mere argument. The subshell answer was therefore accidentally right and the
 *   brace-group answer was wrong, and no test could tell. The cwd is now stacked on
 *   `(` and restored on `)`, while `{`/`}` are ordinary keywords the head skips, so
 *   a brace group's `cd` persists exactly as the shell says it does.
 * - **`||` runs ONE of its two sides.** `cd one || cd two` was walked as though both
 *   ran, resolving to `<cwd>/one/two`. `cd .. || cd ..` then made `ls
 *   <sibling-token>/notes.md` report `sibling-arm` — the strongest verdict this tool
 *   issues — on a run whose real cwd never moved twice. A `cd` to the RIGHT of a
 *   `||` is now unevaluable. A `cd` to its LEFT still applies (`cd x || exit 1` is
 *   the idiom), and `&&` is unaffected: its right side runs only when the left
 *   succeeded, which is the case the walk is already modelling.
 * - **A stale cwd needs saying.** See {@link scopedCwdChange}.
 */
function walkBashCommand(
  command: string,
  startCwd: string | undefined,
  ctx: WalkContext,
  /** Recursion guard for {@link substitutionBodies}; a body's own bodies are not walked. */
  depth = 0,
): { reaches: PathReach[]; cwd: string | undefined; holes: CwdHoles } {
  const reaches: PathReach[] = depth === 0 ? substitutionReaches(command, startCwd, ctx) : [];
  const enclosing: Array<string | undefined> = [];
  const state = { cwd: startCwd, conditional: false };
  const holes = noCwdHoles();

  for (const { words, separator } of shellSegments(tokenizeShell(command))) {
    applySeparator(separator, enclosing, state);
    const { head, headToken, args } = segmentHead(words);
    const change = cwdChangeFor(head, args, words);
    // A `-C`/`-execdir` moves the cwd for THIS COMMAND ONLY, so its own RELATIVE
    // operands are unanchored and the walk's cwd is not — see
    // {@link scopedCwdChange}.
    //
    // ⛔ THE SEGMENT IS STILL WALKED. It used to `continue` past
    // {@link segmentReaches} entirely, which dropped its ABSOLUTE operands too —
    // and an absolute operand is anchored whatever `-C` does, which is what
    // {@link scopedCwdChange}'s own docblock says. Measured: `env -C /tmp cat
    // <harness>/staged/s/SKILL.md`, and the `git -C`/`tar -C` spellings of it, all
    // reported `hits: []`, while the bare `cat` of the same path fired. Walking it
    // with NO cwd is exactly the stated rule: {@link resolvePathToken} drops a
    // relative token without one and keeps an absolute one.
    let segmentCwd = state.cwd;
    if (change?.kind === 'scoped') {
      holes.scoped ??= untrackedScope(change.spelled);
      segmentCwd = undefined;
    } else if (change !== undefined) {
      const moved = applyCd(change, state.conditional, state.cwd, command);
      if (moved.reach !== undefined) reaches.push(moved.reach);
      state.cwd = moved.cwd;
      holes.full ??= moved.untracked;
      continue;
    }
    const intent = commandIntent(head, headToken, words);
    // `exactOptionalPropertyTypes` distinguishes an absent key from an explicit
    // `undefined`, and `segmentHead` returns `headToken` as the latter — so spread it
    // conditionally rather than widening the callee to accept `| undefined`, which
    // would let a genuinely missing head token look like a supplied one.
    reaches.push(
      ...segmentReaches(
        { head, args, words, ...(headToken === undefined ? {} : { headToken }) },
        intent,
        segmentCwd,
        command,
        ctx,
      ),
    );
  }
  return { reaches, cwd: state.cwd, holes };
}

/**
 * The reaches made INSIDE this command's substitutions, rebased onto it.
 *
 * Subshell semantics: whatever a body does to the cwd is discarded, and a body that
 * cannot be evaluated degrades nothing — the caller's cwd is untouched either way.
 */
function substitutionReaches(command: string, cwd: string | undefined, ctx: WalkContext): PathReach[] {
  const reaches: PathReach[] = [];
  for (const { text, offset } of substitutionBodies(command)) {
    for (const reach of walkBashCommand(text, cwd, ctx, 1).reaches) {
      reaches.push({ ...reach, text: command, index: reach.index + offset });
    }
  }
  return reaches;
}

interface WalkState {
  cwd: string | undefined;
  conditional: boolean;
}

/**
 * What the Bash walk needs about the SUBJECT, as opposed to about the transcript.
 *
 * One field today, and an object rather than a positional parameter because the walk
 * is recursive through {@link substitutionReaches}: a second subject fact added as an
 * argument would have to be threaded through four signatures and is exactly the kind
 * of change that gets half-applied.
 */
interface WalkContext {
  /**
   * The BASENAMES of the skill's declared executables, lowercased — `scripts/
   * csvsum.py` → `csvsum.py`. Used only by {@link isBareDeclaredExecutable}, to admit
   * a separator-less operand as a path; the hit itself is still decided by the whole
   * declared path ({@link reachIsDeclaredExecutable}).
   */
  declaredBasenames: ReadonlySet<string>;
}

/**
 * Separators that END the AND-OR list a `||` made conditional.
 *
 * ⛔ `state.conditional` USED TO BE A LATCH: `||` set it and nothing ever cleared
 * it, so every later segment of the same Bash call was treated as an unevaluable
 * branch — `mkdir -p out || true ; cd out` reported `cwd-untracked` and unanchored
 * every relative path in the rest of the transcript. Agents write `|| true`
 * constantly, which made this the likeliest of the blinding paths to fire in
 * practice. `;`, a newline, a background `&` and either parenthesis start a fresh
 * list; `&&` and `|` continue the one the `||` is part of, so a `cd` after them is
 * still on a branch that may not have run.
 */
const LIST_TERMINATORS = new Set([';', '\n', '&', SUBSHELL_OPEN, SUBSHELL_CLOSE]);

function applySeparator(separator: string, enclosing: Array<string | undefined>, state: WalkState): void {
  if (separator === SUBSHELL_OPEN) enclosing.push(state.cwd);
  else if (separator === SUBSHELL_CLOSE && enclosing.length > 0) state.cwd = enclosing.pop();
  if (separator === OR_ELSE) state.conditional = true;
  else if (LIST_TERMINATORS.has(separator)) state.conditional = false;
}

/**
 * How this segment affects the walk's working directory.
 *
 * `scoped` is the third answer the walk used to lack: a `-C`/`-execdir` moves the
 * cwd for ONE command, so it costs that command's own operands and nothing after it.
 * Collapsing it into `bad` — cwd `undefined`, forever — is what made a single
 * `git -C ../repo status` blind the rest of the transcript.
 */
type SegmentCwdEffect = CdDestination | { kind: 'scoped'; spelled: string };

/** The cwd change this segment makes, or `undefined` when it makes none. */
function cwdChangeFor(
  head: string,
  args: readonly ShellToken[],
  words: readonly ShellToken[],
): SegmentCwdEffect | undefined {
  if (head === 'cd') return cdDestination(args);
  if (DIRECTORY_STACK_COMMANDS.has(head)) return { kind: 'bad', spelled: head };
  const scoped = scopedCwdChange(words);
  return scoped === undefined ? undefined : { kind: 'scoped', spelled: scoped };
}

/**
 * Apply one `cd` (or one unevaluable cwd change): where the walk goes next, the
 * reach the `cd` itself makes, and the degradation it owes.
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
function applyCd(
  destination: CdDestination,
  conditional: boolean,
  cwd: string | undefined,
  command: string,
): { cwd: string | undefined; reach?: PathReach; untracked?: BaselineScanDegradation } {
  if (destination.kind === 'bad') return { cwd: undefined, untracked: untrackedCd(destination.spelled) };
  const { token } = destination;
  const resolved = resolvePathToken(token.text, cwd);
  const reach: PathReach | undefined =
    resolved === undefined
      ? undefined
      : { resolved, intent: 'other', text: command, index: token.index, length: token.length };
  if (conditional) {
    // ⛔ THE PREFIX IS DERIVED FROM `conditional`, NOT FROM THE COMMAND TEXT. It used
    // to be `command.includes('||')`, so a `cd` on its own LINE of a multi-line
    // command that happened to contain a `||` somewhere else was reported to the
    // operator as `could not evaluate "|| cd ../../.."` — a `||` the arm never typed
    // in front of that `cd`. Inside this branch the `cd` IS on the right of a `||` by
    // construction, so the prefix is a fact rather than a guess.
    return {
      cwd: undefined,
      ...(reach === undefined ? {} : { reach }),
      untracked: untrackedCd(`${OR_ELSE} cd ${token.text}`),
    };
  }
  return { cwd: resolved, ...(reach === undefined ? {} : { reach }) };
}

function untrackedCd(spelled: string): BaselineScanDegradation {
  return cwdDegradation(
    // SANITIZED AT CONSTRUCTION, not at the stderr write. `spelled` is a raw shell
    // token lifted out of the CONTROL ARM's transcript, and the harness interpolates
    // this detail straight into `process.stderr.write`: a `cd "$D<ESC>[2K<CR><ESC>
    // [32mvat: control arm verified clean<ESC>[0m"` erased the "contamination scan
    // DEGRADED" line vat had just written and re-rendered it in green as vat's own
    // voice — terminal forgery on the exact warning that says the scan went blind. A
    // newline payload got a line of its own. It cannot be fixed at the write, because
    // vat attaches `degraded` to the eval fragment AFTER `parseEvalFragment` has
    // sanitized it, which would leave the raw bytes in `baseline.json`; one call here
    // covers both surfaces. `sanitizeGraderText` and not the line-preserving variant:
    // this is interpolated mid-sentence, so a surviving newline IS the attack.
    `could not evaluate "${spelled}" — every later relative path is unanchored`,
  );
}

/**
 * The degradation a ONE-COMMAND cwd change owes.
 *
 * The same KIND of hole as {@link untrackedCd} — a path the walk could not anchor —
 * so it carries the same reason; the DETAIL is what says the hole is one command
 * wide rather than the whole rest of the transcript.
 */
function untrackedScope(spelled: string): BaselineScanDegradation {
  return cwdDegradation(
    `could not evaluate "${spelled}" — the paths in that ONE command are unanchored, later ones are not`,
  );
}

/**
 * The cwd holes one walk found, kept APART by how wide they are.
 *
 * ⛔ ONE `??=` SLOT USED TO HOLD BOTH, so the FIRST hole seen won and a harmless
 * one-command `git -C ../repo status` masked a genuinely unevaluable `cd $D` that
 * came after it. That is not merely a lost degradation: {@link untrackedScope}'s
 * sentence says in so many words that later paths ARE anchored, so the operator was
 * handed a written reassurance about the scan's own coverage on a run where the cwd
 * was lost for the whole remainder. Confirmed: `cd $D` alone reported "every later
 * relative path is unanchored"; the same `cd $D` behind a `git -C` reported "the
 * paths in that ONE command are unanchored, later ones are not".
 */
interface CwdHoles {
  /** A `cd` the walk could not follow — every later relative path is unanchored. */
  full: BaselineScanDegradation | undefined;
  /** A `-C`/`-execdir` — that command's own operands, and nothing after it. */
  scoped: BaselineScanDegradation | undefined;
}

function noCwdHoles(): CwdHoles {
  return { full: undefined, scoped: undefined };
}

/** The hole to REPORT: the WIDEST one found, never merely the first one met. */
function worstCwdHole(holes: CwdHoles): BaselineScanDegradation | undefined {
  return holes.full ?? holes.scoped;
}

/** One `cwd-untracked` degradation, sanitized at construction for both surfaces. */
function cwdDegradation(detail: string): BaselineScanDegradation {
  return { reason: 'cwd-untracked', detail: sanitizeGraderText(detail) };
}

/**
 * Is this separator-less operand still worth resolving?
 *
 * {@link isPathCandidate} rejects a bare word, and its docblock justifies the cost
 * by saying a bare name used after a `cd` "is covered by the `cd` that put it
 * there". That is TRUE of vat's own directories, which have needles, and FALSE of
 * the two ambient classes vat cannot remove — the adopter's repo and the installed
 * plugin cache — which have none, and for which `declared-executable` is the only
 * signal there is. Confirmed: `cd /users/dev/myrepo/dist/plugins/myskill/scripts`
 * then `python3 csvsum.py data.csv` produced NOTHING, while the identical transcript
 * spelled `./csvsum.py` fired.
 *
 * Narrow on purpose — only a RETRIEVAL head, and only an operand whose basename is
 * one the skill actually declares. Widening it to "any bare word" reopens the false
 * positive the bare-word rule exists for: `grep -rn vat-skill-test src`, vat
 * dogfooded on its own checkout, resolves the PATTERN against the cwd.
 */
function isBareDeclaredExecutable(word: string, intent: ToolIntent, ctx: WalkContext): boolean {
  return intent === 'retrieval' && ctx.declaredBasenames.has(word.toLowerCase());
}

/** Every path one segment's words name, resolved against the cwd in force there. */
function segmentReaches(
  segment: { head: string; headToken?: ShellToken; args: readonly ShellToken[]; words: readonly ShellToken[] },
  intent: ToolIntent,
  cwd: string | undefined,
  command: string,
  ctx: WalkContext,
): PathReach[] {
  const { head, headToken, args, words } = segment;
  const prose = proseOperands(head, args);
  const targets = writeTargets(head, words, args);
  const reaches: PathReach[] = [];
  const candidates = headToken === undefined ? args : [headToken, ...args];
  for (const word of candidates) {
    if (word.operator) continue;
    // ⛔ `targets` IS CONSULTED BEFORE `prose`, and the order is the whole fix.
    // {@link proseOperands} marks every non-flag operand of `echo`/`printf` as text
    // to emit — the token after `>` included — so `echo boom > <harness>/staged/s/
    // SKILL.md`, the control arm OVERWRITING the treatment arm's staged skill,
    // produced `hits: []` while `cat x > <same path>` fired correctly. A redirect
    // DESTINATION is an operand whoever wrote the bytes, which is what
    // {@link writeTargets}' own docblock has always claimed.
    if (prose.has(word) && !targets.has(word)) continue;
    if (!isPathCandidate(word.text) && !isBareDeclaredExecutable(word.text, intent, ctx)) continue;
    const resolved = resolvePathToken(word.text, cwd);
    if (resolved === undefined) continue;
    reaches.push({
      resolved,
      intent: targets.has(word) ? 'write' : intent,
      text: command,
      index: word.index,
      length: word.length,
    });
  }
  return reaches;
}

/* ────────────────────────── assembling the verdict ────────────────────────── */

/**
 * Does this resolved path lie OUTSIDE the arm's own workspace?
 *
 * ⚠️ NOT "a prefix test and nothing else", which is what this used to claim: the
 * `/` BOUNDARY is the test. A bare `startsWith` reports the arm's own tree as
 * containing `<workspace>-other/scripts/summary.mjs`, a sibling directory that
 * merely shares its name as a prefix — the same over-match
 * {@link containsPathAtBoundary} exists for one level up.
 *
 * 📌 An `armWorkspaceDir === ''` guard returning `true` was MEASURED OUT as dead:
 * {@link scanDegradation} reports `cwd-unknown` and the structured path never runs
 * when the workspace is empty, so nothing can reach it. Forcing this predicate to a
 * constant `true` still kills four tests, so the predicate itself is live.
 */
function pathEscapesWorkspace(resolved: string, armWorkspaceDir: string): boolean {
  return resolved !== armWorkspaceDir && !resolved.startsWith(`${armWorkspaceDir}/`);
}

function structuredExecutableHits(
  input: DetectBaselineContaminationInput,
  reaches: readonly PathReach[],
  armWorkspaceDir: string,
  claimed: Set<string>,
): BaselineContaminationHit[] {
  const hits: BaselineContaminationHit[] = [];
  for (const declaredPath of input.executablePaths ?? []) {
    const needle = declaredExecutableNeedle(declaredPath);
    if (needle === undefined) continue;
    // ⛔ EVERY REACH, NOT JUST THE FIRST — which the comment here has always said
    // and the code stopped doing. `reaches.find(…)` returned the FIRST escaping
    // name-matching reach and the `claimed` test then DISCARDED it, never looking at
    // the ones behind it: `cat <harness>/staged/s/scripts/summary.py` followed by
    // `python3 /users/dev/repo/dist/plugins/s/scripts/summary.py data.csv` reported
    // `harness-path` alone, while the same two commands in the opposite order
    // reported both. That is the READ-versus-RAN distinction — the first thing an
    // operator triaging a contaminated run wants — lost to statement order.
    const reach = reaches.find((r) => {
      if (r.intent !== 'retrieval' || claimed.has(r.resolved)) return false;
      return reachIsDeclaredExecutable(r.resolved, needle) && pathEscapesWorkspace(r.resolved, armWorkspaceDir);
    });
    // A reach already reported as a harness / sibling / private-dir hit is ONE
    // reach; reporting it again as an executable would double-count it. Deduping
    // on the RESOLVED PATH rather than on excerpt text is what makes this
    // case-proof — the old excerpt-substring test compared a raw declared name
    // against an unconditionally lowercased excerpt, so any name with a capital
    // (`Summarize`) escaped the dedupe and was reported twice.
    if (reach === undefined) continue;
    claimed.add(reach.resolved);
    hits.push({
      kind: KIND_DECLARED_EXECUTABLE,
      match: declaredPath,
      excerpt: excerptAround(reach.text, reach.index, reach.length),
    });
  }
  return hits;
}

/**
 * Glob metacharacters a shell expands and this walk cannot.
 *
 * `~` is deliberately absent — {@link resolvePathToken} keeps a `~`-rooted token as
 * written on purpose, and that is a KNOWN root, not an unknown segment.
 *
 * ⛔ `{`/`}` USED TO BE ABSENT TOO, and brace expansion is a shell expansion exactly
 * like `*`. Measured: `cat ../../../{vat-skill-test,zz}/k/staged/s/SKILL.md` and
 * `cat ../../../vat-skill-{test,x}/k/staged/s/SKILL.md` both reported `hits: []`
 * with no degradation — the same bytes as a clean scan — while
 * `cat ../../../vat-*&#47;k/staged/s/SKILL.md`, the identical reach, degraded. A brace
 * around a directory name defeats all three literal needles for the same reason a
 * `*` does.
 */
const GLOB_METACHARACTERS = /[*?[{}]/;

/**
 * The LITERAL segments of every directory needle, as one set.
 *
 * Derived from the needles the scan already builds rather than from a second
 * hand-maintained list. A second list that has to agree with the first is the
 * failure this module keeps having, and it would go stale the first time a needle
 * builder changed shape.
 */
function needleSegmentSet(needles: readonly PathNeedle[]): ReadonlySet<string> {
  const segments = new Set<string>();
  for (const { needle } of needles) for (const segment of normalizedSegments(needle)) segments.add(segment);
  return segments;
}

/** The index of the LAST glob metacharacter in `segment`, or `-1`. */
function lastMetacharacterIndex(segment: string): number {
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    if (GLOB_METACHARACTERS.test(segment.charAt(index))) return index;
  }
  return -1;
}

/**
 * Could this globbed path segment expand to something a needle segment names?
 *
 * ⚠️ DELIBERATELY CONSERVATIVE, AND CONSERVATIVE MEANS DEGRADING. Only the LITERAL
 * RUN BEFORE the first metacharacter and the one AFTER the last are consulted; a
 * literal caught BETWEEN two metacharacters is ignored, because for a brace
 * (`{a,b}`) the text inside is a set of alternatives rather than something that
 * must appear, and a rule that cannot tell the two apart must not convict on the
 * middle. That leaves `vat-&#42;` consistent with `vat-skill-test`, `vat-&#42;-test`
 * consistent with it from both ends, `&#42;` consistent with everything — and
 * `build-&#42;` consistent with nothing this scan is looking for.
 *
 * This is NOT a glob matcher and must not grow into one. It answers one question:
 * is there any way this segment could have been standing where a needle segment
 * was? When in doubt the answer is yes.
 */
function globSegmentCouldHideANeedle(segment: string, needleSegments: ReadonlySet<string>): boolean {
  const first = segment.search(GLOB_METACHARACTERS);
  if (first === -1) return false;
  const prefix = segment.slice(0, first);
  const suffix = segment.slice(lastMetacharacterIndex(segment) + 1);
  for (const needle of needleSegments) {
    if (prefix.length + suffix.length > needle.length) continue;
    if (needle.startsWith(prefix) && needle.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Does this reach's glob stand where a NEEDLE SEGMENT could have been hidden?
 *
 * ⛔ "ESCAPES THE WORKSPACE" IS NOT A NARROWING ON ITS OWN, and treating it as one
 * made this degradation fire on ordinary work. The arm's workspace is a
 * SUBDIRECTORY of the OS temp dir, so every glob over the arm's own `/tmp` scratch
 * escapes it, and the enumeration narrowing does not help because `cat`, `wc`,
 * `diff`, `tar` and `md5sum` are all retrieval. Measured: `cat /tmp/report-*.json`,
 * `cat ~/Downloads/*.csv`, `wc -l /tmp/out*.txt`, `rm -f /tmp/*.tmp` and seven more
 * ordinary commands each stamped `⚠️ DEGRADED SCAN` on a clean verdict — including
 * this module's own flagship innocent fixture, the arm writing a scratch file and
 * reading it back, spelled `cat /tmp/out-*.txt`.
 *
 * TWO QUESTIONS, and the second is what makes the claim actionable:
 *
 *   - **Is the glob in a DIRECTORY segment?** The blindness this exists for is a
 *     metacharacter standing where a LITERAL NEEDLE SEGMENT would be: all three
 *     harness needles are literal path segments, so
 *     `cat ../../vat-&#42;/&#42;/staged/&#42;/SKILL.md` defeats every one of them. A glob in
 *     the BASENAME hides no directory and can defeat no segment needle.
 *   - **Could that segment have BEEN a needle segment?** See
 *     {@link globSegmentCouldHideANeedle}. Without this the degradation says only
 *     "a glob appeared somewhere outside the workspace", which is true of
 *     `cp /tmp/build-&#42;/out.md .` and tells an operator nothing they can act on. A
 *     warning that fires where nothing could have been hidden is noise, and noise
 *     on this verdict is what teaches people to ignore the one that matters.
 *
 * ⚠️ AN EMPTY NEEDLE SET DEGRADES NOTHING — with no directory needle armed there is
 * nothing for a glob to hide, and a warning there would mean "nothing looked".
 *
 * 📌 AN EXPLICIT `needleSegments.size === 0` EARLY RETURN WAS MEASURED OUT AS DEAD:
 * {@link globSegmentCouldHideANeedle} loops over the set, so an empty one already
 * answers `false`, and deleting the guard left all tests green. The behaviour is
 * pinned by a test rather than by a branch a mutation cannot kill.
 */
function globCouldHideANeedle(resolved: string, needleSegments: ReadonlySet<string>): boolean {
  // `slice(0, -1)` drops the BASENAME: a glob there stands for a filename, and no
  // directory needle segment can be hiding behind a filename.
  return normalizedSegments(resolved)
    .slice(0, -1)
    .some((segment) => globSegmentCouldHideANeedle(segment, needleSegments));
}

/**
 * The degradation owed by a reach whose glob nobody could expand and no needle
 * matched.
 *
 * ⛔ THE THREE HARNESS NEEDLES ARE ALL LITERAL SEGMENTS, needle 3 included, so a
 * glob standing for the harness directory NAME defeats every one of them and the
 * scan reports `hits: []` with `degraded: none` — the same bytes as a clean run.
 * Confirmed: `cat ../../vat-skill-test/*&#47;staged/*&#47;SKILL.md` fires, while
 * `cat ../../vat-*&#47;*&#47;staged/*&#47;SKILL.md` and
 * `cat ../../vat-skill-t*&#47;*&#47;staged/*&#47;SKILL.md` do not.
 *
 * THREE NARROWINGS, all measured against real clean commands rather than assumed,
 * because a degradation on every clean run costs exactly what the executable false
 * positive cost:
 *
 *   - the reach must ESCAPE the arm's own workspace. A glob inside its own tree
 *     (`cat ./fixtures/*.md`) is the ordinary shape of ordinary work.
 *   - the reach must not be an ENUMERATION. `ls -d /tmp/&#42;` and a `Glob` tool call
 *     are orientation — the module already refuses to convict on either — and a glob
 *     is what enumeration is FOR, so degrading there would fire constantly while
 *     saying nothing.
 *   - the metacharacter must stand where a NEEDLE SEGMENT could have been — see
 *     {@link globCouldHideANeedle}.
 */
function globDegradation(
  reaches: readonly PathReach[],
  armWorkspaceDir: string,
  claimed: ReadonlySet<string>,
  needleSegments: ReadonlySet<string>,
): BaselineScanDegradation | undefined {
  const blind = reaches.find(
    (r) => r.intent !== 'enumeration'
      && globCouldHideANeedle(r.resolved, needleSegments)
      && !claimed.has(r.resolved)
      && pathEscapesWorkspace(r.resolved, armWorkspaceDir),
  );
  if (blind === undefined) return undefined;
  return {
    reason: 'glob-unexpanded',
    // Sanitized for the same reason as {@link untrackedCd}: the excerpt is the arm's
    // own text, and this detail is interpolated into a terminal line.
    detail: sanitizeGraderText(
      `a reach outside the arm's workspace carried a glob nothing can expand (${
        excerptAround(blind.text, blind.index, blind.length)
      }) — no needle matched it, and no needle could have`,
    ),
  };
}

/**
 * The three DIRECTORY needle groups, built ONCE per scan.
 *
 * ⛔ ONE LIST, EVERY READER. {@link structuredPathHits}, {@link flatPathHits} and
 * {@link globDegradation} all read this object, so the needles one of them reports
 * on are literally the needles the others searched for. The two scans used to build
 * their own from the same three functions, which is a second list that has to agree
 * with the first — the failure this module keeps having. See
 * {@link needleSegmentSet} for the same rule stated one level down.
 */
interface DirectoryNeedles {
  harness: PathNeedle[];
  sibling: PathNeedle[];
  /** One group per declared private dir, kept separate — see {@link structuredPathHits}. */
  privateDirs: PathNeedle[][];
}

function directoryNeedles(input: DetectBaselineContaminationInput): DirectoryNeedles {
  return {
    harness: harnessNeedles(input.harnessRoot),
    sibling: siblingArmNeedles(input.siblingArmDir ?? ''),
    privateDirs: (input.vatPrivateDirs ?? []).map((dir) => vatPrivateDirNeedles(dir ?? '')),
  };
}

/** Every directory needle group, paired with the hit kind it produces. */
function directoryNeedleGroups(
  needles: DirectoryNeedles,
): ReadonlyArray<readonly [BaselineContaminationHit['kind'], readonly PathNeedle[]]> {
  return [
    [KIND_HARNESS_PATH, needles.harness],
    [KIND_SIBLING_ARM, needles.sibling],
    ...needles.privateDirs.map((group) => [KIND_VAT_PRIVATE_DIR, group] as const),
  ];
}

/** Path/dir hits from the structured walk, in the stable per-group order. */
function structuredPathHits(
  input: DetectBaselineContaminationInput,
  reaches: readonly PathReach[],
  armWorkspaceDir: string,
  { harness, sibling, privateDirs }: DirectoryNeedles,
): {
  dirHits: BaselineContaminationHit[];
  executableHits: BaselineContaminationHit[];
  blindGlob?: BaselineScanDegradation;
} {
  const dirHits: BaselineContaminationHit[] = [];
  const claimed = new Set<string>();
  const push = (hit: BaselineContaminationHit | undefined): void => {
    if (hit !== undefined) dirHits.push(hit);
  };

  push(firstReachHit(reaches, harness, KIND_HARNESS_PATH, claimed));
  push(firstReachHit(reaches, sibling, KIND_SIBLING_ARM, claimed));
  // Per dir, not first-match-wins across all of them: reaching the answer key and
  // reaching the grader dir are two different capabilities, and an operator
  // triaging a contaminated run needs to see both.
  for (const needles of privateDirs) {
    push(firstReachHit(reaches, needles, KIND_VAT_PRIVATE_DIR, claimed));
  }
  const executableHits = structuredExecutableHits(input, reaches, armWorkspaceDir, claimed);
  const blindGlob = globDegradation(
    reaches,
    armWorkspaceDir,
    claimed,
    needleSegmentSet([harness, sibling, ...privateDirs].flat()),
  );
  return { dirHits, executableHits, ...(blindGlob === undefined ? {} : { blindGlob }) };
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
  needles: DirectoryNeedles,
): { dirHits: BaselineContaminationHit[]; executableHits: BaselineContaminationHit[] } {
  const haystack = scanHaystack(input.transcript);
  const dirHits: BaselineContaminationHit[] = [];
  const dirNeedles: string[] = [];

  for (const [kind, group] of directoryNeedleGroups(needles)) {
    const hit = firstNeedleHit(haystack, group, kind);
    if (hit === undefined) continue;
    dirHits.push(hit);
    // The needle as MATCHED, not as reported: `hit.match` has been redacted and is
    // no longer a substring of anything (see {@link pathNeedle}).
    dirNeedles.push(...group.map((n) => n.needle));
  }

  const armDir = normalizeForMatch(input.armWorkspaceDir ?? '');
  const executableHits: BaselineContaminationHit[] = [];
  for (const declaredPath of input.executablePaths ?? []) {
    const needle = declaredExecutableNeedle(declaredPath);
    if (needle === undefined) continue;
    const match = firstEscapingInvocation(haystack.normalized, needle, armDir);
    if (match === undefined) continue;
    if (reachedViaReportedDir(haystack.normalized, match, dirNeedles)) continue;
    executableHits.push({
      kind: KIND_DECLARED_EXECUTABLE,
      match: declaredPath,
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
  // ⛔ THE `trim() !== ''` GUARD THAT USED TO ARM THIS WAS THE HOLE. An EMPTY control
  // transcript skipped the branch and fell through to a walk over zero tool uses:
  // `hits: []`, `degraded: undefined` — and it then COUNTS as an observed eval, so
  // the run summary says "no skill-absent eval was observed reaching the skill" about
  // an eval where nothing was observed at all. Nothing to scan is the most degraded a
  // scan can be, not the least.
  if (!transcriptDecoded(parsed)) {
    const empty = input.transcript.trim() === '';
    return {
      reason: 'transcript-unparsed',
      // Sanitized for the same reason as {@link untrackedCd}, even though this
      // detail is vat-authored and carries nothing from the arm: the property that
      // no degradation detail can forge a terminal line has to hold by
      // CONSTRUCTION, not by which of the three sites somebody audited.
      detail: sanitizeGraderText(
        empty
          ? 'the control arm produced an empty transcript, so nothing was scanned for this eval'
          : `${input.transcript.length} chars of transcript yielded no stream-json events`,
      ),
    };
  }
  if (normalizeForMatch(input.armWorkspaceDir ?? '') === '') {
    return {
      reason: 'cwd-unknown',
      detail: sanitizeGraderText(
        'no armWorkspaceDir was supplied, so no relative path in the transcript can be anchored',
      ),
    };
  }
  return undefined;
}

/**
 * How many transcript lines failed to parse.
 *
 * The parser exposes `malformedLineCount` precisely so a consumer can see the holes
 * it used to fill silently: a bare `continue` on a `JSON.parse` failure meant one
 * corrupted line could delete a contamination hit while the scan still reported full
 * strength, because `transcriptDecoded` is an any-of test that the terminal `result`
 * line alone satisfies.
 *
 * There is deliberately no local fallback count. A second implementation here could
 * disagree with the parser about what "malformed" means, and the whole point of the
 * field is that ONE place decides. (A build-order bridge lived here while the parser
 * change and this consumer landed together — `@vibe-agent-toolkit/utils` resolves to
 * its built `dist` under vitest, so the field was absent at test runtime until the
 * next build, and an absent count reads as zero. It has been rebuilt; the bridge is
 * gone. If this ever reads `undefined` again, that is a BUILD problem, not a reason
 * to re-add a local counter.)
 */
function malformedTranscriptLines(parsed: ParsedTranscript): number {
  return parsed.malformedLineCount;
}

function malformedDegradation(count: number): BaselineScanDegradation {
  return {
    reason: 'transcript-malformed',
    detail: sanitizeGraderText(
      `${count} transcript line(s) failed to parse and were dropped, so the structured scan ` +
        'saw a transcript with holes in it',
    ),
  };
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

  const blind = scanDegradation(input, parsed);
  const armDir = normalizeForMatch(input.armWorkspaceDir ?? '');
  const startCwd = normalizeForMatch(input.armCwd ?? '') || armDir;
  const ctx: WalkContext = {
    declaredBasenames: new Set(
      (input.executablePaths ?? [])
        .map((declared) => declaredExecutableNeedle(declared))
        .filter((needle) => needle !== undefined)
        .map((needle) => basenameOf(needle)),
    ),
  };
  const walked = blind === undefined ? walkToolReaches(parsed, startCwd, ctx) : undefined;

  // ⛔ THE FLAT FALLBACK IS FOR A TRANSCRIPT WE CANNOT WALK, NOT FOR A `cd` WE
  // CANNOT EVALUATE. It used to be for both, and that cost more than it saved in
  // both directions: one leading `cd $HOME` made the canonical four-step reach chain
  // read `hits: []`, and one leading `cd $HOME` plus a `find` that merely LISTED the
  // temp dir produced `harness-path` AND `vat-private-dir` — the flat scanner's
  // over-reporting reproduced verbatim, on the verdict reserved for "reached the
  // answer key". Reaches resolved BEFORE the bad `cd` are still validly resolved,
  // and {@link walkToolReaches} degrades forward from the point of uncertainty.
  // A dropped transcript line is a HOLE in the scan and nothing said so: the parser
  // skipped it in silence, and `transcriptDecoded` — an any-of test the terminal
  // `result` line satisfies on its own — still reported the transcript as decoded,
  // so one corrupted tool call DELETED a contamination hit under a confident verdict.
  const malformed = malformedTranscriptLines(parsed);

  const needles = directoryNeedles(input);
  const { dirHits, executableHits, blindGlob } =
    walked === undefined
      ? { ...flatPathHits(input, needles), blindGlob: undefined }
      : structuredPathHits(input, walked.reaches, armDir, needles);

  // Ordered by how much of the scan each one costs: no structured scan at all, then
  // a cwd hole, then a transcript hole, then a single reach nothing could expand.
  const degraded =
    blind
    ?? walked?.untracked
    ?? (malformed > 0 ? malformedDegradation(malformed) : undefined)
    ?? blindGlob;

  return {
    hits: [...dirHits, ...(contentHit === undefined ? [] : [contentHit]), ...executableHits],
    ...(degraded === undefined ? {} : { degraded }),
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
  // The NEEDLE, not the raw string's length: see {@link declaredExecutableNeedle}.
  // This is the arming test and the matching test at once, which is the only shape
  // in which they cannot disagree.
  if ((input.executablePaths ?? []).some((declared) => declaredExecutableNeedle(declared) !== undefined)) {
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
  /**
   * How many CONTROL-ARM evals were actually scanned for contamination.
   *
   * ⛔ REQUIRED, and for the same reason the other four are: every one of these is a
   * coverage claim, and a default lets a caller overclaim silently in the direction
   * where the claim gets believed. Confirmed on a real run where both control arms
   * died on an executor timeout, so ZERO transcripts were scanned and `baseline.json`
   * still opened with "No skill-absent eval was observed reaching the skill. The A/B
   * delta is interpretable as instruction lift" — two false sentences, with the
   * correction arriving third. A count of zero means nothing was looked at, which is
   * not the same finding as looking and seeing nothing, and
   * {@link summarizeBaselineIntegrity} now leads with the absence rather than
   * burying it.
   *
   * Pass the number of control-arm evals whose transcript reached
   * {@link detectBaselineContamination}, NOT the number of evals declared.
   */
  observedEvals: number;
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
  const { findings, signals, skew, degraded, controlArmFailures, observedEvals } = input;
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
      : ` ⚠️ DEGRADED SCAN: ${degraded.length} eval(s) did not get a full structured scan ` +
        `[${degradedIds}]. An unparseable transcript falls back to flat text matching, which both ` +
        'over- and under-reports; an unevaluable `cd` or a dropped transcript line instead leaves a ' +
        'HOLE — everything resolved up to that point stands, and nothing after it that needed a cwd ' +
        'was resolved at all. Either way a clean verdict here is not the same claim as a clean ' +
        'structured scan.';
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

  // ⛔ NOTHING WAS OBSERVED, so nothing may be reported as observed. The absence
  // LEADS: on the run this was found on, the two false sentences came first and
  // `CONTROL ARM DID NOT RUN` came third, so the reader met the reassurance before
  // the retraction. "Interpretable as instruction lift" is dropped outright rather
  // than qualified — there is no delta to interpret when no control arm ran.
  if (observedEvals === 0) {
    return {
      ...base,
      contaminated: false,
      summary:
        'NOT CHECKED: no skill-absent eval was scanned, so `contaminated: false` records that nothing ' +
        `was looked at — not that nothing was found (${describeSignals(signals)}).` +
        controlNote +
        skewNote +
        degradedNote,
      findings: [],
    };
  }
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
