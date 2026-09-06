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

/** The dial an adopter sets per bundle. Defaults to `error` — VAT is producer-side. */
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
  /** §11.2 — parseable frontmatter carrying no `type` key. */
  'OKF_TYPE_MISSING',
  /** §11.2 — a `type` that is present but not a non-empty string. */
  'OKF_TYPE_INVALID',
  /** §6.1 — a markdown cross-link whose target is not in the bundle. */
  'OKF_BROKEN_CROSS_LINK',
  /** §2, §6.1 — a link resolving outside the root, so it cannot travel with the bundle. */
  'OKF_LINK_ESCAPES_BUNDLE',
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
  /** Bundle-relative, forward-slashed path of the document at fault. */
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
  /** Absolute, forward-slashed bundle root. */
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
