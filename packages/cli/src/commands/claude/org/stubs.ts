/**
 * The not-implemented `claude org` leaves. Each ends, at its own leaf, on an
 * `endWithRefusal` call naming its own verb with `NOT_IMPLEMENTED`, this
 * message and `NOTHING_FINISHED` — the envelope's error branch, nothing
 * examined, exit 2 — so the writer-call scan in `published-shapes.test.ts`
 * sees each verb's call.
 *
 * The message deliberately makes no scheduling claim. It used to emit
 * `plannedFor: "0.1.22"` plus "coming in the next release" — a promise nothing
 * in the build re-checks, so every release that shipped without the feature
 * turned it into a lie (by 0.1.41 the "planned" version was 19 releases in the
 * past). A stub can only state what is true at ANY version: the command is not
 * implemented, and here is what to use instead. If a date or milestone is ever
 * wanted, it belongs on a tracking issue that can be closed — not in a string
 * baked into the binary. Covered by `test/claude-org-stubs.test.ts`.
 */

/** The one refusal message every stub publishes: true at any version, and names what to use instead. */
export const NOT_IMPLEMENTED_MESSAGE =
  'This command is not implemented. Read operations (list/get) are implemented; mutating operations are not. '
  + 'Use the Anthropic Console or call the Admin API directly.';
