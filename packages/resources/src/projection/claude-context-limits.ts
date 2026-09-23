/**
 * What this answer deliberately does not settle — published WITH the answer.
 *
 * ⛔ The answer is NOT an upper bound. The bounds point in BOTH directions, and
 * the sentence that says so is {@link CLAUDE_CONTEXT_BOUNDS_STATEMENT} — spelled
 * there once and quoted nowhere, including here, so that no paraphrase of it can
 * drift away from the words a consumer actually prints. Never let the output
 * imply otherwise.
 *
 * ## Why the list is data and not prose in a doc
 *
 * Spec §11 is explicit that these are *"written into the command's own output,
 * not buried here"*. A limit a reader has to go and find is a limit that does not
 * reach the person acting on the number, so the command prints them and this
 * module is what it prints.
 *
 * ⛔ Nothing enforces that a new assumption made elsewhere in the lane ARRIVES
 * here — no lint rule, no build step, no cross-check reads the rest of the lane.
 * What the suite enforces is narrower and worth stating exactly, because an
 * overstated guarantee is how the real gap goes unnoticed: the length assertion
 * is a CHANGE DETECTOR that fails when this list grows or shrinks, and the
 * by-name assertions beside it fail when a specific published id disappears.
 * Together they catch an edit to this file — an earlier draft reused
 * {@link CLAUDE_CONTEXT_LIMITS}' `cliff-scope` slot for `nested-rule-trigger`,
 * which the length assertion alone would have passed. They cannot catch an
 * assumption introduced three modules away and never written down; that is a
 * review obligation, not a test.
 *
 * ## `direction` is the whole point
 *
 * `over-report` and `under-report` are not severities, they are SIGNS. A reader
 * who knows only "there are caveats" learns nothing; a reader who knows the
 * unread `claudeMdExcludes` can only make the true number smaller and the unseen
 * auto memory can only make it larger can reason about which way to hedge.
 * `scope` marks a question this answer is not addressed to at all, and
 * `assumption` marks a rule VAT applies that the vendor has never stated.
 *
 * ## Which limits the loader oracle retired
 *
 * Every entry is one of two kinds, marked at the entry. **vendor-unknowable** —
 * the fact lives outside the tree (a user's settings, approvals, flags, the
 * filesystem's case rule, the model's tokenizer), so no reading of the binary
 * can settle it. **oracle-answered** — the shipped loader answers it
 * (`docs/external/claude-code-memory-loader.md`), and the entry stays only
 * because VAT does not yet implement that answer. An oracle-answerable limit
 * VAT now implements is DELETED, not kept as a caveat: `cliff-scope`,
 * `root-claude-md-order`, `nested-rule-trigger`, `variable-imports-unfollowed`,
 * `nested-rule-glob-base`, `html-comments` and `import-dialect` went that way, each held by
 * `projection-claude-loader-differential.test.ts` (the last also by the rules
 * differential, `projection-claude-context-rules-differential.test.ts`).
 */

/** One thing this answer deliberately does not settle. */
export interface StatedLimit {
  readonly id: string;
  readonly direction: 'over-report' | 'under-report' | 'scope' | 'assumption';
  readonly statement: string;
}

/**
 * A behaviour this model reproduces, and the client version that introduced it.
 *
 * ⛔ Deliberately NOT a single "assumed Claude Code version" constant. One
 * hand-maintained version string is what this repo prohibits, and it would rot
 * silently — a reader could not tell WHICH of the modelled behaviours had moved.
 * A list of dated citations can be checked one entry at a time.
 *
 * `introducedIn` records the VENDOR's version, transcribed from the cited doc. It
 * is a citation, never a version of VAT's own.
 */
export interface ModelledBehaviour {
  readonly behaviour: string;
  readonly introducedIn: string;
  readonly citedFrom: string;
}

/**
 * The four directions, spelled once each.
 *
 * Extracted for `sonarjs/no-duplicate-string`, which counts the repeated literal
 * across every entry — and they read better named anyway, since a `direction` is
 * a closed vocabulary rather than incidental text.
 */
