/**
 * The trap corpus — a small tree in which every file exists to make one
 * specific defect observable.
 *
 * VAT's committed fixtures could not do this job. Two holes in particular:
 *
 * - **Every VAT fixture is a git repository.** That masked a defect worth 88%
 *   of one command's runtime, because the defect *cannot fire inside a repo*:
 *   `crawlDirectory` answers from `git ls-files` when there is a git root and
 *   from a recursive walk when there is not, and those are different code
 *   paths with different orderings, different ignore semantics and different
 *   symlink handling. {@link materializeTrapCorpus} therefore defaults to **no
 *   git**, and initializing one is an explicit opt-in.
 * - **All 13 of VAT's dogfood skills bundle exactly zero files** — source and
 *   built both report `fileCount: 1, maxLinkDepth: 0`. See
 *   {@link BUNDLING_SKILL_FILES} for the fixture that fixes that, and the
 *   integration test that uses it.
 *
 * The corpus is built from code rather than shipped as an archive on purpose:
 * symlinks do not survive a ZIP round-trip reliably across platforms, and the
 * ones here are load-bearing. Building from code also lets the corpus *ask*
 * whether this host can make symlinks at all rather than assume it.
 */

import { symlinkSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safeExecResult, safePath } from '@vibe-agent-toolkit/utils';

/** A regular file in the corpus: forward-slashed relative path → contents. */
export type CorpusFiles = Readonly<Record<string, string>>;

/** A symlink in the corpus. */
export interface CorpusSymlink {
  /** Forward-slashed relative path of the link itself. */
  path: string;
  /** The link's target, exactly as it should be stored (usually relative). */
  target: string;
}

/** What a materialized corpus turned out to support on this host. */
export interface MaterializedCorpus {
  /** Absolute root the corpus was written to. */
  root: string;
  /** True when the symlink entries were actually created. */
  symlinksCreated: boolean;
  /** True when `git init` + an initial commit ran. */
  gitInitialized: boolean;
}

/**
 * Regular files. Each entry names the defect it makes observable — if a file
 * here stops earning that sentence, delete it rather than letting the corpus
 * grow into scenery.
 */
