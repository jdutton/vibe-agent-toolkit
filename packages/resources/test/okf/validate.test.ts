/**
 * OKF bundle conformance, producer-side.
 *
 * §11 defines conformance as three numbered items and then tells CONSUMERS what
 * they must not reject over. VAT is not a consumer — it is tooling for the
 * publisher, and the publisher is the only party positioned to fix a broken
 * link — so the forgiveness list constrains nothing here and findings default
 * to `error`. See `docs/concepts/knowledge-interop-formats.md`.
 */

import { chmodSync } from 'node:fs';

import { FsLookupCache, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { BundleDirectoryIndex, linkFindings } from '../../src/okf/links.js';
import { validateOkfBundle } from '../../src/okf/validate.js';
import type { ResourceLink } from '../../src/types.js';

import {
  NFC_CAFE_DIR,
  NFC_CAFE_DOC,
  NFD_CAFE_DIR,
  NFD_CAFE_DOC,
  NO_FRONTMATTER,
  REFERENCE_TYPE,
  SYMLINKS_AVAILABLE,
  TABLE_TYPE,
  codesOf,
  conceptDoc,
  plantOkfBundle,
  plantSymlink,
} from './bundle-fixture.js';

/** The `root:` string a test bundle pretends its config file wrote. */
const ROOT_SPECIFIER = './docs';

/** A second one, for the report-shape suite's differently-named bundle. */
const KNOWLEDGE_SPECIFIER = './knowledge';

/** Validate a planted literal as a bundle named `docs`, with the defaults. */
async function reportFor(
  files: Readonly<Record<string, string>>,
  options: { severity?: 'error' | 'warning' | 'info'; specVersion?: string } = {},
) {
  const root = plantOkfBundle(files);
  return await validateOkfBundle({
    bundle: 'docs',
    root,
    rootSpecifier: ROOT_SPECIFIER,
    ...options,
  });
}

/**
 * Run `body` with `path` unreadable, restoring its mode whatever happens.
 *
 * The restore is mandatory rather than tidy: the fixture's teardown removes the
 * planted tree recursively, and `rm -r` cannot descend into a 0o000 directory —
 * a test that skipped it would leak the tree and fail the NEXT run's teardown.
 */
async function withUnreadable(path: string, body: () => Promise<void>): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path inside a bundle this test just planted under mkdtemp
  chmodSync(path, 0o000);
  try {
    await body();
  } finally {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the same literal-derived path, restored so teardown can descend
    chmodSync(path, 0o755);
  }
}

/** Whether this host enforces POSIX permission bits at all. */
const PERMISSIONS_ENFORCED = process.platform !== 'win32';

/**
 * Judge a set of hrefs from one document, and hand back the index they used.
 *
 * Reaches `linkFindings` directly rather than going through `validateOkfBundle`,
 * because the property under test is the WORK the judge does, and only the index
 * instance can report that.
 */
async function judgeHrefs(root: string, hrefs: readonly string[]) {
  const index = new BundleDirectoryIndex(root, new FsLookupCache());
  const links: ResourceLink[] = hrefs.map((href, offset) => ({
    text: 'link',
    href,
    type: 'local_file',
    line: offset + 1,
  }));
  const drafts = await linkFindings('a.md', safePath.join(root, 'a.md'), links, root, index);
  return { drafts, index };
}

/** A root holding one linking document and `count` neighbours beside it. */
function wideBundle(count: number): { root: string; entries: number } {
  const files: Record<string, string> = { 'a.md': conceptDoc(REFERENCE_TYPE) };
  for (let n = 0; n < count; n += 1) files[`neighbour-${n}.md`] = conceptDoc(TABLE_TYPE);
  return { root: plantOkfBundle(files), entries: Object.keys(files).length };
}

/**
 * An href written ABOVE the bundle root that canonicalizes back INSIDE it.
 *
 * The target does not exist, so the only thing deciding the verdict is the
 * shape of the path — which is the point: a link above the root is an escape
 * before existence is ever consulted.
 */
const ABOVE_ROOT_HREF = '../mirror/nope.md';

/**
 * Plant `<outer>/a` as the bundle root with `<outer>/mirror -> a` beside it,
 * and `a/doc.md` linking through the mirror.
 *
 * The symlink lives OUTSIDE the bundle root on purpose: that is what makes
 * `../mirror/nope.md` canonicalize to `<root>/nope.md` — inside by realpath,
 * above the root as written — and what makes it absent from a tarball of the
 * root.
 *
 * @param extra - Further bundle-relative files, planted beside `a/doc.md`
 * @returns The outer directory (a prefix of the root, for no-leak assertions)
 *   and the bundle root itself
 */
function plantMirroredBundle(
  extra: Readonly<Record<string, string>> = {},
): { outer: string; root: string } {
  const outer = plantOkfBundle({
    'a/doc.md': conceptDoc(REFERENCE_TYPE, `See [gone](${ABOVE_ROOT_HREF}).`),
    ...extra,
  });
  plantSymlink(outer, 'mirror', 'a', 'dir');
  return { outer, root: safePath.join(outer, 'a') };
}