const OVER_REPORT = 'over-report';
const UNDER_REPORT = 'under-report';
const SCOPE = 'scope';
const ASSUMPTION = 'assumption';

/**
 * The same four, as a runtime list.
 *
 * ⛔ The ONE source for the vocabulary. A consumer that validates a published
 * limit — `vat resources check` builds a Zod enum from this — must not spell
 * the four out again: a fifth direction added here would leave that copy
 * silently rejecting the new value, and a renamed one would leave it accepting
 * a value nothing produces. `satisfies` ties the list to the union, so the two
 * cannot drift in either direction.
 */
export const LIMIT_DIRECTIONS = [
  OVER_REPORT,
  UNDER_REPORT,
  SCOPE,
  ASSUMPTION,
] as const satisfies readonly StatedLimit['direction'][];

/** The one doc every modelled behaviour is cited from, with its fetch date. */
const MEMORY_DOC = 'https://code.claude.com/docs/en/memory (fetched 2026-08-21)';

/**
 * The one sentence that frames {@link CLAUDE_CONTEXT_LIMITS}, and is never omitted.
 *
 * ⛔ It lives HERE, beside the list, rather than in the command that prints it.
 * The list is published data and any consumer can render all of it; a consumer
 * that rendered every limit while omitting this sentence would be presenting
 * signed, directional caveats as a checklist of edge cases, which is the one
 * reading spec §11 exists to prevent. A sentence stranded in `packages/cli` is a
 * sentence no other consumer can reach, so the omission would be silent.
 *
 * It says both directions on purpose: a reader who takes the number for an upper
 * bound will under-provision, and one who takes it for a lower bound will
 * over-trim.
 */
export const CLAUDE_CONTEXT_BOUNDS_STATEMENT =
  'This estimate is neither a floor nor a ceiling — it carries named, directional'
  + ' uncertainty in both directions. Every limit listed applies whether or not the'
  + ' unknown-size, skipped and pruned counters are zero.';

/**
 * Every stated limit, in the order the command prints them: the two report
 * directions first, then the questions out of scope, then the rules VAT assumes.
 */
