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
import { importParserModule } from '../parse-cache.js';

import { discoverOkfBundle, type OkfBundleFiles } from './discovery.js';
import { conceptFindings, indexFindings, type OkfFindingDraft } from './findings.js';
import { linkFindings } from './links.js';
import type { OkfBundleReport, OkfFinding, OkfSeverity } from './types.js';

/** What a bundle validation run needs to know. */
export interface ValidateOkfBundleOptions {
  /** The `okf.bundles.<name>` key, carried into the report. */
  bundle: string;
  /** Absolute path to the bundle root, already resolved against the config file. */
  root: string;
  /**
   * The `root` value **as the config file wrote it**, for the unreadable-root
   * finding to quote.
   *
   * Carried separately rather than derived, for two reasons. It is the string
   * the adopter has to go and edit, so quoting the resolved absolute path would
   * name a location that appears nowhere in their repository; and an absolute
   * path in a finding message leaks the developer's home directory into every CI
   * log, which `link-validator.ts` already refuses to do for the same reason.
   * Absent, the message falls back to {@link ValidateOkfBundleOptions.root}.
   */
  rootSpecifier?: string;
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
  declaredOkfVersion?: string;
}

/** Read one document and judge it, by whichever rules its filename selects. */
async function inspectDocument(
  root: string,
  document: string,
  reserved: boolean,
  specVersion: string | undefined,
  fsCache: FsLookupCache,
): Promise<DocumentInspection> {
  const absolutePath = safePath.join(root, document);
  const parsed: ParseResult = await parseOkfDocument(absolutePath);

  // Links are resolved in every document, reserved or not: an index.md is
  // precisely where a link to a deleted concept accumulates, since §8 has it
  // enumerate the directory's contents.
  const drafts = await linkFindings(document, absolutePath, parsed.links, root, fsCache);

  if (!reserved) {
    drafts.push(...conceptFindings(document, parsed));
    return { drafts };
  }

  // Bundle-relative and forward-slashed, so the root index.md — and only it —
  // is the bare string. Any other index.md carries at least one separator.
  if (document === 'index.md') {
    const inspection = indexFindings(document, parsed, true, specVersion);
    drafts.push(...inspection.drafts);
    return inspection.declaredOkfVersion === undefined
      ? { drafts }
      : { drafts, declaredOkfVersion: inspection.declaredOkfVersion };
  }

  if (document.endsWith('/index.md')) {
    drafts.push(...indexFindings(document, parsed, false, specVersion).drafts);
  }

  return { drafts };
}

/**
 * The errno of a filesystem failure, and nothing else.
 *
 * ⚠️ The `Error.message` is deliberately NOT used: Node writes the full absolute
 * path into it (`ENOENT: … scandir '/Users/…/nowhere'`), which is the home-directory
 * leak the finding exists to avoid. The code says what went wrong — absent,
 * not a directory, not permitted — and the specifier says where.
 *
 * @param error - Whatever the walk threw
 * @returns The errno string, or a neutral word when there is none
 */
function fsErrorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unreadable';
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
 * @param options - The run that failed, for the bundle name and the specifier
 * @param root - The resolved absolute root, carried into the report as usual
 * @param error - Whatever the walk threw
 * @returns A one-finding report with an empty population
 */
function unreadableRootReport(
  options: ValidateOkfBundleOptions,
  root: string,
  error: unknown,
): OkfBundleReport {
  const specifier = options.rootSpecifier ?? options.root;
  return {
    bundle: options.bundle,
    root,
    conceptDocuments: [],
    reservedDocuments: [],
    findings: [{
      code: 'OKF_BUNDLE_ROOT_UNREADABLE',
      severity: 'error',
      document: '.',
      message: `okf.bundles.${options.bundle}.root ('${specifier}') is not a readable directory (${fsErrorCode(error)}), so this bundle was not checked at all. Point it at the directory holding the bundle's concept documents, relative to vibe-agent-toolkit.config.yaml.`,
    }],
    hasErrors: true,
  };
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
    return unreadableRootReport(options, root, error);
  }

  // One cache for the whole bundle: link targets cluster into far fewer
  // directories than there are links, so a per-document cache would re-list the
  // same directory once per document that points into it.
  const fsCache = new FsLookupCache();
  const drafts: OkfFindingDraft[] = [];
  let declaredOkfVersion: string | undefined;

  const documents: ReadonlyArray<readonly [string, boolean]> = [
    ...files.conceptDocuments.map((document) => [document, false] as const),
    ...files.reservedDocuments.map((document) => [document, true] as const),
  ];

  for (const [document, reserved] of documents) {
    const inspection = await inspectDocument(root, document, reserved, options.specVersion, fsCache);
    drafts.push(...inspection.drafts);
    declaredOkfVersion ??= inspection.declaredOkfVersion;
  }

  drafts.sort(byDocumentThenCode);
  const findings: OkfFinding[] = drafts.map((draft) => ({ ...draft, severity }));

  return {
    bundle: options.bundle,
    root,
    conceptDocuments: files.conceptDocuments,
    reservedDocuments: files.reservedDocuments,
    ...(declaredOkfVersion !== undefined && { declaredOkfVersion }),
    findings,
    hasErrors: findings.some((finding) => finding.severity === 'error'),
  };
}