describe('validateOkfBundle', () => {
  describe('a conformant bundle', () => {
    it('reports no findings for documents carrying only type', async () => {
      const report = await reportFor({
        'index.md': '# Bundle\n\n* [Customers](/tables/customers.md) - the customers table\n',
        'log.md': '# Log\n\n## 2026-05-22\n* **Creation**: seeded.\n',
        'tables/customers.md': conceptDoc(TABLE_TYPE),
        'playbooks/freshness.md': conceptDoc(
          'Playbook',
          'See the [customers table](/tables/customers.md) and the [neighbour](./freshness-2.md).',
        ),
        'playbooks/freshness-2.md': conceptDoc('Playbook', 'A second playbook.'),
      });

      expect(report.findings).toEqual([]);
      expect(report.hasErrors).toBe(false);
      expect(report.conceptDocuments).toHaveLength(3);
    });

    it('accepts an unknown type and unknown frontmatter keys', async () => {
      // §4.1/§11: type values are unregistered and extra keys must not be
      // rejected. A validator that reported these would refuse most real
      // bundles.
      const report = await reportFor({
        'odd.md': '---\ntype: Claims Adjudication Rule\nacme_owner: team:claims\n---\n\n# Odd\n',
      });

      expect(report.findings).toEqual([]);
    });
  });

  describe('§11.1 — a parseable frontmatter block on every concept document', () => {
    it('reports a document with no frontmatter block at all', async () => {
      const report = await reportFor({ 'bare.md': '# Just a heading\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_FRONTMATTER_MISSING']);
      expect(report.findings[0]?.document).toBe('bare.md');
    });

    it('reports a frontmatter block whose YAML does not parse', async () => {
      const report = await reportFor({ 'broken.md': '---\ntype: [unclosed\n---\n\n# Broken\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_FRONTMATTER_UNPARSEABLE']);
    });

    it('exempts the two reserved filenames at every level', async () => {
      // §3.1 reserves them; §8 says index files carry no frontmatter at all, so
      // holding them to the concept requirement would report every conformant
      // bundle.
      const report = await reportFor({
        'index.md': '# Bundle\n',
        'log.md': '# Log\n',
        'tables/index.md': '# Tables\n',
        'tables/log.md': '# Tables log\n',
      });

      expect(report.findings).toEqual([]);
      expect(report.reservedDocuments).toHaveLength(4);
    });
  });

  describe('§11.2 — a non-empty type on every concept document', () => {
    it('reports frontmatter with no type key', async () => {
      const report = await reportFor({ 'untyped.md': '---\ntitle: No type\n---\n\n# Untyped\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_TYPE_MISSING']);
    });

    it('reports an empty frontmatter block as a missing type, not a missing block', async () => {
      // An empty block IS parseable, so §11.1 is satisfied and §11.2 is not.
      // Collapsing the two would send the author to the wrong remedy.
      const report = await reportFor({ 'empty.md': '---\n---\n\n# Empty\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_TYPE_MISSING']);
    });

    it('reports a whitespace-only type', async () => {
      const report = await reportFor({ 'blank.md': '---\ntype: "   "\n---\n\n# Blank\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_TYPE_INVALID']);
    });

    it('reports a type that is not a string', async () => {
      const report = await reportFor({ 'numeric.md': '---\ntype: 42\n---\n\n# Numeric\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_TYPE_INVALID']);
    });
  });

  describe('cross-links (§6.1)', () => {
    it('resolves a leading slash against the BUNDLE root, not the filesystem root', async () => {
      const report = await reportFor({
        'deep/nested/concept.md': conceptDoc(REFERENCE_TYPE, 'See [customers](/tables/customers.md).'),
        'tables/customers.md': conceptDoc(TABLE_TYPE),
      });

      expect(report.findings).toEqual([]);
    });

    it('reports a bundle-relative link with no target', async () => {
      // Deliberately re-pinned: this used to expect OKF_BROKEN_CROSS_LINK. A
      // `/`-anchored href that does not resolve is the re-anchoring mistake, not
      // a missing document — see the root-relative block below for why the two
      // were split.
      const report = await reportFor({
        'concept.md': conceptDoc(REFERENCE_TYPE, 'See [gone](/tables/gone.md).'),
      });

      const [finding] = report.findings;
      expect(finding?.code).toBe('OKF_ROOT_RELATIVE_LINK_UNRESOLVED');
      expect(finding?.link).toBe('/tables/gone.md');
      expect(finding?.document).toBe('concept.md');
    });

    it('reports a relative link with no target', async () => {
      const report = await reportFor({
        'a/one.md': conceptDoc(REFERENCE_TYPE, 'See [two](./two.md).'),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_BROKEN_CROSS_LINK']);
    });

    it('ignores the fragment when resolving a link that has one', async () => {
      const report = await reportFor({
        'concept.md': conceptDoc(REFERENCE_TYPE, 'See [schema](/tables/customers.md#schema).'),
        'tables/customers.md': conceptDoc(TABLE_TYPE),
      });

      expect(report.findings).toEqual([]);
    });

    it('leaves external, mailto and anchor-only links alone', async () => {
      const report = await reportFor({
        'concept.md': conceptDoc(
          'Playbook',
          'See [dash](https://example.com/dash), [mail](mailto:a@example.com), [above](#trigger).\n\n# Trigger\n',
        ),
      });

      expect(report.findings).toEqual([]);
    });

    it('reports a link that resolves outside the bundle root', async () => {
      // A bundle is the unit of distribution (§2). A target outside the root
      // does not travel with the tarball, so it is broken for every consumer
      // who is not the author.
      const report = await reportFor({
        'concept.md': conceptDoc(REFERENCE_TYPE, 'See [outside](../elsewhere.md).'),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_LINK_ESCAPES_BUNDLE']);
    });

    it('checks the links inside reserved files too', async () => {
      // An `index.md` is exactly where a stale link accumulates, since §8 says
      // it enumerates the directory's contents.
      const report = await reportFor({
        'index.md': '# Bundle\n\n* [Gone](/tables/gone.md) - deleted last week\n',
        'tables/customers.md': conceptDoc(TABLE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_ROOT_RELATIVE_LINK_UNRESOLVED']);
      expect(report.findings[0]?.document).toBe('index.md');
    });

    it('resolves a link to a directory as well as to a file', async () => {
      const report = await reportFor({
        'index.md': '# Bundle\n\n* [Tables](tables/) - the table concepts\n* [Gone](missing/) - not here\n',
        'tables/customers.md': conceptDoc(TABLE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_BROKEN_CROSS_LINK']);
      expect(report.findings[0]?.link).toBe('missing/');
    });
  });

  describe('cross-link SPELLING — the bundle is unpacked on a byte-exact filesystem', () => {
    // 🪤 The whole class this suite was blind to. `stat()` answers on the
    // machine VAT is running on, and the publisher's machine is a Mac: both
    // case and Unicode normalization are reconciled there and nowhere the
    // tarball lands. VAT's OWN link validator already reports both, at error
    // severity, over the identical corpus — so this lane was certifying bundles
    // another lane of the same product calls broken.

    it('reports a link whose case does not match the file on disk', async () => {
      const report = await reportFor({
        'k/a.md': conceptDoc(REFERENCE_TYPE, 'See [b](./Beta.md).'),
        'k/beta.md': conceptDoc(REFERENCE_TYPE),
      });

      // 🔑 Its OWN code, not OKF_BROKEN_CROSS_LINK. The stated reason for
      // splitting OKF_ROOT_RELATIVE_LINK_UNRESOLVED out was that the remedies
      // differ in KIND — and *write the file* differs from *fix the spelling*
      // exactly that way. Under one code a dashboard cannot separate them.
      expect(codesOf(report.findings)).toEqual(['OKF_LINK_CASE_MISMATCH']);
      // The remedy is the actual path, so the message has to carry it.
      expect(report.findings[0]?.message).toContain('beta.md');
      expect(report.findings[0]?.link).toBe('./Beta.md');
    });

    it('reports a link that resolves only after Unicode normalization', async () => {
      const report = await reportFor({
        'k/a.md': conceptDoc(REFERENCE_TYPE, `See [cafe](./${NFC_CAFE_DOC}).`),
        [`k/${NFD_CAFE_DOC}`]: conceptDoc(REFERENCE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_LINK_NORMALIZATION_MISMATCH']);
    });

    it('says nothing when the spelling matches byte for byte', async () => {
      // The negative control. Without it, a check that reported EVERY link
      // would pass both assertions above.
      const report = await reportFor({
        'k/a.md': conceptDoc(REFERENCE_TYPE, `See [cafe](./${NFD_CAFE_DOC}).`),
        [`k/${NFD_CAFE_DOC}`]: conceptDoc(REFERENCE_TYPE),
      });

      expect(report.findings).toEqual([]);
    });
  });

  describe('cross-link SPELLING is judged on EVERY path component', () => {
    // 🪤 The headline hole this block exists for: the judge classified only
    // `basename(resolvedPath)` against a listing of `dirname(resolvedPath)`,
    // so every DIRECTORY component was resolved by the HOST filesystem's own
    // folding. On macOS `readdir('<root>/Docs')` succeeds when the directory is
    // really `docs`, the basename then matched exactly, and VAT reported
    // nothing — while the same bundle on a case-sensitive volume produced the
    // finding. Proved by mounting one: 4 findings against 5.
    //
    // These cases must therefore hold on a case-FOLDING host (the publisher's
    // Mac) — which is exactly where the old shape was silent.

    it('reports a directory component whose case does not match disk', async () => {
      const report = await reportFor({
        'a.md': conceptDoc(REFERENCE_TYPE, 'See [guide](/Docs/guide.md).'),
        'docs/guide.md': conceptDoc(REFERENCE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_LINK_CASE_MISMATCH']);
      expect(report.findings[0]?.link).toBe('/Docs/guide.md');
    });

    it('reports a directory component in the wrong normalization form', async () => {
      // The same hole in the other dimension, and the one that 404s on Linux
      // rather than merely on a case-sensitive volume.
      const report = await reportFor({
        'a.md': conceptDoc(REFERENCE_TYPE, `See [guide](/${NFC_CAFE_DIR}/guide.md).`),
        [`${NFD_CAFE_DIR}/guide.md`]: conceptDoc(REFERENCE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_LINK_NORMALIZATION_MISMATCH']);
    });

    it('judges a component at every depth, not just the last two', async () => {
      const report = await reportFor({
        'a.md': conceptDoc(REFERENCE_TYPE, 'See [deep](/One/two/three.md).'),
        'one/two/three.md': conceptDoc(REFERENCE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_LINK_CASE_MISMATCH']);
    });

    it('judges components of a RELATIVE href too, not only a root-anchored one', async () => {
      const report = await reportFor({
        'sub/a.md': conceptDoc(REFERENCE_TYPE, 'See [guide](../Docs/guide.md).'),
        'docs/guide.md': conceptDoc(REFERENCE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_LINK_CASE_MISMATCH']);
    });

    it('suggests the FULL corrected path when more than one component is wrong', async () => {
      // ⚠️ The remedy was WRONG, not merely incomplete: with both components
      // misspelled the message said `Spell the link "guide.md"`, and a publisher
      // who followed it verbatim still had a link that 404s. A suggestion is
      // only a remedy if writing it down fixes the link.
      const report = await reportFor({
        'a.md': conceptDoc(REFERENCE_TYPE, 'See [guide](/Docs/Guide.md).'),
        'docs/guide.md': conceptDoc(REFERENCE_TYPE),
      });

      const message = report.findings[0]?.message ?? '';
      expect(message).toContain('docs/guide.md');
      expect(message).toContain('Docs/Guide.md');
    });

    it('judges components inside a directory whose NAME begins with dots', async () => {
      // The guard that keeps the judge inside the bundle tests for a `..`
      // SEGMENT, not for a `..` prefix — a real directory called `..cache` is
      // inside the bundle and its contents have to be judged like any other.
      const report = await reportFor({
        'a.md': conceptDoc(REFERENCE_TYPE, 'See [x](/..cache/Note.md).'),
        '..cache/note.md': conceptDoc(REFERENCE_TYPE),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_LINK_CASE_MISMATCH']);
    });

    it('says nothing when every component matches byte for byte', async () => {
      // The negative control. A judge that reported every nested link would
      // satisfy all five assertions above.
      const report = await reportFor({
        'a.md': conceptDoc(REFERENCE_TYPE, 'See [deep](/one/two/three.md).'),
        'one/two/three.md': conceptDoc(REFERENCE_TYPE),
      });

      expect(report.findings).toEqual([]);
    });

    it('says nothing about a link to the bundle root itself', async () => {
      // The bundle root was walked successfully, so a link to it resolves. The
      // judge must not need to look ABOVE the root to say so — see the
      // directory-index suite for the structural pin.
      const report = await reportFor({
        'a.md': conceptDoc(REFERENCE_TYPE, 'See [home](/).'),
      });

      expect(report.findings).toEqual([]);
    });
  });

  describe('the directory index — the cost of judging, and how far it reaches', () => {
    // 🪤 The judge this pins replaced an `fs.stat` per link with up to THREE
    // linear scans of the parent listing per link, each folding every entry to
    // NFC and lower case. Cost was O(links × entries-in-that-directory), and
    // splitting the same files over more directories was what identified
    // directory WIDTH as the multiplier: 8,000 documents with 80,000 broken
    // links cost 32.1 s in one directory and 20.1 s across eight, against
    // 14.9 s for both layouts once the listing was indexed.
    //
    // ⛔ Deliberately NOT a wall-clock budget. A literal number of milliseconds
    // makes the machine a silent second requirement, and the assertion then
    // passes or fails on load rather than on the code. What is asserted is the
    // WORK: each directory is listed and indexed once, whatever the link count.

    it('indexes a directory ONCE however many links point into it', async () => {
      const { root, entries } = wideBundle(200);
      const hrefs = Array.from({ length: 200 }, (_, n) => `./missing-${n}.md`);

      const { drafts, index } = await judgeHrefs(root, hrefs);

      // Every link misses, so all three lookup rules are exercised — the exact
      // path the old shape paid a full folded scan for, per link.
      expect(drafts).toHaveLength(200);
      expect(index.directoriesIndexed).toBe(1);
      expect(index.entriesIndexed).toBe(entries);
    });

    it('shares one index across the components of a nested path', async () => {
      const root = plantOkfBundle({
        'a.md': conceptDoc(REFERENCE_TYPE),
        'one/two/three.md': conceptDoc(TABLE_TYPE),
        'one/two/four.md': conceptDoc(TABLE_TYPE),
      });

      const { index } = await judgeHrefs(root, ['/one/two/three.md', '/one/two/four.md']);

      // root, one, one/two — three directories for two links of depth three,
      // not one listing per component per link.
      expect(index.directoriesIndexed).toBe(3);
    });

    it('never lists a directory above the bundle root', async () => {
      // 🪤 `[home](/)` resolves to the root itself. The judge this replaced
      // derived `dirname(resolvedPath)` and listed the root's PARENT — a
      // directory the tarball does not carry, whose name changes when the
      // bundle is unpacked elsewhere, and which made VAT report
      // OKF_ROOT_RELATIVE_LINK_UNRESOLVED for a root it had just walked
      // whenever that parent was not listable.
      const root = plantOkfBundle({ 'a.md': conceptDoc(REFERENCE_TYPE) });

      const { drafts, index } = await judgeHrefs(root, ['/', '/a.md']);

      expect(drafts).toEqual([]);
      expect(index.indexedDirectories).toEqual([root]);
    });
  });

  describe('a root-relative link is a different mistake from a missing document', () => {
    // 🪤 On a real 889-document corpus the ratio was 452 root-relative links to
    // 6 genuinely-missing documents, all under one code and one sentence. The
    // six that mattered were unreadable. The remedies differ in KIND: "a leading
    // / means the BUNDLE root, re-anchor it" versus "write the document".

    it('gives a root-relative link that does not resolve its own code', async () => {
      const report = await reportFor({
        'k/a.md': conceptDoc(REFERENCE_TYPE, 'See [readme](/README.md).'),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_ROOT_RELATIVE_LINK_UNRESOLVED']);
      expect(report.findings[0]?.message).toContain('bundle root');
    });

    it('keeps the broken code for a relative link with no target', async () => {
      const report = await reportFor({
        'k/a.md': conceptDoc(REFERENCE_TYPE, 'See [nope](./nope.md).'),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_BROKEN_CROSS_LINK']);
    });

    it('discriminates on the DECODED href, so %2F is caught too', async () => {
      const report = await reportFor({
        'k/a.md': conceptDoc(REFERENCE_TYPE, 'See [readme](%2FREADME.md).'),
      });

      expect(codesOf(report.findings)).toEqual(['OKF_ROOT_RELATIVE_LINK_UNRESOLVED']);
    });
  });

  describe('an unreadable bundle root', () => {
    it('reports the bundle it belongs to instead of aborting the run', async () => {
      // 🪤 A thrown fs error exits 2 and discards every OTHER bundle's real
      // findings. CI reads 2 as "the tool broke", not "the bundle is wrong".
      const root = plantOkfBundle({ 'concept.md': conceptDoc('Metric') });

      const report = await validateOkfBundle({
        bundle: 'gone',
        root: `${root}/nowhere`,
        rootSpecifier: './nowhere',
      });

      expect(codesOf(report.findings)).toEqual(['OKF_BUNDLE_ROOT_UNREADABLE']);
      expect(report.conceptDocuments).toEqual([]);
      expect(report.hasErrors).toBe(true);
    });

    it('names the config key and the path AS WRITTEN, leaking no absolute path', async () => {
      const root = plantOkfBundle({ 'concept.md': conceptDoc('Metric') });

      const report = await validateOkfBundle({
        bundle: 'gone',
        root: `${root}/nowhere`,
        rootSpecifier: './nowhere',
      });

      const message = report.findings[0]?.message ?? '';
      expect(message).toContain("okf.bundles.gone.root");
      expect(message).toContain("'./nowhere'");
      expect(message).not.toContain(root);

      // The no-leak property is DOCUMENT-scoped, so assert it on the document.
      // Asserting only `message` left `report.root` — whose own docstring calls
      // itself "the only spelling of the root the report is allowed to publish"
      // — free to carry the absolute path: reverting it to `options.root` kept
      // all 94 OKF tests green. The clean-report sibling below makes exactly
      // this assertion, and this failure path is the one it cannot reach.
      expect(report.root).toBe('./nowhere');
      expect(JSON.stringify(report)).not.toContain(root);
    });

    it('stays at error even when the bundle dial is lowered', async () => {
      // The dial answers "how hard do you gate on this bundle's CONFORMANCE".
      // An unreadable root means conformance was never assessed at all, and a
      // conformance dial cannot downgrade "I could not look" — that is the
      // green-without-running shape.
      const root = plantOkfBundle({ 'concept.md': conceptDoc('Metric') });

      const report = await validateOkfBundle({
        bundle: 'gone',
        root: `${root}/nowhere`,
        rootSpecifier: './nowhere',
        severity: 'warning',
      });

      expect(report.findings[0]?.severity).toBe('error');
      expect(report.hasErrors).toBe(true);
    });
  });

  describe('one file, one verdict — discovery and link resolution agree', () => {
    // 🪤 The incoherence, stated as a test: discovery admitted a symlinked `.md`
    // whose target is outside the root into the population, while `isWithinProject`
    // in the link lane called a LINK to that same file an escape. Both lanes now
    // ask the same predicate, so the file is outside for both — and the defect
    // that was never reported at all (a bundle member that does not travel with
    // the tarball) is reported.

    it.skipIf(!SYMLINKS_AVAILABLE)('calls an escaping symlink outside in BOTH lanes', async () => {
      const outside = plantOkfBundle({ 'target.md': conceptDoc(TABLE_TYPE) });
      const root = plantOkfBundle({
        'a.md': conceptDoc(REFERENCE_TYPE, 'See [escapee](./escapee.md).'),
      });
      plantSymlink(root, 'escapee.md', safePath.join(outside, 'target.md'), 'file');

      const report = await validateOkfBundle({
        bundle: 'docs',
        root,
        rootSpecifier: ROOT_SPECIFIER,
      });

      // Not a member of the population…
      expect(report.conceptDocuments).toEqual(['a.md']);
      // …and both lanes say so, each in its own vocabulary.
      // Report order, not a sorted copy: findings are ordered by document, so
      // `a.md`'s link finding precedes `escapee.md`'s own — and asserting the
      // order also pins that the two lanes each spoke once.
      expect(codesOf(report.findings)).toEqual([
        'OKF_LINK_ESCAPES_BUNDLE',
        'OKF_DOCUMENT_ESCAPES_BUNDLE',
      ]);
    });
  });

  describe('a link ABOVE the root that canonicalizes back INSIDE it', () => {
    // 🪤 Two containment questions, two different predicates. `resolveOne`
    // admitted a target on `isWithinProject` — REALPATH containment, which a
    // `mirror -> a` symlink beside the root satisfies, because the missing file
    // canonicalizes to `<root>/nope.md`. The judge then asked the LEXICAL
    // question (`safePath.relative(root, target)` starts with `..`) and threw.
    //
    // Nothing caught it: `inspectDocument`'s only `try` wraps the parse. So the
    // ordinary user data below — a link to a file that does not even exist,
    // which is a plain broken cross-link — delivered all three things this
    // module's docstrings claim to have eliminated: exit 2 ("the tool broke")
    // instead of a finding, every OTHER bundle's findings discarded with it,
    // and the absolute root printed into stdout and the CI log.
    //
    // The property pinned here is that the two gates agree. Which verdict they
    // agree ON is §2's: a path written above the bundle root does not travel
    // with the tarball, whatever a symlink OUTSIDE the root makes of it on the
    // author's disk — so it is an escape, judged before existence.

    it.skipIf(!SYMLINKS_AVAILABLE)(
      'reports a finding, keeps judging the bundle, and leaks no absolute path',
      async () => {
        const { outer, root } = plantMirroredBundle({ 'a/other.md': NO_FRONTMATTER });

        const report = await validateOkfBundle({
          bundle: 'docs',
          root,
          rootSpecifier: ROOT_SPECIFIER,
        });

        // A finding, not a throw — and the document AFTER the offending one was
        // still judged, which is what "the run continues" means inside a bundle.
        expect(codesOf(report.findings)).toEqual([
          'OKF_LINK_ESCAPES_BUNDLE',
          'OKF_FRONTMATTER_MISSING',
        ]);
        expect(report.findings[0]?.document).toBe('doc.md');
        expect(report.findings[0]?.link).toBe(ABOVE_ROOT_HREF);

        // The report publishes the spelling the config wrote, and nothing else.
        // `outer` is a prefix of `root`, so one assertion covers both.
        expect(report.root).toBe(ROOT_SPECIFIER);
        expect(JSON.stringify(report)).not.toContain(outer);
      },
    );

    it.skipIf(!SYMLINKS_AVAILABLE)(
      'leaves a SIBLING bundle validated after it fully intact',
      async () => {
        const { root } = plantMirroredBundle();

        await validateOkfBundle({ bundle: 'docs', root, rootSpecifier: ROOT_SPECIFIER });

        // The throw took the whole command down, so the sibling's findings were
        // never computed at all. Ordering the sibling second is the point.
        const sibling = await validateOkfBundle({
          bundle: 'knowledge',
          root: plantOkfBundle({ 'sibling.md': NO_FRONTMATTER }),
          rootSpecifier: KNOWLEDGE_SPECIFIER,
        });

        expect(codesOf(sibling.findings)).toEqual(['OKF_FRONTMATTER_MISSING']);
      },
    );

    it.skipIf(!SYMLINKS_AVAILABLE)(
      'is a conformance finding, so the per-bundle dial reaches it',
      async () => {
        // The exit-code half of the property, asserted where this package can
        // see it: a hard `error` that no dial reaches is how "the tool broke"
        // is spelled here, and a conformance finding is not that.
        const { root } = plantMirroredBundle();

        const report = await validateOkfBundle({
          bundle: 'docs',
          root,
          rootSpecifier: ROOT_SPECIFIER,
          severity: 'warning',
        });

        expect(report.findings[0]?.severity).toBe('warning');
        expect(report.hasErrors).toBe(false);
      },
    );
  });

  describe('an unreadable SUBdirectory is not an unreadable root', () => {
    // 🪤 The `try` used to wrap the entire recursive walk, so a `readdir`
    // failure anywhere in the tree came back as "okf.bundles.<name>.root is not
    // a readable directory … so this bundle was not checked at all" — about a
    // root that was perfectly readable, and whose documents were never judged.
    // It told the adopter to point their config somewhere else to fix a
    // permission problem three levels down.

    it.skipIf(!PERMISSIONS_ENFORCED)(
      'names the subdirectory and still checks the rest of the bundle',
      async () => {
        const root = plantOkfBundle({
          'a.md': conceptDoc(TABLE_TYPE),
          'sub/hidden.md': conceptDoc(TABLE_TYPE),
        });

        await withUnreadable(safePath.join(root, 'sub'), async () => {
          const report = await validateOkfBundle({
            bundle: 'docs',
            root,
            rootSpecifier: ROOT_SPECIFIER,
          });

          expect(codesOf(report.findings)).toEqual(['OKF_SUBDIRECTORY_UNREADABLE']);
          expect(report.findings[0]?.document).toBe('sub');
          // The half of the bundle that WAS readable is still judged.
          expect(report.conceptDocuments).toEqual(['a.md']);
        });
      },
    );

    it.skipIf(!PERMISSIONS_ENFORCED)('stays at error even when the dial is lowered', async () => {
      // Same argument as the unreadable root: the dial answers "how hard do you
      // gate on this bundle's conformance", and a subtree nobody could open was
      // never assessed. Lowering it would be green-without-running for that
      // subtree.
      const root = plantOkfBundle({ 'a.md': conceptDoc(TABLE_TYPE), 'sub/h.md': conceptDoc(TABLE_TYPE) });

      await withUnreadable(safePath.join(root, 'sub'), async () => {
        const report = await validateOkfBundle({
          bundle: 'docs',
          root,
          rootSpecifier: ROOT_SPECIFIER,
          severity: 'warning',
        });

        expect(report.findings[0]?.severity).toBe('error');
        expect(report.hasErrors).toBe(true);
      });
    });
  });

  describe('an unreadable DOCUMENT is that document own finding', () => {
    // 🪤 `parseOkfDocument` was in no `try` at all, so one unreadable file
    // aborted the whole command at exit 2 — discarding every other bundle's
    // findings and printing `EACCES: permission denied, open '/Users/…'`, which
    // is both the wrong exit code and the home-directory leak two docstrings in
    // this module claim to have eliminated. The root-listing throw was closed;
    // the per-document read throw is the more common one.

    it.skipIf(!PERMISSIONS_ENFORCED)('reports it and keeps going', async () => {
      const root = plantOkfBundle({
        'ok.md': conceptDoc(TABLE_TYPE),
        'locked.md': conceptDoc(TABLE_TYPE),
      });

      await withUnreadable(safePath.join(root, 'locked.md'), async () => {
        const report = await validateOkfBundle({
          bundle: 'docs',
          root,
          rootSpecifier: ROOT_SPECIFIER,
        });

        expect(codesOf(report.findings)).toEqual(['OKF_DOCUMENT_UNREADABLE']);
        expect(report.findings[0]?.document).toBe('locked.md');
        expect(report.findings[0]?.severity).toBe('error');
        // The readable document was still opened and judged.
        expect(report.conceptDocuments).toEqual(['locked.md', 'ok.md']);
      });
    });

    it.skipIf(!PERMISSIONS_ENFORCED)('leaks no absolute path while doing it', async () => {
      const root = plantOkfBundle({ 'locked.md': conceptDoc(TABLE_TYPE) });

      await withUnreadable(safePath.join(root, 'locked.md'), async () => {
        const report = await validateOkfBundle({
          bundle: 'docs',
          root,
          rootSpecifier: ROOT_SPECIFIER,
        });

        // Node writes the full path into the Error.message; the errno is the
        // only part of it that says anything a reader needs.
        expect(JSON.stringify(report)).not.toContain(root);
        expect(report.findings[0]?.message).toContain('EACCES');
      });
    });
  });

  describe('the okf_version cross-check (§8, §12)', () => {
    it('reports the version the root index.md declares', async () => {
      const report = await reportFor({
        'index.md': '---\nokf_version: "0.2"\n---\n\n# Bundle\n',
      });

      expect(report.declaredOkfVersion).toBe('0.2');
      expect(report.findings).toEqual([]);
    });

    it('stays silent when no reference version was supplied to compare against', async () => {
      // The declaration is a SUSPECT, never an input: with nothing to check it
      // against, VAT reports what the artifact says and asserts nothing.
      const report = await reportFor({
        'index.md': '---\nokf_version: "9.9"\n---\n\n# Bundle\n',
      });

      expect(report.declaredOkfVersion).toBe('9.9');
      expect(report.findings).toEqual([]);
    });

    it('reports a declared version that disagrees with the one being checked against', async () => {
      const report = await reportFor(
        { 'index.md': '---\nokf_version: "0.1"\n---\n\n# Bundle\n' },
        { specVersion: '0.2' },
      );

      expect(codesOf(report.findings)).toEqual(['OKF_VERSION_MISMATCH']);
      expect(report.findings[0]?.message).toContain('0.1');
      expect(report.findings[0]?.message).toContain('0.2');
    });

    it('stays silent when the declared version agrees', async () => {
      const report = await reportFor(
        { 'index.md': '---\nokf_version: "0.2"\n---\n\n# Bundle\n' },
        { specVersion: '0.2' },
      );

      expect(report.findings).toEqual([]);
    });

    it('reports an unquoted version, which YAML decodes to a number', async () => {
      // §12 writes it `okf_version: "0.2"`. Unquoted it is the float 0.2, and
      // `0.20` and `0.2` become the same value — a lossy encoding of a version
      // string, and the single most likely way to get this field wrong.
      const report = await reportFor({ 'index.md': '---\nokf_version: 0.2\n---\n\n# Bundle\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_VERSION_MALFORMED']);
      expect(report.declaredOkfVersion).toBeUndefined();
    });

    it('reports a version that is not <major>.<minor>', async () => {
      const report = await reportFor({
        'index.md': '---\nokf_version: "zero point two"\n---\n\n# Bundle\n',
      });

      expect(codesOf(report.findings)).toEqual(['OKF_VERSION_MALFORMED']);
    });

    it('reports okf_version on an index.md that is not the bundle root', async () => {
      // §12: the bundle-root `index.md` is "the only place frontmatter is
      // permitted in an index.md".
      const report = await reportFor({
        'tables/index.md': '---\nokf_version: "0.2"\n---\n\n# Tables\n',
      });

      expect(codesOf(report.findings)).toEqual(['OKF_INDEX_FRONTMATTER_NOT_PERMITTED']);
      expect(report.declaredOkfVersion).toBeUndefined();
    });

    it('reports any other key in the root index.md frontmatter', async () => {
      const report = await reportFor({
        'index.md': '---\nokf_version: "0.2"\ntitle: Bundle\n---\n\n# Bundle\n',
      });

      expect(codesOf(report.findings)).toEqual(['OKF_INDEX_FRONTMATTER_NOT_PERMITTED']);
      expect(report.findings[0]?.message).toContain('title');
    });

    it('reports an index.md whose frontmatter block does not parse', async () => {
      // Unparseable frontmatter in an index.md is still frontmatter in an
      // index.md. Reporting nothing would leave the one block §12 reads
      // silently unread.
      const report = await reportFor({ 'index.md': '---\nokf_version: [unclosed\n---\n\n# Bundle\n' });

      expect(codesOf(report.findings)).toEqual(['OKF_INDEX_FRONTMATTER_NOT_PERMITTED']);
      expect(report.declaredOkfVersion).toBeUndefined();
    });

    it('says nothing about frontmatter on a log.md', async () => {
      // §8's "no frontmatter" rule is about INDEX files. §9 states no such rule
      // for logs, and inventing one would report a bundle the spec permits.
      const report = await reportFor({ 'log.md': '---\ngenerated_by: nightly\n---\n\n# Log\n' });

      expect(report.findings).toEqual([]);
    });
  });

  describe('severity', () => {
    it('defaults to error, so a finding fails the gate', async () => {
      const report = await reportFor({ 'bare.md': NO_FRONTMATTER });

      expect(report.findings[0]?.severity).toBe('error');
      expect(report.hasErrors).toBe(true);
    });

    it('honours a lowered per-bundle severity without dropping the finding', async () => {
      const report = await reportFor({ 'bare.md': NO_FRONTMATTER }, { severity: 'warning' });

      expect(report.findings[0]?.severity).toBe('warning');
      expect(report.hasErrors).toBe(false);
      expect(report.findings).toHaveLength(1);
    });
  });

  describe('report shape', () => {
    it('orders findings by document so two runs of one bundle compare', async () => {
      const report = await reportFor({
        'zebra.md': NO_FRONTMATTER,
        'alpha.md': '# No frontmatter either\n',
        'middle.md': '---\ntitle: no type\n---\n',
      });

      expect(report.findings.map((finding) => finding.document)).toEqual([
        'alpha.md',
        'middle.md',
        'zebra.md',
      ]);
    });

    it('names the bundle, and the root AS THE CONFIG WROTE IT', async () => {
      // 🪤 `root` used to carry the resolved ABSOLUTE path, and it is emitted
      // for every bundle — so `grep -c "/Users/<name>" report.json` returned 3
      // on a clean run. The finding MESSAGES were scrubbed and pinned; the
      // artifact called "the report" was not, which made the property false at
      // exactly the level a CI log reads.
      const root = plantOkfBundle({ 'concept.md': conceptDoc('Metric') });
      const report = await validateOkfBundle({
        bundle: 'knowledge',
        root,
        rootSpecifier: KNOWLEDGE_SPECIFIER,
      });

      expect(report.bundle).toBe('knowledge');
      expect(report.root).toBe(KNOWLEDGE_SPECIFIER);
    });

    it('leaks no absolute path anywhere in a clean report', async () => {
      // The whole document, not one field: the property is about the artifact a
      // CI job publishes, and a field-by-field assertion goes stale the moment
      // a field is added.
      const root = plantOkfBundle({
        'index.md': '# Bundle\n\n* [Gone](/tables/gone.md)\n',
        'concept.md': conceptDoc('Metric'),
      });
      const report = await validateOkfBundle({
        bundle: 'knowledge',
        root,
        rootSpecifier: KNOWLEDGE_SPECIFIER,
      });

      expect(report.findings).not.toEqual([]);
      expect(JSON.stringify(report)).not.toContain(root);
    });
  });
});
