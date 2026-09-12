/**
 * What an OKF conformance run reports.
 *
 * ## Why these codes are local to the OKF lane
 *
 * They are deliberately NOT registered in `@vibe-agent-toolkit/schema`'s
 * `VALIDATION_CODES`. That registry describes VAT's own resource and packaging
 * findings, whose severities an adopter tunes per code through
 * `validation.severity.<CODE>`. OKF's severity surface is different by ruling:
 * it is **per bundle**, one dial on `okf.bundles.<name>.severity`, because a
 * bundle is conformant or it is not — §11 states three items and does not rank
 * them. Publishing nine separately-tunable codes would invent a control surface
 * the specification does not have, and would let an adopter switch off §11.2
 * while still calling the bundle OKF.
 */

/**
 * The dial an adopter sets per bundle. Defaults to `error` — VAT is producer-side.
 *
 * ⛔ **It does not reach the three "could not look" codes, and that is not an
 * exception carved for convenience.** `OKF_BUNDLE_ROOT_UNREADABLE`,
 * `OKF_SUBDIRECTORY_UNREADABLE` and `OKF_DOCUMENT_UNREADABLE` all say that
 * conformance was never assessed for some part of the bundle — nothing was
 * opened there, nothing was judged. A conformance dial cannot downgrade "I
 * could not look" without producing the green-without-running report this repo
 * keeps rediscovering: a bundle lowered to `warning` whose root is a typo, or
 * whose one interesting subtree is unreadable, would otherwise pass silently and
 * forever.
 *
 * Every other code IS a judgement about content that VAT did read, including
 * `OKF_DOCUMENT_ESCAPES_BUNDLE` — the entry was seen and found not to be a
 * distributable member — so the dial reaches all of them.
 */
export type OkfSeverity = 'error' | 'warning' | 'info';

/**
 * Every conformance finding this lane can emit.
 *
 * Each one names a specification clause, because the remedy is always "read
 * that clause" and a code that cannot be traced to one is a rule VAT invented.
 */
export const OKF_FINDING_CODES = [
  /** §11.1 — a concept document with no frontmatter block at all. */
  'OKF_FRONTMATTER_MISSING',
  /** §11.1 — a frontmatter block whose YAML does not parse. */
  'OKF_FRONTMATTER_UNPARSEABLE',
  /**
   * §4.1, §11.1 — a frontmatter block whose YAML parses to something that is not
   * a mapping: a sequence, a bare scalar, or `null`.
   *
   * 🪤 Its own code because it used to have none, and the absence was SILENT.
   * `parseFrontmatterSource` returns a bare `{}` for all three shapes — no
   * `frontmatter`, no `frontmatterError` — so such a document arrived at the
   * judges looking exactly like one carrying no keys. `indexFindings` returned no
   * drafts at all and VAT certified the bundle clean; `conceptFindings` reported
   * `OKF_TYPE_MISSING`, which sends the author to add a `type` key to a block
   * that cannot hold one. A document VAT could not understand must produce a
   * finding with a path on it, not a skip and not a misdiagnosis.
   */
  'OKF_FRONTMATTER_NOT_A_MAPPING',
  /** §11.2 — parseable frontmatter carrying no `type` key. */
  'OKF_TYPE_MISSING',
  /** §11.2 — a `type` that is present but not a non-empty string. */
  'OKF_TYPE_INVALID',
  /** §6.1 — a markdown cross-link whose target is not in the bundle at all. */
  'OKF_BROKEN_CROSS_LINK',
  /**
   * §6.1 — the target IS in the bundle, spelled with different letter case in
   * one or more path components.
   *
   * 🔑 Split out of {@link OKF_BROKEN_CROSS_LINK} on the same argument that
   * split {@link OKF_ROOT_RELATIVE_LINK_UNRESOLVED} out of it: the remedies
   * differ in KIND, not in degree. *Write the missing document* and *fix the
   * spelling* are different work, done by different people at different times,
   * and a dashboard grouping by code could not separate them while both wore
   * one code — the exact failure that made six root-relative links invisible
   * among 452.
   */
  'OKF_LINK_CASE_MISMATCH',
  /**
   * §6.1, §2 — a `/`-anchored link that did not resolve.
   *
   * Split out of {@link OKF_BROKEN_CROSS_LINK} because the remedies differ in
   * KIND, not in degree: this one is almost always an author who meant the
   * repository root and got the bundle root, so the fix is to re-anchor the link
   * or move the target inside — never to write the document the message would
   * otherwise be asking for. On one real 889-document corpus the two arrived at a
   * ratio of 452 to 6 under a single code, which made the six invisible.
   */
  'OKF_ROOT_RELATIVE_LINK_UNRESOLVED',
  /**
   * §6.1 — a link that resolves only after Unicode normalization: the same
   * visible filename written NFC on one side and NFD on the other.
   *
   * Its own code because it is the one link finding whose verdict depends on
   * which machine asks. It opens on the publisher's macOS or Windows box and
   * 404s on the byte-exact filesystem the bundle is unpacked onto — which is
   * exactly why `stat()` could never see it.
   */
  'OKF_LINK_NORMALIZATION_MISMATCH',
  /** §2, §6.1 — a link resolving outside the root, so it cannot travel with the bundle. */
  'OKF_LINK_ESCAPES_BUNDLE',
  /**
   * The declared `okf.bundles.<name>.root` could not be listed at all.
   *
   * Not a specification clause — a configuration one, and the only finding in
   * this lane that is NOT about the bundle's content, because there was no
   * content to be about. It is reported as a finding rather than thrown so that
   * one mistyped root cannot discard every other bundle's real findings, and it
   * is one of the three "could not look" codes the per-bundle severity dial does
   * not reach (with `OKF_SUBDIRECTORY_UNREADABLE` and `OKF_DOCUMENT_UNREADABLE`):
   * see {@link OkfSeverity}.
   */
  'OKF_BUNDLE_ROOT_UNREADABLE',
  /**
   * A directory BENEATH a readable root could not be listed.
   *
   * 🪤 Its own code because the root's code was being used for it: the whole
   * recursive walk sat inside one `try`, so a permission problem three levels
   * down was reported as `okf.bundles.<name>.root` being unreadable and told
   * the adopter to point their config elsewhere. The rest of the bundle IS
   * checked; this names the one subtree that was not.
   */
  'OKF_SUBDIRECTORY_UNREADABLE',
  /**
   * A document that was enumerated and then could not be opened.
   *
   * 🪤 This used to be an uncaught throw — exit 2, every other bundle's findings
   * discarded, and Node's `EACCES: … open '/Users/…'` printed as the error,
   * which is the home-directory leak two docstrings in this lane claim to have
   * eliminated. Like the two above, it says conformance was NOT assessed for
   * this document rather than that the document is non-conformant.
   */
  'OKF_DOCUMENT_UNREADABLE',
  /**
   * §2 — a `.md` entry under the root whose BYTES do not live under the root: a
   * symlink pointing outside it, or one pointing at nothing.
   *
   * 🪤 The lane used to admit such a file into the population (via `stat`) while
   * the link judge reported a link to that same file as escaping the bundle —
   * VAT calling one file both inside and outside at once. The justification for
   * admitting it was also false: default `tar -cf` stores a symlink AS a
   * symlink, so only `-h`/`--dereference` copies the bytes, and the file whose
   * conformance VAT was reporting arrives at the consumer dangling.
   */
  'OKF_DOCUMENT_ESCAPES_BUNDLE',
  /** §8, §12 — frontmatter in an `index.md` beyond the one permitted root key. */
  'OKF_INDEX_FRONTMATTER_NOT_PERMITTED',
  /** §12 — a root `okf_version` that is not a `<major>.<minor>` string. */
  'OKF_VERSION_MALFORMED',
  /** §12 — a root `okf_version` disagreeing with the revision being checked against. */
  'OKF_VERSION_MISMATCH',
] as const;

