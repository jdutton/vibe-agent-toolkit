/**
 * OKF bundle conformance, producer-side.
 *
 * §11 defines conformance as three numbered items and then tells CONSUMERS what
 * they must not reject over. VAT is not a consumer — it is tooling for the
 * publisher, and the publisher is the only party positioned to fix a broken
 * link — so the forgiveness list constrains nothing here and findings default
 * to `error`. See `docs/concepts/knowledge-interop-formats.md`.
 */

import { describe, expect, it } from 'vitest';

import { validateOkfBundle } from '../../src/okf/validate.js';

import {
  NFC_CAFE_DOC,
  NFD_CAFE_DOC,
  NO_FRONTMATTER,
  REFERENCE_TYPE,
  TABLE_TYPE,
  codesOf,
  conceptDoc,
  plantOkfBundle,
} from './bundle-fixture.js';

/** Validate a planted literal as a bundle named `docs`, with the defaults. */
async function reportFor(
  files: Readonly<Record<string, string>>,
  options: { severity?: 'error' | 'warning' | 'info'; specVersion?: string } = {},
) {
  const root = plantOkfBundle(files);
  return await validateOkfBundle({ bundle: 'docs', root, ...options });
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

      expect(codesOf(report.findings)).toEqual(['OKF_BROKEN_CROSS_LINK']);
      // The remedy is the actual filename, so the message has to carry it.
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

    it('names the bundle and root it was asked about', async () => {
      const root = plantOkfBundle({ 'concept.md': conceptDoc('Metric') });
      const report = await validateOkfBundle({ bundle: 'knowledge', root });

      expect(report.bundle).toBe('knowledge');
      expect(report.root).toBe(root);
    });
  });
});
