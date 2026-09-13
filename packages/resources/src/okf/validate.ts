/**
 * Validate one declared OKF bundle, producer-side.
 *
 * ## The gate posture, stated once
 *
 * §11 tells CONSUMERS they must not reject a bundle for unknown keys, unknown
 * types, missing optional fields, broken cross-links or a missing index. VAT is
 * not a consumer: it is tooling for the publisher, and the publisher is the only
 * party who can fix any of those. So the forgiveness list constrains nothing
 * here and findings default to **error**, lowerable per bundle through
 * `okf.bundles.<name>.severity`. See
 * `docs/concepts/knowledge-interop-formats.md`.
 *
 * ## What is NOT checked, so nobody reads the silence as a pass
 *
 * §11's item 3 — that `index.md` and `log.md` follow §8 and §9 *structurally*
 * (section headings, ISO date headings, a bullet per entry) — is not
 * implemented. The frontmatter half of §8 is (see `findings.ts`), because the
 * `okf_version` cross-check has to read that block anyway; the body half is not.
 * A bundle this lane calls clean has satisfied §11.1 and §11.2 in full and §11.3
 * only in part.
 */

import { FsLookupCache, safePath } from '@vibe-agent-toolkit/utils';

import type { ParseResult } from '../link-parser.js';
import { importParserModule, isParserUnavailable } from '../parse-cache.js';

import {
  discoverOkfBundle,
  fsErrorCode,
  type OkfBundleFiles,
  type OkfUnpackableDocument,
  type OkfUnreadableDirectory,
} from './discovery.js';
import { conceptFindings, indexFindings, type OkfFindingDraft } from './findings.js';
import { BundleDirectoryIndex, linkFindings } from './links.js';
import type { OkfBundleReport, OkfFinding, OkfFindingCode, OkfSeverity } from './types.js';

/** What a bundle validation run needs to know. */
export interface ValidateOkfBundleOptions {
  /** The `okf.bundles.<name>` key, carried into the report. */
  bundle: string;
  /** Absolute path to the bundle root, already resolved against the config file. */
  root: string;
  /**
   * The `root` value **as the config file wrote it**, and the only spelling of
   * the root the report is allowed to publish.
   *
   * ⛔ **Required, not optional.** It was optional, defaulting to the resolved
   * absolute path — which meant the "no absolute path is leaked" property held
   * only for callers who happened to pass it, and {@link OkfBundleReport.root}
   * published `/Users/<name>/…` into every CI log for the ones who did not. A
   * property that a caller can silently opt out of is not a property. Callers
   * with nothing better to name pass the string a human would have typed.
   */
  rootSpecifier: string;
  /** Severity for this bundle's findings. Defaults to `error`. */
  severity?: OkfSeverity;
  /**
   * The OKF revision to cross-check a declared `okf_version` against.
   *
   * ⛔ **Optional on purpose, and VAT ships no default for it.** A default would
   * be a version constant — a string a human must remember to bump for stored
   * data to be judged valid — which this repo forbids outright (see CLAUDE.md,
   * "NO VERSIONS"). The revision a run checks against is therefore supplied by
   * the caller, and when nothing supplies one the declaration is *reported*
   * rather than judged. That is the honest posture anyway: the artifact is a
   * suspect, and a suspect with no witness is not thereby guilty.
   *
   * 🔑 And this is the correct SCOPE, not a check left half-armed. CLAUDE.md's
   * remedy for a version constant is to *ask a different question*, and doing
   * that here dissolves this one. Two questions were conflated:
   *
   * | The real question | What answers it |
   * |---|---|
   * | Can VAT read this bundle? | `OkfConceptFrontmatterSchema`, which moves when the shape moves |
   * | Did the author declare a well-formed `okf_version`? | The `<major>.<minor>` grammar check below, which needs no reference value |
   *
   * Neither needs to know which revision VAT "is". A third question — *does
   * the author's declared revision equal ours?* — is the only one that would,
   * and its answer changes nothing: a bundle that passes every conformance item
   * is conformant whatever number its `index.md` names, and one that fails is
   * not rescued by a matching number. So the comparison is offered to a caller
   * who wants it and is never manufactured.
   */
  specVersion?: string;
}

