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

import { safePath } from '@vibe-agent-toolkit/utils';

import type { ParseResult } from '../link-parser.js';
import { importParserModule } from '../parse-cache.js';

import { discoverOkfBundle } from './discovery.js';
import { conceptFindings, indexFindings, type OkfFindingDraft } from './findings.js';
import { linkFindings } from './links.js';
import type { OkfBundleReport, OkfFinding, OkfSeverity } from './types.js';

/** What a bundle validation run needs to know. */
export interface ValidateOkfBundleOptions {
  /** The `okf.bundles.<name>` key, carried into the report. */
  bundle: string;
  /** Absolute path to the bundle root, already resolved against the config file. */
  root: string;
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
): Promise<DocumentInspection> {
  const absolutePath = safePath.join(root, document);
  const parsed: ParseResult = await parseOkfDocument(absolutePath);

  // Links are resolved in every document, reserved or not: an index.md is
  // precisely where a link to a deleted concept accumulates, since §8 has it
  // enumerate the directory's contents.
  const drafts = await linkFindings(document, absolutePath, parsed.links, root);

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
 *   `okf_version`
 * @throws If the bundle root cannot be read — an unreadable root is a
 *   configuration finding, never a trivially conformant empty bundle
 */
export async function validateOkfBundle(
  options: ValidateOkfBundleOptions,
): Promise<OkfBundleReport> {
  const root = safePath.resolve(options.root);
  const severity: OkfSeverity = options.severity ?? 'error';
  const files = await discoverOkfBundle(root);

  const drafts: OkfFindingDraft[] = [];
  let declaredOkfVersion: string | undefined;

  const documents: ReadonlyArray<readonly [string, boolean]> = [
    ...files.conceptDocuments.map((document) => [document, false] as const),
    ...files.reservedDocuments.map((document) => [document, true] as const),
  ];

  for (const [document, reserved] of documents) {
    const inspection = await inspectDocument(root, document, reserved, options.specVersion);
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