export const CLAUDE_CONTEXT_LIMITS: readonly StatedLimit[] = [
  // vendor-unknowable: merged user and managed settings, outside the tree.
  { id: 'claude-md-excludes', direction: OVER_REPORT, statement: '`claudeMdExcludes` is not read. It removes CLAUDE.md files AND rules files by glob, merged across four settings layers — two of which live outside the repo (`~/.claude/settings.json` and the managed-policy path). It also silences the root-scope rule classification.' },
  // vendor-unknowable: a launch flag.
  { id: 'setting-sources', direction: OVER_REPORT, statement: '`--setting-sources` is not read. Excluding `project` skips project rules; excluding `local` skips `CLAUDE.local.md`. Both are counted unconditionally here and are conditional in reality. A DIFFERENT mechanism from `claudeMdExcludes` — neither bound stands in for the other.' },
  // oracle-answered: the matcher is the harness's own; the two remaining bounds are stated in it.
  { id: 'glob-dialect', direction: OVER_REPORT, statement: 'The matcher is the harness\'s own engine: `paths:` globs are compiled with the `ignore` package over the patterns the harness normalises, brace-expands and strips a trailing `/**` from, which is GITIGNORE dialect — a pattern with no slash matches at any depth, a matched directory carries its whole subtree, a dotfile is an ordinary name, a leading `!` excludes what the patterns before it matched, and `+(a|b)` and a leading `./` are literal text to the matcher. Two bounds remain. The `node-ignore` copy bundled in Claude Code 2.1.280 is a slightly earlier release than the `ignore` this depends on; the two agree on every one of 5,723,140 (glob, path) pairs drawn from a 13-repository corpus plus a synthetic battery of gitignore shapes, and they are still not the same bytes. And a pattern the vendor\'s expansion budget refuses is reported `status = \'unevaluated\'` rather than matched with its braces literal, which keeps VAT\'s declined work distinguishable from a glob that is genuinely dead — the refusal is per PATTERN, so a live entry beside a refused one is evaluated normally.' },
  // VAT's own question: a directory query has no single file to test.
  { id: 'directory-glob', direction: OVER_REPORT, statement: 'A directory query classifies a path-scoped rule as ∀ (the rule covers every path under the directory) or ∃ (at least one realized file there is loaded by the rule, and the answer names it). Both are decided on the rule\'s WHOLE `paths:` list, negations included, so an excluded file is never the witness. ∃ is an over-report against any ONE file in it: the rule is charged to the directory though most files there may not match. Only a FILE query is exact. ∀ is decided by asking the whole-list matcher about the query DIRECTORY, which gitignore answers for its whole subtree, so ∀ is SOUND — never claimed for a directory the rule does not cover — but not complete: a list can load every path under a directory without matching the directory itself (`docs/*` at `docs` matches each child but not `docs`), and such a rule is reported as ∃, which under-states the burden without ever over-stating it. A rule\'s own BASE cannot be asked at all — the corpus root for a root rule, the directory holding its `.claude/rules` for a nested one: the path relative to it is empty, and `ignore` refuses an empty path — so only the whole-tree globs `**` and `**/*` with no negation after them are accepted there, and a query at the base reports a rule that covers everything by some subtler construction as ∃ too.' },
  // vendor-unknowable: outside the tree.
  { id: 'auto-memory', direction: UNDER_REPORT, statement: 'Auto memory is not seen. The first 200 lines of MEMORY.md, or the first 25 KB, whichever comes first, load at the start of every conversation, and auto memory is on by default. It lives outside the corpus root.' },
  // vendor-unknowable: managed settings.
  { id: 'managed-claude-md-key', direction: UNDER_REPORT, statement: 'The managed-policy `claudeMd` settings key is not seen. It carries managed CLAUDE.md content directly inside `managed-settings.json` as a JSON string — not a file at any path — and loads before user and project CLAUDE.md.' },
  // vendor-unknowable: outside the tree.
  { id: 'user-and-managed-scope', direction: UNDER_REPORT, statement: 'Managed-policy and user-scope (`~/.claude/`) CLAUDE.md and rules files are outside the corpus root and are not enumerated.' },
  // vendor-unknowable: a launch flag and an environment variable.
  { id: 'add-dir', direction: UNDER_REPORT, statement: '`--add-dir` with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` loads CLAUDE.md, `.claude/CLAUDE.md`, `.claude/rules/*.md` and CLAUDE.local.md from directories outside the root. Without the env var `--add-dir` loads none of them, and the `additionalDirectories` setting never does.' },
  // VAT's own table key.
  { id: 'unresolved-conditions-collapse', direction: UNDER_REPORT, statement: 'A file with several broken @ imports reports only one of them. Conditions are keyed by file and code with no line or reference, so every unresolved import after the first collapses onto it. Treat the number of broken imports shown as a lower bound, never a total.' },
  // VAT's own decision, stated in the entry.
  { id: 'gitignored-not-realized', direction: UNDER_REPORT, statement: 'A gitignored file is not seen. This lane declines every path the repository ignores, so a generated CLAUDE.md, a generated rules file, or an `@` import resolving into ignored territory contributes nothing here — and the harness would load it, because it reads the FILESYSTEM and not git. The omission is deliberate rather than an oversight: a file that is inside a repository but not in git records neither when nor how it was built, so a total computed against it describes a session state nobody can reproduce. Outside a git working tree nothing is ignored and nothing is declined, so this bound is empty there.' },
  // VAT's own question: files that do not exist yet.
  { id: 'existential-needs-a-file', direction: UNDER_REPORT, statement: 'A directory query\'s ∃ classification is decided against the files that exist RIGHT NOW. A path-scoped rule whose patterns match nothing currently in the tree is absent from THIS answer — not reported as costing zero, absent — and it will fire the moment a matching file is created. So a rule scoped to a generated directory, a not-yet-written package, or a path deleted since the rule was authored makes the directory\'s on-demand total smaller than a future session\'s will be. It is no longer UNNAMEABLE, and that is the half that changed: `claude_rule_patterns` carries one row per declared glob, a dead one reads `status = \'inert\'` with the pattern beside it, and `vat resources check` reports it as CLAUDE_RULE_GLOB_INERT at `info` without being asked. ⚠️ A missing witness there has two other meanings. `status = \'unevaluated\'` says no matcher was run for THAT pattern, because it is the one that exhausted the vendor\'s expansion budget — which is spent per pattern as the list is walked, so a live entry beside a refused one is still evaluated and still reported. `status = \'gitignored\'` says the glob matched nothing this lane realizes and its territory is gitignored — a rule scoped to build output, whose files the harness reads and this lane never does. ⚠️ That verdict is itself an under-report in one shape: an existing match lying strictly INSIDE an ignored directory the glob does not itself reach (`docs` against `sub/x/docs/a.md` under an ignored `/sub`) is invisible to it, because git lists an ignored directory as one entry and seeing inside it means walking ignored territory, so such a glob reads `inert` while it may fire. Either rule is missing from this answer too, and its absence is no evidence its globs are dead: it may well fire. Read `inert`, never `!= \'matched\'`. The ∀ half is immune: it is decided by pattern containment and needs no file to exist.' },
  // VAT's own lens.
  { id: 'discovery-one-hop', direction: SCOPE, statement: 'The discoverable set (--discoverable) follows links authored IN the loaded files and stops there — ONE hop, never transitive. A transitive walk would answer "what is reachable from this tree", which in a cross-linked documentation corpus is the tree, and would be near-identical for every path. It is not a cost: nothing loads a markdown link, so `discoverableTokens` is an upper bound on what following every link once would add, never a charge. It is also not a link-integrity verdict — a target this projection does not realize is reported `unrealized`, which is an absence, not a broken link. `vat resources validate` is the lane that adjudicates that.' },
  // vendor-unknowable: which agent asks.
  { id: 'main-conversation-only', direction: SCOPE, statement: 'The answer is for the MAIN CONVERSATION only. A subagent receives the full CLAUDE.md hierarchy except that the built-in Explore and Plan agents skip it, with no frontmatter field or per-agent setting to change which agents skip them, and a non-fork subagent does not inherit auto memory. For those two agents the true answer is ZERO, not this number.' },
  // vendor-unknowable: which client version runs.
  { id: 'version-gated', direction: SCOPE, statement: 'Behaviours are version-gated and this answer pins no floor — see the modelled-behaviour list. The gate that carries a direction is symlinks: from v2.1.198 the harness matches a symlinked path against a path-scoped rule, while this lane realizes no symlink path at all — the filesystem walk sets `followSymlinks: false`, and the git route drops one in a single place for both of the sources it answers from: git\'s mode-`120000` bit for anything the tree snapshot described, an `lstat` for the collapsed `ls-files --others` entries git spells exactly like files — so a rule whose patterns match only a symlinked name is absent from the answer. That is an under-report, and it is the only direction available here: a symlink path is never a member, so nothing can be charged twice under two names. The vendor states no version gate for the other half, but the same absence applies to it — a CLAUDE.md, a rules file or an `@` import reachable only through a symlinked name is uncounted. A query ON a symlinked path yields no wrong number: nothing realizes it, so the answer is `unknown`. The absence is recorded, not silent: every link the lane keeps (a gitignored link is declined with the other ignored rows) is a `realization_conditions` row at the link\'s path, under `EXTENT_SYMLINK_NOT_REALIZED` when its target is in-root — naming that target and whether it is realized — and under `EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT` when the target resolves outside the root, which is never named, or `EXTENT_SYMLINK_TARGET_UNRESOLVED` when it resolves to nothing; an answer carries the links beneath its directory, the `CLAUDE.md`-family links on its chain, and every rules-file link.' },
  // vendor-unknowable: a per-user approval.
  { id: 'outside-root-is-not-external', direction: OVER_REPORT, statement: 'An import that resolves OUTSIDE THE SESSION\'S WORKING DIRECTORY is external, and the harness follows it only once the user has approved external includes for the project — otherwise it is skipped with everything it imports. For a session below the repository root that includes a root CLAUDE.md\'s imports of sibling directories. The approval is per-user state no tree shows, so this answer assumes it was GIVEN. CLOSURE_REFERENCE_OUTSIDE_ROOT is a different set: outside the corpus root, never charged at all.' },
  // VAT's own question.
  { id: 'context-window-scope', direction: SCOPE, statement: 'This answers what INSTRUCTION FILES cost — CLAUDE.md files, rules files and their @ imports — not what the context window holds. The system prompt, the tool and MCP schemas, the active output style, and every skill whose description is loaded also occupy it, and none of them are counted here. The real starting context of a session at this path is LARGER than this number by an amount this command does not measure.' },
  // vendor-unknowable: the model's tokenizer.
  { id: 'token-estimate', direction: ASSUMPTION, statement: 'Every token figure is `characters / 4`, rounded up — no tokenizer and no model vocabulary is consulted, and the count is over decoded UTF-16 code units rather than bytes. On the markdown this command measures the ratio is not 4: code fences, tables, long URLs and non-ASCII text all tokenize denser than prose, and ordinary English prose tokenizes sparser. The error runs in BOTH directions, is unsigned, and is the largest single source of uncertainty in the headline number. Compare two of these estimates to each other freely; do not compare one to a model\'s own token count.' },
  // VAT's own question: a directory query reads no file.
  { id: 'scoped-import-on-read', direction: UNDER_REPORT, statement: 'An IMPORTED file that declares `paths:` of its own, reached from a rules file, is left out of the launch set as the harness leaves it out, and the harness loads it on demand when a file matching ITS globs is read. A FILE query charges it exactly that way. A DIRECTORY query does not: its on-demand set is the path-scoped RULES the ∀/∃ test admits, and no scoped import is charged there, whatever file under the directory would load it.' },
  // vendor-unknowable: the filesystem's case rule.
  { id: 'filesystem-case', direction: OVER_REPORT, statement: '`CLAUDE.md`, `CLAUDE.local.md` and the `.claude` directories are matched case-insensitively, as a case-insensitive filesystem (macOS, Windows) resolves them. The harness asks for the exact names, so on a case-sensitive filesystem a `claude.md` is not read. A rules file\'s `.md` extension is matched exactly, as the harness matches it on every filesystem.' },
  // vendor-unknowable: a server-side feature flag.
  { id: 'agents-md-plugin', direction: UNDER_REPORT, statement: 'AGENTS.md is charged only where something imports it. The harness\'s `agents-md` plugin, behind a server-side flag that defaults off, loads every AGENTS.md on the walk when no CLAUDE.md-family file exists anywhere on it; whether the flag is on for a user is not in the tree.' },
];