/**
 * Read and parse one bundle document, loading the markdown parser on first use.
 *
 * ⚠️ **The `import()` must stay dynamic.** A static
 * `import { parseMarkdown } from '../link-parser.js'` here is invisible in
 * review and reaches far outside this lane: `okf/index.js` is value-re-exported
 * by the package barrel, so a static import puts the whole remark stack —
 * ~730ms on Windows — into the module graph of EVERY command that touches
 * `@vibe-agent-toolkit/resources`, including the ones that parse nothing. That
 * is the exact regression
 * `packages/cli/test/integration/module-load-budget.integration.test.ts`
 * exists to catch, and it is what fails if this is flattened back. It has
 * already happened once, on this very file.
 *
 * The load goes through `importParserModule` for the same reason the barrel's
 * `parseMarkdown` wrapper does: this route reads the file itself, so it bypasses
 * `loadParser` and owns its own load failure. Unwrapped, a broken install
 * arrives here as a bare `EACCES` and gets reported as a bad *document*. The
 * parse call is deliberately outside that boundary — a document that will not
 * parse is not a broken install.
 *
 * Loaded per document rather than hoisted above the walk: `import()` is a
 * module-cache lookup after the first call, and hoisting a parser load above a
 * per-document loop is the shape that has twice cancelled this saving elsewhere.
 *
 * @param absolutePath - Absolute path to the document to parse
 * @returns Links, headings, frontmatter and measures for the document
 * @throws {ParserUnavailableError} If the parser module cannot be loaded
 */
async function parseOkfDocument(absolutePath: string): Promise<ParseResult> {
  const parse = await importParserModule(
    'markdown',
    async () => (await import('../link-parser.js')).parseMarkdown,
  );
  return parse(absolutePath);
}

/** One document's contribution to the report. */
interface DocumentInspection {
  drafts: OkfFindingDraft[];
  /** Findings whose severity the per-bundle dial does not reach. */
  hardFindings: OkfFinding[];
  declaredOkfVersion?: string;
}

/**
 * The finding a document that was enumerated and then would not open earns.
 *
 * 🪤 This used to be an uncaught throw, and it is the more common one of the
 * pair: the root-listing throw was closed and this was left, so a single
 * unreadable file still exited the command at **2**, discarded every other
 * bundle's findings, and printed Node's `EACCES: … open '/Users/…'` — the exit
 * code and the home-directory leak that two docstrings in this module claim to
 * have eliminated.
 *
 * @param document - Bundle-relative path of the document
 * @param error - Whatever the read threw
 * @returns A hard-error finding naming the document and the errno, no path
 */
function unreadableDocumentFinding(document: string, error: unknown): OkfFinding {
  return {
    code: 'OKF_DOCUMENT_UNREADABLE',
    severity: 'error',
    document,
    message: `This document is inside the bundle and could not be read (${fsErrorCode(error)}), so its conformance was not assessed. Every other document in the bundle still was. Fix its permissions, or remove it from the bundle root.`,
  };
}

/** Read one document and judge it, by whichever rules its filename selects. */
async function inspectDocument(
  root: string,
  document: string,
  reserved: boolean,
  specVersion: string | undefined,
  index: BundleDirectoryIndex,
): Promise<DocumentInspection> {
  const absolutePath = safePath.join(root, document);

  let parsed: ParseResult;
  try {
    parsed = await parseOkfDocument(absolutePath);
  } catch (error) {
    // ⛔ A broken parser install is NOT a bad document, and reporting it as one
    // would send an adopter editing a file that is fine. `importParserModule`
    // owns that failure and it is rethrown untouched.
    if (isParserUnavailable(error)) throw error;
    return { drafts: [], hardFindings: [unreadableDocumentFinding(document, error)] };
  }

  // Links are resolved in every document, reserved or not: an index.md is
  // precisely where a link to a deleted concept accumulates, since §8 has it
  // enumerate the directory's contents.
  const drafts = await linkFindings(document, absolutePath, parsed.links, root, index);

  if (!reserved) {
    drafts.push(...conceptFindings(document, parsed));
    return { drafts, hardFindings: [] };
  }

  // Bundle-relative and forward-slashed, so the root index.md — and only it —
  // is the bare string. Any other index.md carries at least one separator.
  if (document === 'index.md') {
    const inspection = indexFindings(document, parsed, true, specVersion);
    drafts.push(...inspection.drafts);
    return inspection.declaredOkfVersion === undefined
      ? { drafts, hardFindings: [] }
      : { drafts, hardFindings: [], declaredOkfVersion: inspection.declaredOkfVersion };
  }

  if (document.endsWith('/index.md')) {
    drafts.push(...indexFindings(document, parsed, false, specVersion).drafts);
  }

  return { drafts, hardFindings: [] };
}

