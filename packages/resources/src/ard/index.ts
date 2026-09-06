/**
 * ARD (Agentic Resource Discovery) entry emission.
 *
 * **Emit, never depend.** ARD is v0.91, status Proposal. VAT produces entries
 * from surfaces it already knows about; nothing in VAT reads an ARD entry back
 * or derives behaviour from one. See
 * `docs/concepts/knowledge-interop-formats.md` for where this sits beside OKF,
 * and `docs/external/ard/README.md` for the vendored authority and the one
 * upstream casing divergence VAT works around.
 */

export {
  ARD_IDENTIFIER_PATTERN_SOURCE,
  ARD_NAME_SEGMENT_PATTERN,
  ARD_PUBLISHER_SEGMENT_PATTERN,
  ArdEntrySchema,
  ArdManifestSchema,
  ArdMetadataValueSchema,
  ArdTrustManifestSchema,
  isArdIdentifier,
  type ArdEntry,
  type ArdManifest,
  type ArdTrustManifest,
} from './entry-schema.js';

export {
  ArdDerivationError,
  buildArdEntries,
  buildArdEntry,
  type ArdSurface,
} from './entry-builder.js';

export {
  ARD_CONTEXT_URI,
  ARD_WELL_KNOWN_PATH,
  buildArdManifest,
  writeArdManifest,
} from './manifest.js';

export {
  ARD_DEFAULT_NAMESPACES,
  ARD_SKILL_MEDIA_TYPE,
  defaultArdNamespace,
  deriveArdMediaType,
  type ArdSurfaceKind,
} from './surface.js';