export const TRAP_CORPUS_FILES: CorpusFiles = Object.freeze({
  // Ordinary root document with links out, so every lane has something to find.
  'README.md': [
    '# Trap corpus',
    '',
    'A [guide](docs/guide.md), a [page](docs/page.html) and a [missing file](docs/nowhere.md).',
    '',
  ].join('\n'),

  // Frontmatter + headings + anchors: the ordinary parse-fact case.
  'docs/guide.md': [
    '---',
    'title: Guide',
    'description: An ordinary document, so the snapshot has a baseline to be unlike.',
    '---',
    '',
    '# Guide',
    '',
    'See [the sibling](sibling.md) and [back up](../README.md).',
    '',
    '## Nested heading',
    '',
    '## Nested heading',
    '',
    'Two identical headings, because slug disambiguation is a parse fact and a',
    'silent renumbering of it would move every cross-file anchor.',
    '',
  ].join('\n'),

  'docs/sibling.md': '# Sibling\n\nNothing special. Exists so a link resolves.\n',

  // Case: a link to `case.md` against a file named `Case.md` resolves on macOS
  // and Windows and breaks on Linux. `verifyCaseSensitiveFilename` is one of
  // the three checks that reads the filesystem at judgement time.
  'docs/Case.md': '# Case\n\nReferenced with the wrong case from links/to-case.md.\n',
  'links/to-case.md': '# Wrong case\n\n[Case](../docs/case.md)\n',

  // HTML: a member of the corpus that is NOT routable. Three lanes crawl
  // markdown only, two crawl markdown+HTML, and they observably disagree here.
  'docs/page.html': [
    '<!doctype html>',
    '<html><head><title>Page</title></head>',
    '<body><h1 id="top">Page</h1><a href="guide.md">guide</a></body></html>',
    '',
  ].join('\n'),
  'docs/page.htm': '<html><body><a href="sibling.md">sibling</a></body></html>\n',

  // Fragment targets declared from MARKDOWN, via raw HTML. Without this the
  // `anchors` parse fact is exercised on the HTML parser only, and markdown's
  // path through `extractHtmlAnchors` — a different function, with a different
  // rule — has no coverage at all.
  //
  // The two spellings are the point. Markdown case-folds fragments, so both
  // `id="Mixed-Case"` and `name="ALSO"` are recorded lowercased, while the HTML
  // parser records ids verbatim. That fold is the kind of normalisation a parse
  // layer can drop without changing a single link, heading or byte count, and
  // `docs/page.html#top` cannot show it because `top` is already lowercase.
  'docs/anchored.md': [
    '# Anchored',
    '',
    '<a id="Mixed-Case"></a>',
    '',
    '## Section',
    '',
    '<a name="ALSO"></a>',
    '',
    'Linked from [links/to-anchor.md](../links/to-anchor.md).',
    '',
  ].join('\n'),
  'links/to-anchor.md': '# To an anchor\n\n[mixed](../docs/anchored.md#mixed-case)\n',

  // The empty-file parser-discriminator collision. Identical bytes; git keys
  // both as e69de29…; the parse results are not the same. A bytes-only content
  // key would serve one for the other.
  'empty.md': '',
  'empty.html': '',

  // Duplicate resource id. `generateIdFromPath` slugifies the whole
  // corpus-relative path, mapping BOTH `/` and `-` to `-`, so these two
  // distinct files both claim `dup-hyphen-note-md`. `addResources` is
  // first-added-wins, so WHICH one gets validated, bundled and rewritten is
  // decided by enumeration order — the single most order-sensitive behaviour in
  // the pipeline, and the reason no snapshot here may ever be sorted.
  //
  // Note this collides via the PATH, not via a frontmatter `id:` field: the
  // frontmatter route only applies when the registry was constructed with an
  // `idField`, which none of the five lanes does. Both files carry an `id:` key
  // anyway, so the day a lane starts honouring one, this fixture notices.
  'dup-hyphen/note.md': '---\nid: shared-note\n---\n\n# Note under dup-hyphen/\n',
  'dup/hyphen-note.md': '---\nid: shared-note\n---\n\n# Note under dup/\n',

  // Link targets that are not files: a directory, and a path that is absent.
  // Both are `exists`/`isDirectory` questions about paths outside the
  // enumeration, which is the population the attribute columns exist for.
  'links/to-dir.md': '# To a directory\n\n[docs](../docs)\n',
  'links/to-missing.md': '# To nothing\n\n[gone](../docs/nowhere.md)\n',

  // Only meaningful once git is initialized: the target is gitignored, which
  // `git ls-files` can never return, so it can only ever be a link-target fact.
  'links/to-ignored.md': '# To an ignored file\n\n[secret](../ignored/secret.md)\n',
  'ignored/secret.md': '# Secret\n\nGitignored when this corpus is initialized as a repo.\n',
  '.gitignore': 'ignored/\n',

  // Invalid YAML frontmatter: a parse-time condition, not an exception.
  'broken/bad-frontmatter.md': '---\ntitle: [unclosed\n---\n\n# Broken\n',

  // The YAML→JSON round-trip trap, in one file. `.inf` and `.nan` survive a
  // YAML parse and become `null` through JSON; `!!binary` becomes a Buffer
  // envelope. Caching the parsed OBJECT would make a cold run and a warm run
  // report different validation issues for this document.
  'broken/exotic-frontmatter.md': [
    '---',
    'ceiling: .inf',
    'undefined_value: .nan',
    'payload: !!binary |',
    '  aGVsbG8=',
    '---',
    '',
    '# Exotic frontmatter',
    '',
  ].join('\n'),

  // Reference-style link with no definition: degrades to literal text at parse
  // time, so it is invisible to any AST visitor and only a raw-source scan sees
  // it. A condition row, not a link row.
  'broken/dangling-reference.md': '# Dangling\n\nSee [the docs][nowhere].\n',

  // Malformed HTML: well-formedness diagnostics are a parse fact for the HTML
  // parser and undefined for the markdown one.
  'broken/malformed.html': '<html><body><p>unclosed<div></body>\n',
});

