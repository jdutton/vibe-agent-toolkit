/**
 * OKF (Open Knowledge Format) v0.2 bundle conformance, producer-side.
 *
 * Four modules, one each for a question:
 *
 * - `discovery` — which files is the bundle judged over? (spec-defined, maximal)
 * - `findings` — do the concept documents and the root index satisfy §11?
 * - `links` — does every cross-link resolve inside the bundle? (§6.1)
 * - `config` — which bundles did the project declare, and where are they?
 *
 * `validate` composes them. Nothing here consumes a bundle: VAT emits findings
 * for a publisher and never derives behaviour from bundle content.
 */

export { discoverOkfBundle, type OkfBundleFiles } from './discovery.js';
export { okfBundleRuns, type OkfBundleRunOptions } from './config.js';
export { validateOkfBundle, type ValidateOkfBundleOptions } from './validate.js';
export {
  OKF_FINDING_CODES,
  type OkfBundleReport,
  type OkfFinding,
  type OkfFindingCode,
  type OkfSeverity,
} from './types.js';