export type OkfFindingCode = (typeof OKF_FINDING_CODES)[number];

/** One conformance finding, addressed to the bundle's publisher. */
export interface OkfFinding {
  code: OkfFindingCode;
  severity: OkfSeverity;
  /** What is wrong, and what the specification says instead. */
  message: string;
  /**
   * Bundle-relative, forward-slashed path of the document at fault.
   *
   * `'.'` means the bundle root itself, which only `OKF_BUNDLE_ROOT_UNREADABLE`
   * uses: there is no document to name when the root could not be listed, and an
   * empty string would read as a missing field rather than as the root.
   */
  document: string;
  /** The href as written, for the link findings. */
  link?: string;
  /** 1-based line of the link occurrence, when the parser reported one. */
  line?: number;
}

/** The result of validating one declared bundle. */
export interface OkfBundleReport {
  /** The `okf.bundles.<name>` key this report answers for. */
  bundle: string;
  /**
   * The bundle root **as the config file wrote it** — never the resolved
   * absolute path.
   *
   * 🪤 It used to be the absolute path, and this field is emitted for every
   * bundle, so a clean report published the developer's home directory into
   * every CI log: `grep -c "/Users/<name>" report.json` returned 3. The finding
   * messages had been scrubbed and pinned, which made the leak invisible —
   * "no absolute path is leaked" was true of the sentences and false of the
   * artifact. The specifier is also the more useful value: it is the string an
   * adopter would search their repository for.
   */
  root: string;
  /** Every non-reserved `.md` beneath the root, bundle-relative and sorted. */
  conceptDocuments: string[];
  /** Every `index.md` / `log.md` beneath the root, bundle-relative and sorted. */
  reservedDocuments: string[];
  /**
   * What the root `index.md` declares, when it declares a well-formed one.
   *
   * 🔑 Reported, never obeyed. Config is the source of truth and the artifact is
   * the suspect — the same posture `package.json`'s `vat.skills` is held in.
   * Nothing in this lane reads a setting out of this value.
   */
  declaredOkfVersion?: string;
  /** Findings, ordered by document then by code, so two runs compare. */
  findings: OkfFinding[];
  /** Whether any finding resolved to `error` severity. */
  hasErrors: boolean;
}