/**
 * Symlinks. Created only when the host permits it — see
 * {@link MaterializedCorpus.symlinksCreated}.
 *
 * The two `link.md` entries store the **same target string** in different
 * directories and resolve to different bytes. Git records a symlink as a blob
 * containing that target string (mode 120000), so both share a blob SHA —
 * measured. Any cache keyed on the git blob would serve one document's parse
 * for the other. That is the whole reason keys are computed on read.
 */
export const TRAP_CORPUS_SYMLINKS: readonly CorpusSymlink[] = Object.freeze([
  { path: 'symlinks/a/link.md', target: 'target.md' },
  { path: 'symlinks/b/link.md', target: 'target.md' },
]);

/**
 * A symlink that resolves to nothing.
 *
 * Kept OUT of the default corpus because in a git-initialized tree it does not
 * produce a finding — it produces an **unhandled `ENOENT` that terminates the
 * command**. `git ls-files` returns a mode-120000 entry like any other path,
 * `crawlDirectory`'s git branch does no symlink filtering (so `followSymlinks:
 * false` is honoured on the walk route and silently ignored on the git route),
 * and `addResources` catches only `DuplicateResourceIdError`, so the read error
 * escapes `registry.crawl` and the process dies with a raw stack trace.
 *
 * The same tree with no `.git` is fine, because the walk route never enumerates
 * a symlink at all. One variable, opposite outcomes — which is why this is an
 * opt-in: including it by default would make every other snapshot on the git
 * route unobtainable.
 */
export const DANGLING_SYMLINK: CorpusSymlink = Object.freeze({
  path: 'symlinks/dangling.md',
  target: 'nowhere.md',
});

/** Files the symlink entries point at. Split out so they exist first. */
const SYMLINK_TARGETS: CorpusFiles = Object.freeze({
  'symlinks/a/target.md': '# A\n\nDistinct bytes from B.\n',
  'symlinks/b/target.md': '# B\n\nDistinct bytes from A, behind an identical link target string.\n',
});

/**
 * A skill that actually bundles a file, reachable by one relative link.
 *
 * This is what none of VAT's 13 dogfood skills provide. Without it, the source
 * lane and the built lane report the same `fileCount: 1, maxLinkDepth: 0`
 * whether the link graph works or is structurally empty — so nothing committed
 * can tell a working bundle from a broken one.
 */
export const BUNDLING_SKILL_FILES: CorpusFiles = Object.freeze({
  'skills/bundling-skill/SKILL.md': [
    '---',
    'name: bundling-skill',
    'description: Use when exercising the built lane\'s link graph — bundles one file reachable by a relative link.',
    '---',
    '',
    '# Bundling skill',
    '',
    'Consult the [reference](reference.md) before acting.',
    '',
  ].join('\n'),
  'skills/bundling-skill/reference.md': [
    '# Reference',
    '',
    'Bundled by traversal, not by declaration. Its bytes must be read by the',
    'built lane as well as the source lane; today they are not.',
    '',
  ].join('\n'),
});