/**
 * The report a bundle whose root could not be listed gets.
 *
 * 🪤 This used to be a rethrow, which exited the whole command at 2 and took
 * every OTHER bundle's real findings with it — one typo'd root and a CI log that
 * says "the tool broke" rather than "this bundle is misconfigured". Reporting it
 * as this bundle's own finding keeps the rest of the run intact.
 *
 * The severity is hard `error` and does not read
 * {@link ValidateOkfBundleOptions.severity}: see {@link OkfSeverity} for why a
 * conformance dial has no standing over a bundle whose conformance was never
 * assessed.
 *
 * ⚠️ **Only the ROOT's own listing failure reaches here.** The `try` used to
 * wrap the entire recursive walk, so any `readdir` failure anywhere in the tree
 * came back as this — an adopter told to re-point a config key that was correct,
 * about a root that was readable, while the documents beside the bad subtree
 * went unjudged. `discoverOkfBundle` now returns subdirectory failures instead
 * of throwing them; see {@link unreadableDirectoryFinding}.
 *
 * @param options - The run that failed, for the bundle name and the specifier
 * @param error - Whatever the walk threw
 * @returns A one-finding report with an empty population
 */
function unreadableRootReport(
  options: ValidateOkfBundleOptions,
  error: unknown,
): OkfBundleReport {
  return {
    bundle: options.bundle,
    root: options.rootSpecifier,
    conceptDocuments: [],
    reservedDocuments: [],
    findings: [{
      code: 'OKF_BUNDLE_ROOT_UNREADABLE',
      severity: 'error',
      document: '.',
      message: `okf.bundles.${options.bundle}.root ('${options.rootSpecifier}') is not a readable directory (${fsErrorCode(error)}), so this bundle was not checked at all. Point it at the directory holding the bundle's concept documents, relative to vibe-agent-toolkit.config.yaml.`,
    }],
    hasErrors: true,
  };
}

/**
 * The finding one unreadable SUBdirectory earns.
 *
 * Hard `error` for the same reason the root's is: a subtree nobody could open
 * was never assessed, and a conformance dial has no standing over "I could not
 * look" (see {@link OkfSeverity}).
 *
 * @param entry - The directory and the errno discovery recorded
 * @returns A finding naming that subdirectory, not the bundle root
 */
function unreadableDirectoryFinding(entry: OkfUnreadableDirectory): OkfFinding {
  return {
    code: 'OKF_SUBDIRECTORY_UNREADABLE',
    severity: 'error',
    document: entry.directory,
    message: `This directory is inside the bundle root and could not be listed (${entry.code}), so no document beneath it was checked. The rest of the bundle was. Fix its permissions, or move it outside the bundle root.`,
  };
}

/**
 * The finding a `.md` entry whose bytes do not travel with the bundle earns.
 *
 * §2 makes the bundle the unit of distribution, and default `tar -cf` stores a
 * symlink AS a symlink — so a link out of the root, or a link to nothing, is a
 * member that arrives dangling at every consumer. It is reported at the bundle's
 * own severity because the entry WAS seen and judged.
 *
 * @param entry - The document and why it is not a member
 * @returns A draft naming the entry and the remedy for its reason
 */
function unpackableDocumentDraft(entry: OkfUnpackableDocument): OkfFindingDraft {
  const cause = entry.reason === 'outside'
    ? 'it is a symlink whose target is outside the bundle root'
    : 'it is a symlink whose target does not exist';
  return {
    code: 'OKF_DOCUMENT_ESCAPES_BUNDLE',
    document: entry.document,
    message: `This .md entry is not a bundle member: ${cause}. A bundle is the unit of distribution (§2) and \`tar\` stores a symlink as a symlink unless it is given --dereference, so this arrives at every consumer as a dangling link. It is excluded from the conformance population for the same reason a LINK to it is reported as escaping the bundle. Copy the file into the root, or remove the link.`,
  };
}