/**
 * The version-gated behaviours this model reproduces, each with its own citation.
 *
 * The replacement for the single assumed-version constant the interface docstring
 * refuses: when one of these moves, exactly one entry needs re-checking against
 * exactly one dated fetch.
 */
export const CLAUDE_CONTEXT_MODELLED_BEHAVIOURS: readonly ModelledBehaviour[] = [
  { behaviour: 'Symlinked paths match path-scoped rules', introducedIn: 'v2.1.198', citedFrom: MEMORY_DOC },
  { behaviour: 'Nested `.claude/rules/` directories load on demand', introducedIn: 'v2.1.211', citedFrom: MEMORY_DOC },
  { behaviour: 'A `paths:` list shares a 1,000-pattern / 4 MiB expansion budget', introducedIn: 'v2.1.217', citedFrom: MEMORY_DOC },
  { behaviour: 'A malformed `[` in a pattern matches nothing', introducedIn: 'v2.1.207', citedFrom: MEMORY_DOC },
];

/**
 * The ids of {@link CLAUDE_CONTEXT_LIMITS} that bound the two derived relations
 * `claude_context_chains` and `claude_context_loads` too.
 *
 * The relations hold `vat claude context`'s answer for each chain's
 * representative — always-loaded AND on-demand rows — so every limit on that
 * answer carries across but one: `discovery-one-hop` is about the
 * `--discoverable` set, which the relations do not hold.
 *
 * ⛔ Written out rather than computed as "all but one", so a limit added to the
 * list above has to be ruled in or out here by a person rather than inherited by
 * default.
 */