/** Options for {@link materializeTrapCorpus}. */
export interface MaterializeOptions {
  /**
   * Run `git init` and commit everything (default `false`).
   *
   * Leaving this off is the point of the fixture. Turn it on to get the *other*
   * crawl route — `git ls-files`, whose output is git-sorted and therefore the
   * only route whose ordering is portable across hosts.
   */
  initGit?: boolean;
  /** Skip symlink creation even where the host supports it. */
  skipSymlinks?: boolean;
  /** Also write {@link BUNDLING_SKILL_FILES} (default `false`). */
  includeBundlingSkill?: boolean;
  /**
   * Also create {@link DANGLING_SYMLINK} (default `false`).
   *
   * ⚠️ Combined with `initGit`, this makes every resource lane throw. That is
   * the point of the flag and the reason it is not on by default.
   */
  includeDanglingSymlink?: boolean;
}

/**
 * Write the trap corpus into an existing empty directory.
 *
 * @param root - Absolute path to write into; created if absent
 * @param options - Git initialization and symlink opt-outs
 * @returns What actually got built on this host
 */
export function materializeTrapCorpus(
  root: string,
  options: MaterializeOptions = {},
): MaterializedCorpus {
  const absoluteRoot = safePath.resolve(root);
  const files: CorpusFiles = {
    ...TRAP_CORPUS_FILES,
    ...SYMLINK_TARGETS,
    ...(options.includeBundlingSkill === true ? BUNDLING_SKILL_FILES : {}),
  };

  // Sorted, so the tree is written in the same order on every host. That does
  // not make the CRAWL order portable — `readdirSync` answers from the
  // filesystem, not from creation order — but it removes one variable.
  for (const relativePath of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
    const absolutePath = safePath.join(absoluteRoot, relativePath);
    mkdirSyncReal(safePath.resolve(absolutePath, '..'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths come from the frozen literal above
    writeFileSync(absolutePath, files[relativePath] ?? '', 'utf-8');
  }

  const links = options.includeDanglingSymlink === true
    ? [...TRAP_CORPUS_SYMLINKS, DANGLING_SYMLINK]
    : TRAP_CORPUS_SYMLINKS;
  const symlinksCreated = options.skipSymlinks === true ? false : writeSymlinks(absoluteRoot, links);
  const gitInitialized = options.initGit === true ? initGit(absoluteRoot) : false;

  return { root: absoluteRoot, symlinksCreated, gitInitialized };
}

/**
 * Create the symlink entries, reporting whether the host allowed it.
 *
 * All-or-nothing on purpose: a corpus with some of its symlinks is a corpus
 * whose golden matches neither the symlink-capable nor the symlink-incapable
 * one, and debugging that costs more than the coverage is worth.
 *
 * @param root - Absolute corpus root
 * @param links - The links to create
 * @returns True when every symlink was created
 */
function writeSymlinks(root: string, links: readonly CorpusSymlink[]): boolean {
  try {
    for (const link of links) {
      const absolutePath = safePath.join(root, link.path);
      mkdirSyncReal(safePath.resolve(absolutePath, '..'), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- target and path both come from the frozen literals above
      symlinkSync(link.target, absolutePath);
    }
    return true;
  } catch {
    // Windows without Developer Mode or SeCreateSymbolicLinkPrivilege.
    return false;
  }
}

/**
 * Initialize a repository and commit the corpus.
 *
 * Identity and hooks are pinned inline so this works on a CI agent with no
 * global git config, and so a developer's `commit.gpgsign` or `core.hooksPath`
 * cannot make the fixture hang.
 *
 * @param root - Absolute corpus root
 * @returns True when the commit landed
 */
function initGit(root: string): boolean {
  const run = (args: string[]): boolean =>
    safeExecResult('git', args, { cwd: root, stdio: 'ignore', timeout: 30_000 }).success;

  return (
    run(['init', '--quiet', '--initial-branch=main']) &&
    run(['config', 'user.email', 'oracle@example.invalid']) &&
    run(['config', 'user.name', 'Pipeline Oracle']) &&
    run(['config', 'commit.gpgsign', 'false']) &&
    run(['config', 'core.hooksPath', '/dev/null']) &&
    run(['add', '--all']) &&
    run(['commit', '--quiet', '--no-verify', '-m', 'trap corpus'])
  );
}