/**
 * The codes the per-bundle severity dial does not reach, enforced rather than
 * observed.
 *
 * `OkfSeverity`'s docstring states the rule — a conformance dial has no
 * standing over a finding that says conformance was never ASSESSED — and until
 * now the rule was kept by routing: three call sites built a finished
 * {@link OkfFinding} carrying its own `error`, and everything else built a
 * draft the dial stamped. That held only for as long as every emitter of a
 * "could not look" code happened to be one of those three.
 *
 * 🪤 It stopped holding the moment the LINK judge learned to report a refused
 * listing, because a link finding is a draft by construction: `linkFindings`
 * returns drafts. `severity: warning` on that bundle would have demoted "VAT
 * never got to look at this link" to a warning — the green-without-running
 * shape the dial's docstring exists to forbid, arriving through the one route
 * its author had no reason to expect. Deciding it from the CODE means the rule
 * is true of every emitter, present and future, including one that has not
 * been written.
 */
const UNASSESSED_CODES: ReadonlySet<OkfFindingCode> = new Set([
  'OKF_BUNDLE_ROOT_UNREADABLE',
  'OKF_SUBDIRECTORY_UNREADABLE',
  'OKF_DOCUMENT_UNREADABLE',
]);

/** Stamp the bundle's dial on a draft — unless its code is out of the dial's reach. */
function stamp(draft: OkfFindingDraft, severity: OkfSeverity): OkfFinding {
  return { ...draft, severity: UNASSESSED_CODES.has(draft.code) ? 'error' : severity };
}

/** Order findings so two runs over one bundle produce comparable reports. */
function byDocumentThenCode(left: OkfFindingDraft, right: OkfFindingDraft): number {
  if (left.document !== right.document) return left.document < right.document ? -1 : 1;
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  return (left.line ?? 0) - (right.line ?? 0);
}

/**
 * Validate a bundle against the OKF conformance items VAT implements.
 *
 * @param options - The bundle to validate and how hard to gate on it
 * @returns The findings, the population they were drawn from, and any declared
 *   `okf_version`. An unreadable root yields a one-finding report rather than a
 *   throw, so a sibling bundle's findings survive a misconfigured neighbour
 */
export async function validateOkfBundle(
  options: ValidateOkfBundleOptions,
): Promise<OkfBundleReport> {
  const root = safePath.resolve(options.root);
  const severity: OkfSeverity = options.severity ?? 'error';

  let files: OkfBundleFiles;
  try {
    files = await discoverOkfBundle(root);
  } catch (error) {
    return unreadableRootReport(options, error);
  }

  // One cache for the whole bundle: link targets cluster into far fewer
  // directories than there are links, so a per-document cache would re-list the
  // same directory once per document that points into it.
  const index = new BundleDirectoryIndex(root, new FsLookupCache());
  const drafts: OkfFindingDraft[] = files.unpackableDocuments.map(unpackableDocumentDraft);
  const hardFindings: OkfFinding[] = files.unreadableDirectories.map(unreadableDirectoryFinding);
  let declaredOkfVersion: string | undefined;

  const documents: ReadonlyArray<readonly [string, boolean]> = [
    ...files.conceptDocuments.map((document) => [document, false] as const),
    ...files.reservedDocuments.map((document) => [document, true] as const),
  ];

  for (const [document, reserved] of documents) {
    const inspection = await inspectDocument(root, document, reserved, options.specVersion, index);
    drafts.push(...inspection.drafts);
    hardFindings.push(...inspection.hardFindings);
    declaredOkfVersion ??= inspection.declaredOkfVersion;
  }

  // The dial is stamped by `stamp`, which withholds it from the codes that say
  // conformance was never ASSESSED — see UNASSESSED_CODES and OkfSeverity. The
  // hard findings already carry their own `error` and are appended as built.
  const findings: OkfFinding[] = [
    ...drafts.map((draft) => stamp(draft, severity)),
    ...hardFindings,
  ];
  findings.sort(byDocumentThenCode);

  return {
    bundle: options.bundle,
    root: options.rootSpecifier,
    conceptDocuments: files.conceptDocuments,
    reservedDocuments: files.reservedDocuments,
    ...(declaredOkfVersion !== undefined && { declaredOkfVersion }),
    findings,
    hasErrors: findings.some((finding) => finding.severity === 'error'),
  };
}
