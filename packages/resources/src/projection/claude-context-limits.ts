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
  { id: 'claude-md-excludes', direction: OVER_REPORT, statement: '`claudeMdExcludes` is not read. It removes CLAUDE.md files AND rules files by glob, merged across four settings layers — two of which live outside the repo (`~/.claude/settings.json` and the managed-policy path). It also silences the root-scope rule classification.' },
  { id: 'setting-sources', direction: OVER_REPORT, statement: '`--setting-sources` is not read. Excluding `project` skips project rules; excluding `local` skips `CLAUDE.local.md`. Both are counted unconditionally here and are conditional in reality. A DIFFERENT mechanism from `claudeMdExcludes` — neither bound stands in for the other.' },
  { id: 'html-comments', direction: OVER_REPORT, statement: 'Block-level HTML comments are counted though the harness strips them before injection. Documented for CLAUDE.md only — not for rules files, and not verified for imported files — and comments inside code blocks are preserved, which the naive fix would get wrong.' },
  { id: 'glob-dialect', direction: OVER_REPORT, statement: 'The glob matcher is not bug-compatible with the harness: a malformed `[` matches nothing there and something in picomatch. Over-budget brace patterns ARE guarded (treated as literals, matching nothing) and reported; the malformed-`[` case is not.' },
  { id: 'directory-glob', direction: OVER_REPORT, statement: 'A directory query classifies a path-scoped rule as ∀ (some pattern covers every path under the directory) or ∃ (at least one realized file there matches, and the answer names it). ∀ is exact for the directory. ∃ is an over-report against any ONE file in it: the rule is charged to the directory though most files there may not match. Only a FILE query is exact. ∀ is decided by pattern containment alone and is deliberately conservative — a glob-free prefix plus `/**` — so a rule that covers a directory by some subtler construction is reported as ∃ instead, which under-states the burden without ever over-stating it.' },
  { id: 'auto-memory', direction: UNDER_REPORT, statement: 'Auto memory is not seen. The first 200 lines of MEMORY.md, or the first 25 KB, whichever comes first, load at the start of every conversation, and auto memory is on by default. It lives outside the corpus root.' },
  { id: 'managed-claude-md-key', direction: UNDER_REPORT, statement: 'The managed-policy `claudeMd` settings key is not seen. It carries managed CLAUDE.md content directly inside `managed-settings.json` as a JSON string — not a file at any path — and loads before user and project CLAUDE.md.' },
  { id: 'user-and-managed-scope', direction: UNDER_REPORT, statement: 'Managed-policy and user-scope (`~/.claude/`) CLAUDE.md and rules files are outside the corpus root and are not enumerated.' },
  { id: 'add-dir', direction: UNDER_REPORT, statement: '`--add-dir` with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` loads CLAUDE.md, `.claude/CLAUDE.md`, `.claude/rules/*.md` and CLAUDE.local.md from directories outside the root. Without the env var `--add-dir` loads none of them, and the `additionalDirectories` setting never does.' },
  { id: 'unresolved-conditions-collapse', direction: UNDER_REPORT, statement: 'A file with several broken @ imports reports only one of them. Conditions are keyed by file and code with no line or reference, so every unresolved import after the first collapses onto it. Treat the number of broken imports shown as a lower bound, never a total.' },
  { id: 'variable-imports-unfollowed', direction: UNDER_REPORT, statement: 'An import whose path contains a variable — `@${VAR}/path.md`, `@$HOME/notes.md` — is never followed, and nothing says so. The lexer classifies any token carrying a variable expansion as `env-anchored`, and only `at-prefixed` tokens are followed, so such an import produces no member, no tokens AND no condition row: it is absent from the answer rather than flagged in it. Whatever the variable expands to in a real session, and everything that file imports, is uncounted.' },
  { id: 'gitignored-not-realized', direction: UNDER_REPORT, statement: 'A gitignored file is not seen. This lane declines every path the repository ignores, so a generated CLAUDE.md, a generated rules file, or an `@` import resolving into ignored territory contributes nothing here — and the harness would load it, because it reads the FILESYSTEM and not git. The omission is deliberate rather than an oversight: a file that is inside a repository but not in git records neither when nor how it was built, so a budget computed against it describes a session state nobody can reproduce. Outside a git working tree nothing is ignored and nothing is declined, so this bound is empty there.' },
  { id: 'existential-needs-a-file', direction: UNDER_REPORT, statement: 'A directory query\'s ∃ classification is decided against the files that exist RIGHT NOW. A path-scoped rule whose patterns match nothing currently in the tree is absent from the answer — not reported as costing zero, absent — and it will fire the moment a matching file is created. So a rule scoped to a generated directory, a not-yet-written package, or a path deleted since the rule was authored is invisible here, and the directory\'s on-demand total is smaller than a future session\'s will be. The ∀ half is immune: it is decided by pattern containment and needs no file to exist.' },
  { id: 'discovery-one-hop', direction: SCOPE, statement: 'The discoverable set (--discoverable) follows links authored IN the loaded files and stops there — ONE hop, never transitive. A transitive walk would answer "what is reachable from this tree", which in a cross-linked documentation corpus is the tree, and would be near-identical for every path. It is not a cost: nothing loads a markdown link, so `discoverableTokens` is an upper bound on what following every link once would add, never a charge. It is also not a link-integrity verdict — a target this projection does not realize is reported `unrealized`, which is an absence, not a broken link. `vat resources validate` is the lane that adjudicates that.' },
  { id: 'main-conversation-only', direction: SCOPE, statement: 'The answer is for the MAIN CONVERSATION only. A subagent receives the full CLAUDE.md hierarchy except that the built-in Explore and Plan agents skip it, with no frontmatter field or per-agent setting to change which agents skip them, and a non-fork subagent does not inherit auto memory. For those two agents the true answer is ZERO, not this number.' },
  { id: 'version-gated', direction: SCOPE, statement: 'Behaviours are version-gated and this answer pins no floor — see the modelled-behaviour list. The gate that carries a direction is symlinks: from v2.1.198 the harness matches a symlinked path against a path-scoped rule, while this lane realizes no symlink path at all — the filesystem walk sets `followSymlinks: false` and the git route drops the mode-`120000` entry — so a rule whose patterns match only a symlinked name is absent from the answer. That is an under-report, and it is the only direction available here: a symlink path is never a member, so nothing can be charged twice under two names. The vendor states no version gate for the other half, but the same absence applies to it — a CLAUDE.md, a rules file or an `@` import reachable only through a symlinked name is uncounted. A query ON a symlinked path yields no wrong number: nothing realizes it, so the answer is `unknown`.' },
  { id: 'outside-root-is-not-external', direction: SCOPE, statement: 'CLOSURE_REFERENCE_OUTSIDE_ROOT is NOT "external". External is defined against the WORKING DIRECTORY, which is not present in the tree at all, so VAT cannot identify the external set — and therefore cannot know which imports were subject to the approval dialog that may have disabled them.' },
  { id: 'context-window-scope', direction: SCOPE, statement: 'This answers what INSTRUCTION FILES cost — CLAUDE.md files, rules files and their @ imports — not what the context window holds. The system prompt, the tool and MCP schemas, the active output style, and every skill whose description is loaded also occupy it, and none of them are counted here. The real starting context of a session at this path is LARGER than this number by an amount this command does not measure.' },
  { id: 'cliff-scope', direction: SCOPE, statement: 'The 4 MiB cliff is documented for CLAUDE.md ONLY — not for rules files and not for imported files — so it is applied to `claude-md` members alone. Applying it more widely would be an assertion the vendor has not made. The SUBTREE PRUNE behind a skipped file is not so limited: a file the harness never read cannot have loaded its imports, whatever type they are.' },
  { id: 'token-estimate', direction: ASSUMPTION, statement: 'Every token figure is `characters / 4`, rounded up — no tokenizer and no model vocabulary is consulted, and the count is over decoded UTF-16 code units rather than bytes. On the markdown this command measures the ratio is not 4: code fences, tables, long URLs and non-ASCII text all tokenize denser than prose, and ordinary English prose tokenizes sparser. The error runs in BOTH directions, is unsigned, and is the largest single source of uncertainty in the headline number. Compare two of these estimates to each other freely; do not compare one to a model\'s own token count.' },
  { id: 'root-claude-md-order', direction: ASSUMPTION, statement: 'The order of `./CLAUDE.md` against `./.claude/CLAUDE.md` is ASSUMED, not cited: root CLAUDE.md, then `.claude/CLAUDE.md`, then CLAUDE.local.md. The vendor documents the first two as alternative locations and never their relative order.' },
  { id: 'dot-matching', direction: ASSUMPTION, statement: '`dot: true` on the `paths:` matcher is an ASSUMPTION. Anthropic documents nothing about dotfile matching there. It is kept because adopter paths traverse `.claude/`.' },
  { id: 'nested-rule-trigger', direction: ASSUMPTION, statement: 'The trigger for a NESTED paths-less rule is ASSUMED to be a query at or below the rules directory\'s parent — the directional analogue of the subdirectory-CLAUDE.md rule. The vendor states only that nested rules directories are in the on-demand class. Such rules are never counted into the always-loaded total.' },
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