const RELATION_LIMIT_IDS_FROM_CONTEXT: readonly string[] = [
  'claude-md-excludes',
  'setting-sources',
  'glob-dialect',
  'directory-glob',
  'auto-memory',
  'managed-claude-md-key',
  'user-and-managed-scope',
  'add-dir',
  'unresolved-conditions-collapse',
  'gitignored-not-realized',
  'existential-needs-a-file',
  'main-conversation-only',
  'version-gated',
  'outside-root-is-not-external',
  'context-window-scope',
  'token-estimate',
  'scoped-import-on-read',
  'filesystem-case',
  'agents-md-plugin',
];

/**
 * Select published limits by id, refusing to be quiet about one that moved.
 *
 * ⛔ Throws rather than filtering. A missing id means an entry above was renamed
 * or removed, and the failure this guards is a bound silently disappearing from a
 * report that still looks complete — a reader cannot tell a caveat that was
 * dropped from one that never applied. It runs at MODULE LOAD, so no suite that
 * imports this package can pass over it.
 *
 * @param ids - Ids of {@link CLAUDE_CONTEXT_LIMITS} entries, in the order wanted
 * @returns The entries themselves, by reference, in the requested order
 * @throws Error naming every id that is not in {@link CLAUDE_CONTEXT_LIMITS}
 */
