/**
 * The per-document conformance judgements: §11's items 1 and 2, and §8/§12's
 * rules for the one reserved file that may carry frontmatter.
 *
 * Pure, and deliberately so — every function here takes an already-parsed
 * document and returns findings. The filesystem is touched only by link
 * resolution (`links.ts`) and by discovery, which keeps the rules that decide
 * *conformance* unit-testable without a tree.
 */

import { OkfConceptFrontmatterSchema } from '../schemas/okf-concept.js';

import type { OkfFinding } from './types.js';

/**
 * A finding before the bundle's severity is stamped on it.
 *
 * Severity is applied once, at the end of a run, because it is a per-BUNDLE
 * dial (`okf.bundles.<name>.severity`) rather than a per-code one. Threading it
 * through every rule would imply a per-code surface that does not exist.
 */
export type OkfFindingDraft = Omit<OkfFinding, 'severity'>;

/**
 * The single place `<major>.<minor>` is spelled (§12).
 *
 * ⚠️ This is a GRAMMAR, not a value. It says what shape a declared version has
 * to be, and knows nothing about which revision is current — which is exactly
 * why it can live in the code: nothing here goes stale when OKF ships 0.3.
 */
const OKF_VERSION_GRAMMAR = /^\d+\.\d+$/;

/** What inspecting a reserved `index.md` produced. */
export interface IndexInspection {
  drafts: OkfFindingDraft[];
  /** The well-formed version a bundle-root `index.md` declared, if it did. */
  declaredOkfVersion?: string;
}

/**
 * Judge one concept document against §11 items 1 and 2.
 *
 * The `type` rule is delegated to {@link OkfConceptFrontmatterSchema}'s own
 * `type` field rather than restated here. One statement of "non-empty string"
 * means the shipped JSON Schema and this gate cannot drift into disagreeing
 * about which documents are conformant.
 *
 * @param document - Bundle-relative path, for the finding
 * @param parsed - What the markdown parser made of the file
 */
export function conceptFindings(
  document: string,
  parsed: { frontmatter?: Record<string, unknown>; frontmatterError?: string; frontmatterSource?: string },
): OkfFindingDraft[] {
  if (parsed.frontmatterError !== undefined) {
    return [{
      code: 'OKF_FRONTMATTER_UNPARSEABLE',
      document,
      message: `Frontmatter YAML does not parse (${parsed.frontmatterError}). OKF §11.1 requires a parseable YAML frontmatter block on every non-reserved .md file.`,
    }];
  }

  // A block that is absent and a block that is empty are different failures with
  // different remedies — "add frontmatter" versus "add a type" — so the
  // distinction the parser preserves is preserved here too.
  if (parsed.frontmatterSource === undefined) {
    return [{
      code: 'OKF_FRONTMATTER_MISSING',
      document,
      message: 'No YAML frontmatter block. OKF §11.1 requires one on every non-reserved .md file; only index.md and log.md are exempt (§3.1).',
    }];
  }

  const frontmatter = parsed.frontmatter ?? {};
  if (!Object.hasOwn(frontmatter, 'type')) {
    return [{
      code: 'OKF_TYPE_MISSING',
      document,
      message: 'Frontmatter carries no `type`. OKF §4.1 makes it the only always-required key; a concept carrying just `type` is fully conformant. Values are not centrally registered — pick a descriptive one.',
    }];
  }

  if (!OkfConceptFrontmatterSchema.shape.type.safeParse(frontmatter['type']).success) {
    return [{
      code: 'OKF_TYPE_INVALID',
      document,
      message: `\`type\` must be a non-empty string (OKF §11.2), and this one is ${JSON.stringify(frontmatter['type'])}. An unquoted YAML scalar decodes to a number or boolean — quote it if the value looks like one.`,
    }];
  }

  return [];
}

/** Report every frontmatter key an index.md is not entitled to carry. */
function indexKeyDraft(document: string, keys: string[], permitted: string): OkfFindingDraft {
  return {
    code: 'OKF_INDEX_FRONTMATTER_NOT_PERMITTED',
    document,
    message: `index.md carries frontmatter ${JSON.stringify(keys)}. OKF §8 says index files contain no frontmatter, with one exception: ${permitted}`,
  };
}

/** Judge a declared root `okf_version` — its shape, then its value (§12). */
function versionDrafts(
  document: string,
  declared: unknown,
  specVersion: string | undefined,
): IndexInspection {
  if (typeof declared !== 'string' || !OKF_VERSION_GRAMMAR.test(declared)) {
    return {
      drafts: [{
        code: 'OKF_VERSION_MALFORMED',
        document,
        message: `okf_version is ${JSON.stringify(declared)}. OKF §12 writes it as a quoted \`<major>.<minor>\` string — \`okf_version: "0.2"\`. Unquoted, YAML decodes it to a number, which cannot tell 0.2 from 0.20.`,
      }],
    };
  }

  // The declaration is a suspect, not an input. With no revision to check it
  // against, VAT reports what the artifact says and asserts nothing about it.
  if (specVersion === undefined || specVersion === declared) {
    return { drafts: [], declaredOkfVersion: declared };
  }

  return {
    drafts: [{
      code: 'OKF_VERSION_MISMATCH',
      document,
      message: `Bundle declares okf_version "${declared}", but this run checks against OKF "${specVersion}". Either the bundle targets a revision VAT is not checking, or the declaration is stale.`,
    }],
    declaredOkfVersion: declared,
  };
}

/**
 * Judge a reserved `index.md` against §8 and, at the bundle root, §12.
 *
 * ⛔ `log.md` gets no equivalent. §8's "no frontmatter" sentence is about index
 * files; §9 states no such rule for logs, and extending it there would report a
 * bundle the specification permits.
 *
 * @param document - Bundle-relative path
 * @param parsed - What the markdown parser made of the file
 * @param isBundleRoot - Whether this is the root index.md, the one place §12
 *   permits frontmatter
 * @param specVersion - The OKF revision to cross-check a declaration against.
 *   Absent means "report the declaration, assert nothing".
 */
export function indexFindings(
  document: string,
  parsed: { frontmatter?: Record<string, unknown>; frontmatterError?: string },
  isBundleRoot: boolean,
  specVersion?: string,
): IndexInspection {
  if (parsed.frontmatterError !== undefined) {
    return {
      drafts: [indexKeyDraft(document, ['<unparseable>'], `a bundle-root index.md MAY carry okf_version (§12). This block does not parse: ${parsed.frontmatterError}`)],
    };
  }

  const frontmatter = parsed.frontmatter ?? {};
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) {
    return { drafts: [] };
  }

  if (!isBundleRoot) {
    return {
      drafts: [indexKeyDraft(document, keys, 'the BUNDLE-ROOT index.md, and only for okf_version (§12). This index.md is not at the root.')],
    };
  }

  const drafts: OkfFindingDraft[] = [];
  const unpermitted = keys.filter((key) => key !== 'okf_version');
  if (unpermitted.length > 0) {
    drafts.push(indexKeyDraft(document, unpermitted, 'okf_version, and nothing else (§12).'));
  }

  if (!Object.hasOwn(frontmatter, 'okf_version')) {
    return { drafts };
  }

  const version = versionDrafts(document, frontmatter['okf_version'], specVersion);
  drafts.push(...version.drafts);
  return version.declaredOkfVersion === undefined
    ? { drafts }
    : { drafts, declaredOkfVersion: version.declaredOkfVersion };
}