function limitsById(ids: readonly string[]): readonly StatedLimit[] {
  const byId = new Map(CLAUDE_CONTEXT_LIMITS.map((limit) => [limit.id, limit]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `No CLAUDE_CONTEXT_LIMITS entry has the id ${missing.join(', ')}.`
      + ' A stated limit was renamed or removed without being ruled in or out for the relations;'
      + ' fix the id or delete it deliberately, because dropping it silently un-publishes a bound.',
    );
  }
  return ids.map((id) => byId.get(id) as StatedLimit);
}

/**
 * Every limit a statement over `claude_context_chains` / `claude_context_loads`
 * is published with — by `vat resources query` and `vat resources check`, once
 * per report, whenever the claude-context lens was evaluated.
 *
 * The shared block first, in {@link CLAUDE_CONTEXT_LIMITS}' own order, then the
 * two that exist only because the answer is flattened into rows: the collapse
 * that keys them per chain, and the column a launch-cost sum filters on.
 */
export const CLAUDE_CONTEXT_RELATION_LIMITS: readonly StatedLimit[] = [
  ...limitsById(RELATION_LIMIT_IDS_FROM_CONTEXT),
  {
    id: 'chain-on-demand-is-representative',
    direction: SCOPE,
    statement: 'The load rows are computed ONCE per chain, at its `representative`, and'
      + ' `claude_context_chains` maps every other working location onto them. That is exact for'
      + ' the always-loaded rows — a directory with no CLAUDE.md of its own loads exactly what its'
      + ' nearest instructed ancestor loads — and it is NOT exact for the on-demand rows: a'
      + ' path-scoped rule is admitted to a directory only when a file under THAT directory'
      + ' matches, so another location\'s on-demand set can differ from its representative\'s.'
      + ' Read `not-always` rows as the representative\'s; for any other location ask'
      + ' `vat claude context <path>`.',
  },
  {
    id: 'path-scoped-rules-not-charged',
    direction: SCOPE,
    statement: 'A PATH-SCOPED rule — one carrying a `paths:` list — is'
      + ' `launchCharge = \'not-always\'`: it loads when the agent touches a matching file rather'
      + ' than at launch. Its UNSCOPED imports are charged, because the harness reads the rule at'
      + ' launch and keeps them; an unscoped rule in any `.claude/rules/` on the chain is charged'
      + ' too. Its absence from a launch-cost sum is a scope decision, never a'
      + ' finding that it is free — the row is still in the relation, with its tokens.',
  },
];
