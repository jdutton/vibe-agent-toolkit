/**
 * `vat claude org skills` — manage organization skills via Skills API.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import {   basename } from 'node:path';

import {
  API_SKILL_MAX_UPLOAD_BYTES,
  collectNonPortableAssetReferenceIssues,
  collectNonPortableCommandIssues,
  collectUnqualifiedMcpToolIssues,
  declaredSkillNameIn,
  describeOversizeBundle,
  evalSuiteUnitPath,
  formatBytes,
  hostAddedToSkillZip,
  NEVER_UPLOADED_DIR_NAMES,
  readDeclaredSkillName,
} from '@vibe-agent-toolkit/agent-skills';
import {
  ApiRequestError,
  ApiTransportError,
  buildMultipartFormData,
  skillVersionsPath,
} from '@vibe-agent-toolkit/claude-marketplace';
import type {
  MultipartFile,
  MultipartResult,
  OrgApiClient,
} from '@vibe-agent-toolkit/claude-marketplace';
import { parseInputRefusal, withParseDispatcher } from '@vibe-agent-toolkit/resources';
import { createAllowUsageLedger, runValidationFramework } from '@vibe-agent-toolkit/schema';
import type { RefusalCode, ValidationConfig, ValidationIssue } from '@vibe-agent-toolkit/schema';
import { ARCHIVE_REFUSED_CODE, archiveEntryPlace, decodeTextContent, direntKindFollowingSync, everywhere, forEachInOrder, isAbsoluteAnyPlatform, isArchiveEntryReadRefusal, isVatError, pathPresent, requireFollowedStatSync, safePath, toForwardSlash, toForwardSlashAnyPlatform, withTempDir } from '@vibe-agent-toolkit/utils';
// Type-only: the runtime import stays lazy inside `inspectZipArchive`, so the
// archive readers are loaded on the one path that parses an archive.
import type { ArchiveEntry, ArchiveRefusedError, OpenedArchive } from '@vibe-agent-toolkit/utils/archive';
import { Command } from 'commander';

import { resolveSkillPackagingConfig } from '../../../skill-resolution/packaging-config.js';
import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../../utils/command-refusal.js';
import { leftoverIssueOf } from '../../../utils/document-writer.js';
import { requireSkillZipLayout } from '../../../utils/install-plan.js';
import { formatIssueLines } from '../../../utils/issue-rendering.js';
import { requireInputPath } from '../../../utils/project-root-policy.js';
import { declaredNameOrRefuse } from '../../skills/skill-discovery.js';
import { downloadNpmPackage } from '../plugin/helpers.js';

import type { OrgCommandFailure, OrgFailureOutcome } from './helpers.js';
import { autopaginateSkills, executeOrgCommand, orgCommandFailure } from './helpers.js';

const SKILL_ID_ARG = '<skill-id>';
const SKILL_ID_DESC = 'Skill ID (slug)';
const DEBUG_OPT_DESC = 'Enable debug logging';

// ── Helpers ────────────────────────────────────────────────────────────

export interface SkillUploadResult {
	id: string;
	displayTitle: string;
	version: string;
	createdAt: string;
}

interface UploadLogger {
	info: (msg: string) => void;
	/**
	 * REQUIRED, not optional. An optional `warn` invites `logger.warn?.(…)`,
	 * which drops the message wherever a caller supplied only `info` — and a
	 * warning that vanishes depending on its caller is the exact shape this
	 * command keeps being audited for.
	 */
	warn: (msg: string) => void;
}

/** Which response key supplies each field of a {@link SkillUploadResult}. */
interface UploadResponseFieldMap {
	readonly id: string;
	readonly displayTitle: string;
	readonly version: string;
	readonly createdAt: string;
}

/**
 * Read an upload response into the result this command prints, refusing a body
 * that does not carry the fields the printed document promises.
 *
 * 🔑 The client's `<T>` is a type ASSERTION, not a check: any 2xx with a JSON
 * body satisfies it, and `version` is the value a later `skills versions delete`
 * takes, so a drifted shape must fail loudly rather than print nulls.
 *
 * The message names both the fields that were missing and the keys the body did
 * carry, because those two lists together are the whole diagnosis when a shape
 * drifts.
 */
function readSkillUploadResponse(
	endpoint: string,
	raw: unknown,
	fields: UploadResponseFieldMap,
): SkillUploadResult {
	const body: Record<string, unknown> =
		typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
	const read = (key: string): string | undefined => {
		const value = body[key];
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	};

	const id = read(fields.id);
	const displayTitle = read(fields.displayTitle);
	const version = read(fields.version);
	const createdAt = read(fields.createdAt);

	if (id === undefined || displayTitle === undefined || version === undefined || createdAt === undefined) {
		const missing = [
			[fields.id, id], [fields.displayTitle, displayTitle],
			[fields.version, version], [fields.createdAt, createdAt],
		].filter(([, value]) => value === undefined).map(([key]) => String(key));
		const present = Object.keys(body).join(', ') || '(none)';
		throw new CommandRefusalError(
			'EXTERNAL_API_FAILED',
			`${endpoint} returned a body with no usable ${missing.join(', ')}. Keys present: ${present}. `
			+ 'Refusing to report success for an upload whose identifiers cannot be read.',
		);
	}

	return { id, displayTitle, version, createdAt };
}

/** Read `POST /v1/skills` — the shape measured against the live API. */
export function readCreateSkillResponse(raw: unknown): SkillUploadResult {
	return readSkillUploadResponse('POST /v1/skills', raw, {
		id: 'id', displayTitle: 'display_title', version: 'latest_version', createdAt: 'created_at',
	});
}

/** The document a delete command publishes. */
export interface SkillDeleteResult {
	readonly id: string;
	readonly deleted: boolean;
}

/**
 * Read a DELETE response into the result a delete command prints.
 *
 * 🔑 Same class of problem as {@link readSkillUploadResponse}, but the OPPOSITE
 * verdict on an empty body: a 204 is the success its status says (the id is the
 * one this process asked for), and refusing it would report a deletion as a
 * failure.
 *
 * `deleted` is false only when the body affirmatively names a DIFFERENT
 * outcome; {@link reportDelete} makes the run END that way.
 *
 * ⚠️ `expectedTypes` is a LIST because only `skill_deleted` is measured;
 * `skill_version_deleted` is the plausible spelling for the version endpoint,
 * and a single guessed string would fail every version delete on a
 * one-character difference.
 */
export function readDeleteResponse(
	raw: unknown,
	requestedId: string,
	expectedTypes: readonly string[],
): SkillDeleteResult {
	const body: Record<string, unknown> =
		typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
	const echoedId = body['id'];
	const type = body['type'];
	return {
		id: typeof echoedId === 'string' && echoedId.length > 0 ? echoedId : requestedId,
		deleted: typeof type === 'string' ? expectedTypes.includes(type) : true,
	};
}

/** The success types measured against the live `DELETE /v1/skills/{id}`. */
export const SKILL_DELETED_TYPES: readonly string[] = ['skill_deleted'];

/**
 * The success types a version delete may answer with — see
 * {@link readDeleteResponse} for why this is two and not one.
 */
export const SKILL_VERSION_DELETED_TYPES: readonly string[] = ['skill_version_deleted', 'skill_deleted'];

/** A delete the API answered with an outcome other than a deletion: nothing was destroyed. */
const NOT_CONFIRMED: OrgFailureOutcome = { kind: 'failed', cause: 'the API named an outcome other than a deletion' };

/**
 * A delete's document, tagged as a FAILED run when the API said the thing was
 * not deleted.
 *
 * 🔑 Without this, `deleted: false` would print under `status: success` and exit
 * 0, so `vat claude org skills delete X || fail` reports green while the skill
 * is still there. The document is still PUBLISHED; only the exit code changes.
 */
export function reportDelete(
	raw: unknown,
	requestedId: string,
	expectedTypes: readonly string[],
): SkillDeleteResult | OrgCommandFailure {
	const result = readDeleteResponse(raw, requestedId, expectedTypes);
	return result.deleted ? result : orgCommandFailure(result, NOT_CONFIRMED);
}

/** The document a version delete publishes: which version, of which skill. */
export interface SkillVersionDeleteResult extends SkillDeleteResult {
	readonly version: string;
}

/**
 * A version delete's document — the same verdict as {@link reportDelete}, about
 * a subject that can actually be identified.
 *
 * Both fields are local knowledge: this process asked to delete `version` of
 * `skillId`, so the subject's identity is never recovered from the response
 * (whose echoed `id` and 204 fallback name different namespaces). The response
 * is read only for the VERDICT.
 */
export function reportVersionDelete(
	raw: unknown,
	skillId: string,
	version: string,
): SkillVersionDeleteResult | OrgCommandFailure {
	const { deleted } = readDeleteResponse(raw, skillId, SKILL_VERSION_DELETED_TYPES);
	const document: SkillVersionDeleteResult = { id: skillId, version, deleted };
	return deleted ? document : orgCommandFailure(document, NOT_CONFIRMED);
}

/**
 * Add the versions a `--all` run destroyed to its report, preserving whatever
 * verdict {@link reportDelete} reached.
 *
 * Unwrapping and re-wrapping rather than spreading into the tagged value: the
 * failure tag sits BESIDE the document, so a naive `{ ...result, deletedVersions }`
 * on a failure would produce an object carrying `orgCommandFailed` next to the
 * skill's fields and publish the tag as part of the operator's document.
 */
export function mergeDeleteReport(
	result: SkillDeleteResult | OrgCommandFailure,
	deletedVersions: readonly string[],
): object {
	if (!('orgCommandFailed' in result)) return { ...result, deletedVersions };
	return orgCommandFailure({ ...result.document, deletedVersions }, result.outcome);
}

/** Read `POST /v1/skills/{id}/versions`. */
export function readSkillVersionResponse(raw: unknown): SkillUploadResult {
	return readSkillUploadResponse('POST /v1/skills/{id}/versions', raw, {
		id: 'skill_id', displayTitle: 'name', version: 'version', createdAt: 'created_at',
	});
}

/**
 * Build the multipart request body for an upload, refusing it before anything is
 * sent when THAT BODY is OVER the API's upload ceiling.
 *
 * 🔑 **The ceiling is INCLUSIVE, measured:** a request body of exactly
 * {@link API_SKILL_MAX_UPLOAD_BYTES} bytes is ACCEPTED and one byte more is
 * refused `413`, so the comparison is `>`, not `>=`.
 *
 * ⚠️ **The build-time lane deliberately differs, and must not be "harmonised"
 * with this one.** `checkPackagedSizeLimit` fires when FILE BYTES reach the same
 * number — `>=` — because framing is never zero. **File bytes `>=` refuse;
 * request bytes `>` refuse.**
 *
 * THE one gate every upload passes through, whichever shape it started as.
 *
 * 🔑 **It weighs the BODY, not the sum of the file bytes**: per-part multipart
 * framing is real request weight. The body is then RETURNED, so the bytes that
 * were weighed are the bytes that go out.
 */
export function buildUploadBodyOrRefuse(
	fields: Record<string, string>,
	files: readonly MultipartFile[],
	bundleRoot?: string,
): MultipartResult {
	const multipart = buildMultipartFormData(fields, [...files]);
	// `>`, not `>=`: see this function's doc comment.
	if (multipart.body.length > API_SKILL_MAX_UPLOAD_BYTES) {
		const sized = files.map(f => ({ path: bundleRelativeName(f.filename, bundleRoot), bytes: f.content.length }));
		const measure = { of: 'upload-request' as const, bytes: multipart.body.length };
		throw new CommandRefusalError('USAGE_INVALID', `${describeOversizeBundle(sized, measure)}. The API will refuse this upload.`);
	}
	return multipart;
}

/**
 * An uploaded part's filename in the SAME namespace the build-time finding uses.
 *
 * A directory's parts are keyed `<declared-name>/<bundle-relative-path>`, because
 * that is how the API roots them; `PACKAGED_SIZE_EXCEEDS_API_LIMIT` names files
 * relative to the bundle root; stripping the prefix lets one `validation.allow`
 * entry waive both. A ZIP is one part named for the archive, with no root.
 */
function bundleRelativeName(filename: string, bundleRoot: string | undefined): string {
	if (bundleRoot === undefined) return filename;
	// Both sides normalized before comparing. The parts are minted from
	// `safePath.relative`, so they are already forward-slashed — but a prefix test
	// that only holds because of where its inputs came from is one refactor from
	// silently never matching on Windows.
	const name = toForwardSlashAnyPlatform(filename);
	const prefix = `${toForwardSlashAnyPlatform(bundleRoot)}/`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * A vendor refusal this CLI can answer with a specific next command.
 *
 * `matches` are ALL required, and are deliberately more than one: a single word
 * like `version` appears in refusals that have nothing to do with this case, so
 * each entry names both the subject the API is talking about and the verdict it
 * reached about it.
 */
interface VendorRefusalRemedy {
	/** Every pattern must match the API's message for the remedy to apply. */
	readonly matches: readonly RegExp[];
	/** Appended to the vendor's sentence — never substituted for it. */
	readonly remedy: string;
}

/**
 * A failed request, re-thrown with the command that answers it when — and only
 * when — the API said one of the specific things listed by the caller.
 *
 * **What is matched, exactly:** an {@link ApiRequestError} whose `statusCode` is
 * 400 and whose message satisfies every pattern of one {@link
 * VendorRefusalRemedy}. Both live wordings are measured, not guessed:
 * `400 Skill cannot reuse an existing display_title` and
 * `400 Cannot delete skill with existing versions. Delete all versions first.`
 *
 * **How it fails safe:** anything that does not match is returned UNTOUCHED, so
 * an unrelated 400 keeps the API's exact words and gets no misleading remedy. If
 * the vendor rewords a refusal, the operator loses a hint — they never gain a
 * wrong one. The remedy is appended, so the vendor's sentence survives in full.
 *
 * One mechanism, several refusals, and each call site passes only the refusals
 * that are REACHABLE from it — a second copy of this matcher per case is how the
 * two would come to disagree about what "fail safe" means.
 */
export function withRemedy(error: unknown, candidates: readonly VendorRefusalRemedy[]): unknown {
	if (!(error instanceof ApiRequestError) || error.statusCode !== 400) return error;
	const message = error.message;
	const matched = candidates.find(c => c.matches.every(pattern => pattern.test(message)));
	if (matched === undefined) return error;
	return new ApiRequestError(
		`${message}\n${matched.remedy}`,
		error.statusCode,
		error.retryAfterHeader,
	);
}

/**
 * The display title is taken.
 *
 * It tells the operator how to FIND the id and does not offer to find it for
 * them: `display_title` is unique only when the field is sent explicitly, so a
 * workspace can hold several skills of one title and a title→id lookup matches
 * none, one, or several. Appending a version to the wrong match is silent and
 * destroys somebody else's skill, so the id is always the operator's to supply.
 */
const DUPLICATE_TITLE_REFUSAL: VendorRefusalRemedy = {
	matches: [/display_title/i, /reuse|already|exist|duplicat|unique/i],
	remedy:
		'This workspace already has a skill with that display title, and `install` only ever CREATES. '
		+ 'To ship a change to that skill, add a version to it: find its id with '
		+ '`vat claude org skills list`, then run '
		+ '`vat claude org skills versions add <skill-id> <source>`. '
		+ 'VAT will not turn the title into an id for you — display_title is not unique in general '
		+ '(the API enforces it only when the field is sent), so a title can match none, one, or '
		+ 'several skills. To create a genuinely separate skill instead, pass a different --title.',
};

/**
 * The skill still has versions, so it cannot be deleted.
 *
 * `--all` leads, because it IS the one-step path: the `--all` branch of this
 * command fetches every version and deletes them before deleting the skill. The
 * by-hand sequence follows for an operator who wants to see what is there first.
 * Naming only `versions delete` would send them round a loop they can already
 * ask the CLI to run.
 */
export const EXISTING_VERSIONS_REFUSAL: VendorRefusalRemedy = {
	matches: [/versions?/i, /cannot delete|delete all version|existing version/i],
	remedy:
		'A skill cannot be deleted while it still has versions. '
		+ 'Re-run with `--all` — `vat claude org skills delete <skill-id> --all` deletes every '
		+ 'version and then the skill, in one command. To do it by hand instead: list them with '
		+ '`vat claude org skills versions list <skill-id>`, delete each with '
		+ '`vat claude org skills versions delete <skill-id> <version>`, then delete the skill.',
};

/** Only the CREATE path can earn a duplicate-title refusal — see {@link uploadSkillDir}. */
export function withDuplicateTitleRemedy(error: unknown): unknown {
	return withRemedy(error, [DUPLICATE_TITLE_REFUSAL]);
}

/**
 * The version's SKILL.md declares a different `name` than the skill it is being
 * added to.
 *
 * The server enforces name consistency per `skill_id` (measured), which is why
 * `versions add` cannot silently re-root a skill's file tree and why this is the
 * one refusal that endpoint can earn. The remedy names both fixes, because which
 * one is right depends on what the operator meant: keep the skill and put its
 * name back, or publish the renamed tree as the separate skill it now is.
 *
 * ⚠️ The vendor's exact wording here has NOT been measured, only the fact of the
 * refusal. `withRemedy` fails safe on no match — the operator loses a hint, never
 * gains a wrong one — so a guessed pattern is the conservative thing to ship.
 */
export const VERSION_NAME_MISMATCH_REFUSAL: VendorRefusalRemedy = {
	matches: [/\bname\b/i, /match|consistent|differ|mismatch|same skill|must be/i],
	remedy:
		"This skill's files are rooted at the `name` its SKILL.md frontmatter declared when it was "
		+ 'created, and the API refuses a version that declares a different one. Either restore the '
		+ 'original name in this tree\'s SKILL.md and re-run, or — if the rename was deliberate — '
		+ 'publish the renamed tree as a NEW skill with '
		+ '`vat claude org skills install <source>`, which always creates.',
};

/** Only the VERSION path can earn a name-consistency refusal — see {@link uploadSkillVersionDir}. */
export function withVersionRootRemedy(error: unknown): unknown {
	return withRemedy(error, [VERSION_NAME_MISMATCH_REFUSAL]);
}

/**
 * The refusals a `skills delete` run WITHOUT `--all` can earn.
 *
 * The empty counterpart is not a missing case, it is the answer for a run that
 * already used `--all`: this command's `--all` branch deletes every version
 * before the skill, so an operator who just watched it do that does not need to
 * be told to run `--all` — that is exactly the loop the remedy exists to break.
 * A refusal after `--all` means something the version listing did not show, and
 * the vendor's own sentence is then the honest whole of what VAT knows.
 */
const DELETE_REMEDIES: readonly VendorRefusalRemedy[] = [EXISTING_VERSIONS_REFUSAL];
const DELETE_REMEDIES_AFTER_ALL: readonly VendorRefusalRemedy[] = [];

/** DELETE one skill, explaining the refusals this invocation could earn. */
async function deleteSkillOrExplain(
	client: OrgApiClient,
	skillId: string,
	remedies: readonly VendorRefusalRemedy[],
): Promise<unknown> {
	try {
		return await client.deleteSkill<unknown>(skillId);
	} catch (error) {
		throw withRemedy(error, remedies);
	}
}

/**
 * A failure that got NO answer from the server, re-thrown saying what was
 * actually sent and what a retry would risk.
 *
 * ⛔ **The trigger is a RECORDED FACT, never the error's class.** Only an
 * {@link ApiTransportError} is annotated: it exists only once the transport has
 * been reached and carries `bytesSent` read off the socket. Anything else — a
 * missing credential (thrown before any socket opens), a bad URL, a response VAT
 * refused to read — passes through with its own message untouched.
 *
 * Two outcomes, because the byte count decides which is TRUE:
 *
 * - **Nothing left the machine** (`bytesSent === 0`: DNS never resolved, the
 *   connection was refused, the handshake failed). The outcome is not unknown,
 *   it is known: nothing happened. Saying "check what exists" here would send
 *   an operator to look for a skill that was never sent.
 * - **Some bytes went out and no status came back.** Now the outcome genuinely
 *   is unknown, and the part the operator cannot see is how far it got. The
 *   client never replays a POST — one that failed with no status may still have
 *   taken effect — so the retry is theirs, and it can leave two skills behind.
 *
 * **No threshold.** There is no constant here for "close to the ceiling" and
 * there must not be: an invented margin is a number nobody can re-derive. The
 * bytes sent, the body size and the ceiling are printed and the reader draws
 * their own conclusion.
 */
export function explainAnsweredNothing(error: unknown, bodyBytes: number): unknown {
	if (!(error instanceof ApiTransportError)) return error;
	if (error.bytesSent === 0) {
		return new CommandRefusalError(
			'EXTERNAL_API_FAILED',
			`${error.message}\nNo byte of the request left this machine, so nothing was created and `
			+ 'there is nothing to clean up. Fix the connection and re-run the same command.',
			{ cause: error },
		);
	}
	return new CommandRefusalError(
		'EXTERNAL_API_FAILED',
		`${error.message}\nThe connection closed before the API answered, so this is not a verdict on `
		+ `the upload. VAT had sent ${formatBytes(error.bytesSent)} of a ${formatBytes(bodyBytes)} `
		+ `request body against a ${formatBytes(API_SKILL_MAX_UPLOAD_BYTES)} ceiling; the API has `
		+ 'been observed to drop a connection near that ceiling instead of returning 413. Whether '
		+ 'anything was created is unknown — VAT never replays a POST, because one that failed with '
		+ 'no status may still have taken effect. Check what exists '
		+ '(`vat claude org skills list`, or `vat claude org skills versions list <skill-id>`) '
		+ 'before re-running this command.',
		{ cause: error },
	);
}

/**
 * THE one call that crosses the wire, with both post-hoc explanations applied:
 * the transport annotation (which describes the REQUEST) first, then whichever
 * vendor refusals this endpoint can actually earn.
 *
 * Shared so the two upload endpoints cannot drift on either. Reading the
 * response is deliberately OUTSIDE the try — a response-shape refusal is VAT's
 * own verdict on a completed exchange and must never be dressed up as a
 * transport failure.
 */
async function sendUpload<T>(
	send: () => Promise<T>,
	bodyBytes: number,
	remedy: (error: unknown) => unknown,
): Promise<T> {
	try {
		return await send();
	} catch (error) {
		throw remedy(explainAnsweredNothing(error, bodyBytes));
	}
}

/**
 * Resolve a `<source>` CLI argument to an absolute path.
 *
 * {@link isAbsoluteAnyPlatform} answers for POSIX roots, drive letters and UNC
 * paths on EVERY host, so `D:\builds\skill` is absolute even on POSIX CI.
 */
export function resolveSourceArgument(source: string): string {
	return isAbsoluteAnyPlatform(source)
		? toForwardSlashAnyPlatform(source)
		: safePath.resolve(process.cwd(), source);
}

/**
 * Send multipart files to the Skills API as a NEW skill, and return a normalized
 * result.
 *
 * The body is built through the ceiling gate, so every create — a directory or a
 * ZIP — is weighed as the request it will become before a byte is sent.
 */
/** What {@link inspectZipArchive} can tell a caller about an archive. */
export interface ZipInspection {
	/** The API-enforced quantity: the sum of every entry's declared size. */
	readonly uncompressedBytes: number;
	/** The `name` declared by the SKILL.md nearest the archive root, if any. */
	readonly declaredName: string | undefined;
	/**
	 * Entry names carrying a {@link NEVER_UPLOADED_DIR_NAMES} path segment —
	 * `evals/` above all. The directory lane REFUSES these; this is what lets the
	 * ZIP lane reach the same verdict about the same content.
	 */
	readonly neverUploaded: readonly string[];
	/**
	 * Every markdown member, inflated, shaped as the parts the directory lane
	 * hands {@link warnUnportableReferences} — so the ZIP lane runs the SAME
	 * checks over the same content rather than a second implementation of them.
	 *
	 * Markdown only, and only within {@link MAX_INSPECTED_DOCUMENT_BYTES} an
	 * entry: these detectors read prose, and inflating an archive's binaries to
	 * hand them to a reader that skips them is work spent to produce nothing.
	 */
	readonly documents: readonly MultipartFile[];
	/**
	 * The archive's top-level directory, when it has one — the prefix
	 * {@link bundleRelativeName} strips so a finding is located in the same
	 * namespace a `validation.allow` glob is matched in. `undefined` for an
	 * archive whose SKILL.md sits at the root, which has no prefix to strip.
	 */
	readonly bundleRoot: string | undefined;
	/**
	 * Entries the host that made the archive added beside the skill (`hostAddedToSkillZip`: a
	 * top-level `__MACOSX/`, a `.DS_Store`). Not part of the skill, so not sent ({@link upload}).
	 */
	readonly hostAdded: readonly string[];
	/** The size of the operator's file, in bytes: what the log reports, never what is sent. */
	readonly fileBytes: number;
	/**
	 * The bytes to send: VAT's own ZIP of the entries it judged, {@link hostAdded} left out
	 * (`zipOfArchive`) — never the operator's file, whose local headers may hold entries its
	 * central directory does not list, or a stub before them, that VAT never judged.
	 */
	readonly upload: () => Promise<Buffer>;
	/**
	 * Members this inspection wanted and could not inflate — a bad CRC, a
	 * compression method that is not store/deflate, an encrypted entry — each
	 * with the reader's reason. NAMED, because a document that was not checked
	 * is a promise `install --help` makes that this run did not keep. The
	 * upload then refuses ({@link upload} sends only what VAT read, and it could
	 * not read these), so the list is the operator's explanation, not a waiver.
	 */
	readonly unreadable: readonly ZipEntryFailure[];
}

/** One archive member the reader refused, and why. */
export interface ZipEntryFailure {
	readonly entry: string;
	readonly reason: string;
}

/** An archive the reader could not open at all, and why. */
export interface ZipUnreadable {
	readonly archiveUnreadable: string;
	/** The operator's file, as read: bytes that are no ZIP at all, which the API is the authority on, sent as they are. */
	readonly bytes: Buffer;
}

/**
 * The largest single markdown member this will decompress for the portability
 * checks ({@link ZipInspection.documents}). Never the elected SKILL.md's bound:
 * its name is read under the parse input cap, as on every lane ({@link declaredNameOf}).
 *
 * Not a limit on what may be PUBLISHED — the API's own ceiling decides that, and
 * a bigger document simply goes unchecked rather than refused. It bounds the
 * allocations this module performs on attacker-supplied metadata: reading an
 * entry inflates up to the size its header claims, and a header can claim
 * anything. A megabyte is two orders of magnitude above any real skill document.
 *
 * ⚠️ It is a PER-ENTRY bound. The total is bounded separately, and more
 * tightly: nothing is inflated at all until the archive's declared uncompressed
 * total is known to be within {@link API_SKILL_MAX_UPLOAD_BYTES}.
 */
const MAX_INSPECTED_DOCUMENT_BYTES = 1024 * 1024;

/**
 * What a ZIP will weigh AFTER the API expands it, read from the archive's own
 * central directory — plus the name its inner SKILL.md declares, any answer key
 * it carries, and the markdown members the portability checks read.
 *
 * 🔑 **The API expands a ZIP and applies the ceiling to the UNCOMPRESSED total,
 * not to the archive**, so the body check every other shape passes through is
 * structurally blind here.
 *
 * ⚠️ **The boundary itself is UNMEASURED on this lane**, so this refuses only on
 * `>` — strictly the looser choice. Do not tighten this to `>=`, or quote it as a
 * measured ceiling, without bracketing it the way
 * {@link API_SKILL_MAX_UPLOAD_BYTES} was bracketed.
 *
 * ⛔ Sizes come from entry HEADERS, which an archive can lie about. That is
 * fine: a lie can only change whether VAT refuses early, never whether the API
 * does.
 *
 * ⚠️ **Reading an entry inflates it into memory**, so decompression is ordered
 * after the declared total is known, and each entry is bounded — a document by
 * {@link MAX_INSPECTED_DOCUMENT_BYTES}, the elected SKILL.md by the parse input
 * cap — so an archive declaring a 4 GiB SKILL.md is enumerated and never inflated.
 *
 * 🔑 **The archive is read through the ONE archive primitive, and held to its ONE
 * entry policy.** An archive holding an entry VAT would refuse to extract — a
 * symbolic link, a device, a name outside the archive, two entries that are one
 * name (a name listed twice included) — or one past the archive limits, or one
 * that is not a skill ZIP by the one layout rule (`requireSkillZipLayout`), is
 * refused here (`INPUT_UNREADABLE`), before anything is sent: the same archive is
 * refused by every verb that takes one. Only bytes the reader cannot PARSE as a
 * ZIP at all are let through, announced (see the catch).
 *
 * @throws ArchiveRefusedError (`INPUT_UNREADABLE`) for an archive the entry policy
 *   or the archive limits refuse; FsFaultError side `source` when the OS refuses the read
 */
export async function inspectZipArchive(zipPath: string): Promise<ZipInspection | ZipUnreadable> {
	// Loaded on demand: the archive readers are needed by this one lane of the org commands.
	const { ARCHIVE_LIMITS, archiveEntryRefusal, ArchiveRefusedError: Refused, openArchive, readArchiveFile, zipOfArchive } = await import('@vibe-agent-toolkit/utils/archive');
	// Read ONCE: what is judged below, what is re-zipped and what an unreadable upload sends are these bytes.
	const bytes = await readArchiveFile(zipPath, 'source', ARCHIVE_LIMITS);
	const source = { bytes, label: toForwardSlash(zipPath) };
	let opened: OpenedArchive;
	try {
		opened = await openArchive(source, { format: 'zip', limits: ARCHIVE_LIMITS });
	} catch (error) {
		// Bytes that are no ZIP at all (`unreadable`: no ZIP signature anywhere) are
		// not VAT's to block: the API is the authority on that upload, and the
		// caller is told why, so "checks skipped" is never silent.
		//
		// That is the ONLY reason let through. A ZIP VAT will not take
		// (`unsupported`: ZIP64, an ambiguous end record, a directory two readers
		// would read differently, an end record padded past the 64 KiB a reader
		// searches) stays loud, like an archive past the limits — were it passed
		// on, a 20-byte edit or a 64 KiB append to any refused ZIP would send it
		// with every check skipped. So does one the FILESYSTEM refuses (the path
		// was readable a moment ago — the caller holds its bytes).
		if (isUnparseableArchive(error)) return { archiveUnreadable: error.message, bytes };
		throw error;
	}
	const refusal = archiveEntryRefusal(opened.entries);
	if (refusal !== undefined) throw new Refused(opened.label, refusal);
	// The one layout rule for a skill ZIP, shared with the two install verbs: an archive that is
	// not a skill by it is refused here, never sent for the API to make what it can of.
	const skillRoot = requireSkillZipLayout(opened.label, opened.entries);

	// PASS 1 — headers only. Nothing is decompressed while this runs, so both
	// refusals the caller can reach are decided on metadata alone.
	const hostAdded = opened.entries.map(entry => entry.name).filter(name => hostAddedToSkillZip(name));
	const sent = {
		fileBytes: bytes.length,
		upload: () => zipOfArchive(source, { format: 'zip', limits: ARCHIVE_LIMITS, omit: (entry) => hostAddedToSkillZip(entry.name) }),
	};
	const files = opened.entries.filter(entry => entry.kind === 'file' && !hostAddedToSkillZip(entry.name));
	const uncompressedBytes = files.reduce((sum, entry) => sum + entry.size, 0);
	const neverUploaded = files
		.map(entry => toForwardSlashAnyPlatform(entry.name))
		.filter(name => name.split('/').some(segment => NEVER_UPLOADED_DIR_NAMES.has(segment)));

	// PASS 2 — the entries worth inflating, and only once the total says this
	// archive is not already refused. An over-ceiling archive is about to be
	// rejected by the caller, so inflating anything out of it would be work spent
	// on an upload that cannot happen.
	if (uncompressedBytes > API_SKILL_MAX_UPLOAD_BYTES) {
		return {
			uncompressedBytes, declaredName: undefined, neverUploaded, documents: [], bundleRoot: undefined, hostAdded, unreadable: [], ...sent,
		};
	}
	const elected = skillMdOf(files, skillRoot);
	const unreadable: ZipEntryFailure[] = [];
	return {
		uncompressedBytes,
		declaredName: await declaredNameOf(opened, elected, unreadable),
		neverUploaded,
		documents: inflateMarkdownMembers(opened, files, unreadable),
		bundleRoot: skillRoot === '' ? undefined : skillRoot,
		hostAdded,
		unreadable,
		...sent,
	};
}

/** Whether `error` is the archive module saying the bytes are no ZIP at all — by its code and reason, never its prose. A ZIP it will not take, an entry that does not inflate included, is `unsupported`, and is not this. */
function isUnparseableArchive(error: unknown): error is ArchiveRefusedError {
	return isVatError(error, ARCHIVE_REFUSED_CODE) && (error as ArchiveRefusedError).reason === 'unreadable';
}

/**
 * Every markdown member of the archive, as an upload part.
 *
 * 🔑 The ZIP lane runs the portability family through the ONE function the
 * directory lane uses ({@link warnUnportableReferences}): a second copy of the
 * collector calls is how the two lanes start disagreeing.
 *
 * An entry that will not inflate is SKIPPED here and named: the checks it feeds
 * only ever warn. The upload is what refuses it — VAT sends its own ZIP of what
 * it read, and it could not read this.
 */
function inflateMarkdownMembers(archive: OpenedArchive, files: readonly ArchiveEntry[], unreadable: ZipEntryFailure[]): MultipartFile[] {
	const documents: MultipartFile[] = [];
	for (const entry of files) {
		const filename = toForwardSlashAnyPlatform(entry.name);
		if (!filename.toLowerCase().endsWith('.md')) continue;
		if (entry.size > MAX_INSPECTED_DOCUMENT_BYTES) continue;
		const content = inflateOrRecord(archive, entry, unreadable);
		if (content !== undefined) documents.push({ fieldName: 'files[]', filename, content });
	}
	return documents;
}

/**
 * One member's bytes, or `undefined` with the refusal RECORDED.
 *
 * Reading an entry is the only decompression in this module, so it is the only
 * thing that can throw here: the archive module refuses an entry with a bad CRC,
 * a compression method that is not store/deflate, an encrypted entry, or one
 * that does not hold what it declares (`ArchiveEntryReadError`, `ARCHIVE_ENTRY_UNREADABLE`).
 * The inspection skips the member AND names it, so every finding the other
 * members earn is still reported; the archive is not thereby accepted — the
 * upload re-reads every entry for VAT's own ZIP and refuses this one, so nothing
 * is sent.
 */
function inflateOrRecord(archive: OpenedArchive, entry: ArchiveEntry, unreadable: ZipEntryFailure[]): Buffer | undefined {
	try {
		return archive.read(entry);
	} catch (error) {
		if (!isArchiveEntryReadRefusal(error)) throw error;
		// Once per member: the elected SKILL.md is asked for twice (its name, then
		// its text), and one refusal is one fact.
		const name = toForwardSlashAnyPlatform(entry.name);
		if (!unreadable.some((failure) => failure.entry === name)) {
			unreadable.push({ entry: name, reason: error.message });
		}
		return undefined;
	}
}

/**
 * The archive's own SKILL.md: the one at the place the layout rule found the skill
 * (`requireSkillZipLayout`), which is the one whose `name` the API keys the skill by.
 * Never a `SKILL.md` deeper in the bundle — a fixture a skill ships is not the skill.
 *
 * @param files - The archive's file entries
 * @param root - Where the skill is: `''` for the archive's top level, or its one top-level folder
 */
function skillMdOf(files: readonly ArchiveEntry[], root: string): ArchiveEntry | undefined {
	const place = root === '' ? 'SKILL.md' : `${root}/SKILL.md`;
	return files.find(entry => archiveEntryPlace(entry.name).join('/') === place);
}

/**
 * The frontmatter `name` inside the ELECTED entry — or `undefined`, including
 * when that entry declares none.
 *
 * 🪤 The election decides; whatever the elected file holds is the answer,
 * absence included — never a deeper candidate's name.
 *
 * An elected SKILL.md that will not inflate costs only the name (the size total
 * is already computed from headers) — see {@link inflateOrRecord}, which records
 * the refusal so the operator learns why no name was read.
 *
 * It is held to the parse input cap by its declared size BEFORE it is inflated —
 * the refusal `readContentForParse` makes of a SKILL.md on disk, so the same
 * document is the same `ParseLimitError` on either lane, never "declares no
 * name" here and refused there. The inflation this permits is bounded twice: by
 * the cap, and by the archive's declared total, gated against
 * {@link API_SKILL_MAX_UPLOAD_BYTES} before anything is inflated. A header that
 * lies about the size is refused by the read, which checks what it inflated.
 */
function declaredNameOf(archive: OpenedArchive, entry: ArchiveEntry | undefined, unreadable: ZipEntryFailure[]): Promise<string | undefined> {
	if (entry === undefined) return Promise.resolve(undefined);
	const skillMdPath = toForwardSlashAnyPlatform(entry.name);
	return withParseDispatcher((dispatcher) => {
		const read = (): Promise<string | undefined> => {
			const tooLarge = parseInputRefusal(entry.size, { dispatcher });
			if (tooLarge !== undefined) return Promise.reject(tooLarge);
			const bytes = inflateOrRecord(archive, entry, unreadable);
			// Decoded as the disk lane decodes (a BOM, UTF-16 included), and measured in the entry's
			// own bytes, the unit its declared size was held to.
			return bytes === undefined
				? Promise.resolve(undefined)
				: declaredSkillNameIn({ content: decodeTextContent(bytes).text, byteLength: bytes.length }, { dispatcher });
		};
		// A parse refused for this run is the run's refusal, never "declares no name".
		return declaredNameOrRefuse(skillMdPath, read(), '');
	});
}

async function sendSkillUpload(
	client: OrgApiClient,
	displayTitle: string,
	files: MultipartFile[],
	bundleRoot?: string,
): Promise<SkillUploadResult> {
	const multipart = buildUploadBodyOrRefuse({ display_title: displayTitle }, files, bundleRoot);
	return readCreateSkillResponse(await sendUpload(
		() => client.uploadSkill<unknown>(multipart),
		multipart.body.length,
		withDuplicateTitleRemedy,
	));
}

/**
 * The name a SKILL.md declares, which is both the uploaded skill's display
 * title and the top-level directory the API keys it by.
 */
async function requireDeclaredName(skillMdPath: string): Promise<string> {
	const declared = await declaredNameOrRefuse(skillMdPath, readDeclaredSkillName(skillMdPath, { dispatcher: undefined }), safePath.join(skillMdPath, '..', '..'));
	if (declared === undefined) {
		throw new CommandRefusalError(
			'USAGE_INVALID',
			`SKILL.md has no usable frontmatter "name" field: ${skillMdPath}`,
		);
	}
	return declared;
}

/*
 * ── Why NEVER_UPLOADED_DIR_NAMES is imported and not declared here ─────
 *
 * (A plain block comment, not a doc comment: it belongs to the imported
 * symbol, and a `/**` here would attach itself to the next declaration.)
 *
 * `evals/` is the conventional home of a skill's eval suite — its answer key.
 * A correctly built skill directory (what this command documents as its input)
 * never contains one, because the packager excludes declared test input; this
 * is the backstop for the easy mistake of pointing the uploader at the *source*
 * tree instead, where the suite does live. The invariant is "a published skill
 * carries no answer key", not "…none when the operator remembered to build".
 *
 * The name match alone cannot uphold that invariant, because the suite's
 * location is the ADOPTER's to declare (`skills.config.<name>.test.evals`;
 * `evals/evals.json` is only the default). It stays as the unconditional
 * fail-safe for the case where no config is discoverable at all — a fetched
 * artifact, an extracted tarball, a tree outside any VAT project — where there
 * is no declaration to read and the convention is the only thing left to honor.
 * The declared location is resolved separately, in `declaredTestInputPaths`,
 * and the two are unioned.
 *
 * This lane is deliberately BROADER than the packager, which excludes exactly
 * `<skill-root>/evals` and never guesses from a name (see test-input.ts). Here
 * a mistaken input is the entire scenario and the blast radius is an org-wide
 * publish, so over-withholding a directory literally named `evals` is the cheap
 * error and it is reported rather than silent.
 *
 * `node_modules`/`.git` are development detritus that has no meaning inside a
 * published skill and would silently bloat the multipart payload.
 *
 * The set itself belongs to the build-time size check, which must weigh exactly
 * the file set this sends — it was a matching literal in both places, agreeing
 * only by coincidence, and either could have been edited alone.
 */

interface CollectedUploadFiles {
	files: Array<{ relativePath: string; absolutePath: string }>;
	/**
	 * Relative paths of everything deliberately withheld — a directory, or the
	 * single file of a suite declared at the skill root — so the skip is never
	 * silent. Under-reporting here is worse than the leak itself: it would
	 * affirmatively tell the operator nothing was held back.
	 */
	excluded: string[];
}

/**
 * The absolute path of this skill's DECLARED eval suite, when its governing VAT
 * config declares one, as a set of paths to withhold.
 *
 * Resolution is anchored on the DIRECTORY ARGUMENT, not on a governing config
 * being present: `resolveSkillPackagingConfig` walks up from the given skill dir
 * to its nearest-ancestor `vibe-agent-toolkit.config.yaml` — the same walk-up
 * `vat audit`, `vat skill review`, and skill-reference resolution use — and
 * returns `null` when there is none or the skill is not declared there. That is
 * exactly what this backstop needs: the scenario it exists for is an operator
 * pointing at a source tree by mistake, and a source tree sits inside its own
 * project, so the declaration is right there to be read. Requiring a governing
 * config instead would refuse to protect the fetched-artifact case at all, and
 * `null` here is not a failure — it falls through to the name-based fail-safe.
 *
 * `evalSuiteUnitPath` is the shared definition of the suite UNIT (the directory
 * holding `evals.json` and its `fixtures/`, or the single file for a suite at
 * the skill root) and yields `undefined` for a suite that lives outside the
 * skill dir — nothing inside the tree to withhold.
 */
async function declaredTestInputPaths(skillDir: string): Promise<ReadonlySet<string>> {
	// `'refuse'`: an upload that cannot tell which paths are test input might
	// publish an answer key. The throw is reported per skill by the install
	// loop's catch (logged, and counted in its failures) — never swallowed.
	const config = await resolveSkillPackagingConfig(safePath.join(skillDir, 'SKILL.md'), 'refuse');
	const declared = config?.test?.evals;
	if (declared === undefined) return new Set();
	const unit = evalSuiteUnitPath(safePath.resolve(skillDir), declared);
	return unit === undefined ? new Set() : new Set([unit]);
}

/**
 * Whether a directory entry is a symbolic link resolving to a DIRECTORY —
 * throwing, naming the path, when the link cannot be followed at all.
 *
 * `Dirent.isDirectory()` is lstat-based, so it answers `false` for a link to a
 * directory. `requireFollowedStatSync` follows the link (its chain read first),
 * the same way the build-time size walk classifies one.
 */
function resolvesToDirectory(entry: Dirent, fullPath: string, relativePath: string, within: string): boolean {
	if (!entry.isSymbolicLink()) return false;
	try {
		// The chain is read beneath the skill directory first: a link to a network path is refused
		// here, by name, before the kernel is asked to follow it.
		return requireFollowedStatSync(fullPath, within).isDirectory();
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new CommandRefusalError(
			'INPUT_UNREADABLE',
			`Cannot upload ${relativePath}: it is a symbolic link whose target could not be read `
			+ `(${cause}). Replace it with the file or directory it should point at, or remove it.`,
		);
	}
}

/**
 * Collect the files under a skill directory that should be uploaded,
 * recursively, returning relative paths alongside what was deliberately left
 * out.
 *
 * 🚨 **A symlink is REFUSED, whatever it resolves to.** A multipart body has no
 * way to express a link: skipping it silently changes what is published, and
 * FOLLOWING it is data egress (`notes.md -> /etc/passwd` would post the target's
 * bytes into a workspace every org member can read). The vector is a directory
 * extracted with system `tar`, or cloned from an untrusted repo.
 *
 * Refusing and naming the path is the only answer that is both complete and
 * honest, and it keeps this lane on the same payload as the build-time size
 * walk, which does not weigh a linked entry either.
 *
 * The never-uploaded NAMES are matched on a linked directory too. Those are
 * never published whatever their type, and the size walk weighs a linked
 * directory as zero bytes either way — so excluding one keeps both lanes on the
 * same payload instead of blocking a publish over a directory neither lane
 * would have sent.
 */
function collectFiles(
	dir: string,
	base: string,
	testInput: ReadonlySet<string>,
	collected: CollectedUploadFiles,
): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = safePath.join(dir, entry.name);
		const relativePath = safePath.relative(base, fullPath);
		const linkedDirectory = resolvesToDirectory(entry, fullPath, relativePath, base);
		const directoryLike = entry.isDirectory() || linkedDirectory;

		if (
			testInput.has(safePath.resolve(fullPath))
			|| (directoryLike && NEVER_UPLOADED_DIR_NAMES.has(entry.name))
		) {
			collected.excluded.push(relativePath);
			continue;
		}

		if (entry.isDirectory()) {
			collectFiles(fullPath, base, testInput, collected);
		} else if (entry.isSymbolicLink()) {
			// Whatever it points at — see this function's doc comment.
			throw new CommandRefusalError(
				'INPUT_UNREADABLE',
				`Cannot upload ${relativePath}: it is a symbolic link${linkedDirectory ? ' to a directory' : ''}, `
				+ 'which a multipart upload cannot express. VAT will not publish the bytes it points '
				+ 'at under this name: a link out of the skill directory would send whatever the '
				+ 'target holds into a workspace every org member can read. Replace it with a real '
				+ 'copy of the file or directory it points at, or remove it.',
			);
		} else {
			collected.files.push({ relativePath, absolutePath: fullPath });
		}
	}
}

/**
 * Collect the upload payload for a skill directory. Exported for testing.
 *
 * Resolves the declared test-input paths itself rather than accepting them, so
 * no caller can obtain an upload set with the exclusion skipped.
 */
export async function collectSkillUploadFiles(skillDir: string): Promise<CollectedUploadFiles> {
	const collected: CollectedUploadFiles = { files: [], excluded: [] };
	collectFiles(skillDir, skillDir, await declaredTestInputPaths(skillDir), collected);
	return collected;
}

/** A skill directory packaged for upload, before any decision about where to send it. */
interface PreparedUpload {
	readonly displayTitle: string;
	readonly files: MultipartFile[];
	/**
	 * The top-level directory every uploaded filename is prefixed with — the
	 * SOURCE tree's declared name, which is how the API keys the files.
	 */
	readonly dirName: string;
}

/**
 * Stat a path the operator named, refusing through the one absent-vs-unreadable
 * predicate: absent is the invocation's mistake (`USAGE_INVALID`, with this
 * site's own sentence); anything else — an `EACCES` parent, an `ELOOP` — means
 * whether it exists is unknown, the INPUT's refusal (`INPUT_UNREADABLE`).
 * Never `existsSync`: it answers `false` for both.
 */
function statNamedPath(path: string, within: string, absentMessage: string): Stats {
	// Every path from the operator's named tree down to it is the operator's input.
	return requireInputPath(path, within, { origin: 'argument', message: absentMessage }, everywhere('source'));
}

/**
 * Package a skill directory into the multipart file set the API takes.
 *
 * Deliberately separate from SENDING it. Creating a skill and adding a version to
 * one differ only in the endpoint; the bundle, the exclusions and the size ceiling
 * are identical, and a skill that packages one way when created and another way
 * when updated would be the bug this split exists to prevent. Which endpoint gets
 * the bundle is the caller's command, never something inferred from the workspace.
 */
async function prepareSkillUpload(
	skillDir: string,
	titleOverride: string | undefined,
	logger: UploadLogger,
): Promise<PreparedUpload> {
	const skillMdPath = safePath.join(skillDir, 'SKILL.md');
	statNamedPath(skillMdPath, skillDir, `SKILL.md not found in ${skillDir}. Is this a built skill directory?`);

	// The skill's own declared name — not the directory it happens to sit in,
	// which for a built or extracted tree carries no reliable identity.
	const declaredName = await requireDeclaredName(skillMdPath);
	const displayTitle = titleOverride ?? declaredName;

	// API requires files inside a top-level directory (e.g. skill_name/SKILL.md)
	const dirName = declaredName;
	const collected = await collectSkillUploadFiles(skillDir);
	const files: MultipartFile[] = [];

	for (const file of collected.files) {
		const content = readFileSync(file.absolutePath);
		files.push({
			fieldName: 'files[]',
			filename: `${dirName}/${file.relativePath}`,
			content,
		});
	}

	// FILE BYTES of the bundle actually sent, and says so: the ceiling is enforced
	// on the multipart body, which is larger.
	const contentBytes = files.reduce((sum, f) => sum + f.content.length, 0);

	logger.info(
		`   ${dirName}: ${files.length} ${files.length === 1 ? 'file' : 'files'}, `
		+ `${formatBytes(contentBytes)} of file content, title="${displayTitle}"`,
	);
	for (const excluded of collected.excluded) {
		logger.info(`   Excluded from upload: ${excluded} (never published with a skill)`);
	}
	// The SAME cached merge `declaredTestInputPaths` read, so asking twice costs
	// one map lookup. Resolved HERE rather than plumbed out of the exported
	// `collectSkillUploadFiles`, which resolves its own so no caller can hand it
	// a config with the exclusion skipped.
	const packaging = await resolveSkillPackagingConfig(skillMdPath, 'refuse');
	warnUnportableReferences(files, dirName, packaging?.validation, logger);

	return { displayTitle, files, dirName };
}

/**
 * Warn about references in the bundle that cannot resolve once it is published.
 *
 * 🚨 **This is the one lane in a position to check content before it leaves the
 * machine.** Under the Skills API each skill is its own top-level tree with no
 * siblings, so a reference outside it uploads green and cannot run.
 *
 * ⚠️ **Warns, never refuses.** These are `warning`-severity codes and the
 * operator may have reasons VAT cannot see; turning a publish into an exit 2 on
 * a heuristic is a worse failure than the one being reported. Blocking belongs
 * to `vat skills build` and `vat audit`, which run before this and can gate CI.
 *
 * Costs nothing extra: it reads the buffers already collected for the upload, so
 * no file is opened twice and nothing is walked again.
 *
 * 🚨 **The three collectors are RAW issue producers**, so they pass through
 * {@link runValidationFramework} here as everywhere else: an author who waived a
 * finding with `validation.allow` must not see it again on every publish.
 *
 * ⚠️ The `location` is the BUNDLE-relative path, not the API-keyed
 * `<declared-name>/<path>` spelling. An allow glob matches `ValidationIssue.location`,
 * which is contractually project/bundle-relative, so the keyed spelling could not
 * have matched an entry even once allows were applied — the same divergence
 * {@link bundleRelativeName} exists to strip out of the oversize message.
 *
 * ⛔ The run-level ALLOW_UNUSED sweep is deliberately NOT drained here. This lane
 * runs three validator families out of the whole registry, so every allow entry
 * for any other code would be reported as dead — advising the author to delete
 * the entry that makes their build green.
 */
export function warnUnportableReferences(
	files: readonly MultipartFile[],
	bundleRoot: string | undefined,
	validation: ValidationConfig | undefined,
	logger: UploadLogger,
): void {
	const rawIssues: ValidationIssue[] = [];
	for (const file of files) {
		// Skill DOCUMENTS only. These detectors read prose and code spans; running
		// them over a `.png` or a bundled `.mjs` would report on bytes no agent
		// reads as instructions.
		if (!file.filename.toLowerCase().endsWith('.md')) continue;
		const location = bundleRelativeName(file.filename, bundleRoot);
		const content = file.content.toString('utf8');
		collectNonPortableAssetReferenceIssues(content, location, rawIssues);
		collectNonPortableCommandIssues(content, location, rawIssues);
		collectUnqualifiedMcpToolIssues(content, location, rawIssues);
	}
	const { emitted: issues } = runValidationFramework(
		rawIssues,
		validation ?? {},
		createAllowUsageLedger(),
	);
	if (issues.length === 0) return;
	logger.warn(
		`   ${issues.length} portability ${issues.length === 1 ? 'warning' : 'warnings'} in this bundle `
		+ '(uploading anyway; run `vat audit <dir>` for the full report):',
	);
	for (const line of issues.flatMap((issue) => formatIssueLines(issue, '     '))) logger.warn(line);
}

/**
 * Upload a skill directory as a NEW skill.
 *
 * Always creates. It does not look for an existing skill of the same title and
 * quietly switch to adding a version: `display_title` is not unique in a workspace
 * (the API enforces it only when the field is sent explicitly, and derives a title
 * from frontmatter otherwise), so such a lookup returns 0, 1 or N matches and the
 * command's effect would depend on which. Updating an existing skill is
 * `skills versions add`, which takes the id outright.
 */
async function uploadSkillDir(
	client: OrgApiClient,
	skillDir: string,
	titleOverride: string | undefined,
	logger: UploadLogger,
): Promise<SkillUploadResult> {
	const { displayTitle, files, dirName } = await prepareSkillUpload(skillDir, titleOverride, logger);
	return sendSkillUpload(client, displayTitle, files, dirName);
}

/**
 * Upload a skill directory as a new VERSION of an existing skill.
 *
 * The server assigns the version identifier and promotes it to `latest_version`;
 * nothing here numbers a version.
 *
 * ⚠️ The uploaded files are keyed under the SOURCE tree's declared name, which
 * this command cannot check against the roots earlier versions used: reading
 * them back would mean a second endpoint whose response shape has not been
 * measured. So the root is REPORTED rather than checked here, and the log line
 * below is what lets an operator see which root their files landed under.
 *
 * ⛔ A changed name does NOT silently re-root the version: the SERVER enforces
 * SKILL.md name consistency per `skill_id`, so a renamed tree earns a loud 400,
 * which gets a remedy ({@link VERSION_NAME_MISMATCH_REFUSAL}).
 */
async function uploadSkillVersionDir(
	client: OrgApiClient,
	skillId: string,
	skillDir: string,
	logger: UploadLogger,
): Promise<SkillUploadResult> {
	const { files, dirName } = await prepareSkillUpload(skillDir, undefined, logger);
	logger.info(
		`   Files are keyed under "${dirName}/", taken from this tree's SKILL.md name. `
		+ 'The API refuses a version whose name differs from the one this skill already has.',
	);
	// No `display_title` field: this version belongs to a skill that already has a
	// title, and sending one here would be an attempt to rename by side effect.
	// Its absence also changes the body's length, which is why the ceiling is
	// weighed on the body this endpoint sends rather than on the one `install` builds.
	const multipart = buildUploadBodyOrRefuse({}, files, dirName);
	// The duplicate-title 400 is unreachable here; the NAME refusal is not.
	return readSkillVersionResponse(await sendUpload(
		() => client.uploadSkillVersion<unknown>(skillId, multipart),
		multipart.body.length,
		withVersionRootRemedy,
	));
}

/**
 * List candidate package directories in node_modules (scoped + unscoped).
 *
 * Exported for testing: this and {@link findSkillsDir} decide WHICH tree
 * `--from-npm` publishes to an org.
 */
export function listNodeModulePackages(nodeModulesDir: string, within: string): string[] {
	if (!pathPresent(nodeModulesDir, { follow: within }, everywhere('source'), 'probe')) return [];

	const results: string[] = [];
	// Followed: a workspace package under node_modules IS a symlink.
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (direntKindFollowingSync(nodeModulesDir, entry, within) !== 'directory') continue;
		if (entry.name.startsWith('@')) {
			const scopeDir = safePath.join(nodeModulesDir, entry.name);
			for (const scopedEntry of readdirSync(scopeDir, { withFileTypes: true })) {
				if (direntKindFollowingSync(scopeDir, scopedEntry, within) === 'directory') results.push(safePath.join(scopeDir, scopedEntry.name));
			}
		} else {
			results.push(safePath.join(nodeModulesDir, entry.name));
		}
	}
	return results;
}

/**
 * Find the dist/skills/ directory in a package. Checks the package itself
 * first, then scans node_modules for sub-packages that contain built skills.
 */
export function findSkillsDir(packageDir: string): string | undefined {
	// Every probe is beneath the package directory: its links are read before the kernel follows them,
	// and a probe the OS refuses is the package's source fault, never "no skills here".
	const present = (path: string): boolean => pathPresent(path, { follow: packageDir }, everywhere('source'), 'probe');
	const direct = safePath.join(packageDir, 'dist', 'skills');
	if (present(direct)) return direct;

	const candidates = listNodeModulePackages(safePath.join(packageDir, 'node_modules'), packageDir);
	for (const pkgDir of candidates) {
		const candidate = safePath.join(pkgDir, 'dist', 'skills');
		if (present(candidate)) return candidate;
	}

	return undefined;
}

/**
 * One skill the batch could not publish, and why — in the same `{ code, message }`
 * shape the run's own refusal publishes, so one payload carries one error shape.
 */
export interface SkillUploadFailure {
	readonly skill: string;
	readonly error: { readonly code: RefusalCode; readonly message: string };
}

/**
 * The failure row for one skill, coded by the thrown value exactly as a run-level
 * refusal would be. Exported for testing.
 */
export function skillUploadFailure(skill: string, error: unknown): SkillUploadFailure {
	return { skill, error: { code: refusalCodeOf(error), message: errorMessageOf(error) } };
}

/** The document `install --from-npm` publishes. */
export interface NpmInstallSummary {
	source: string;
	skillsUploaded: number;
	skillsFailed?: number;
	errors?: readonly SkillUploadFailure[];
	skills: readonly SkillUploadResult[];
	/**
	 * The downloaded package's temp directory, when the OS would not remove it once the
	 * uploads were done: one `TREE_CLEANUP_INCOMPLETE` warning naming it. The uploads stand.
	 */
	warnings?: readonly ValidationIssue[];
}

/**
 * The batch's report, tagged as a failure when ANY skill did not publish.
 *
 * 🔑 Partial success is a failure: a mixed workspace state nobody asked for is
 * exactly the case a human has to look at, so `… || fail` must not report green.
 * What did land stays in the document, so the reader can see how far it got.
 */
export function summarizeNpmInstall(
	source: string,
	results: readonly SkillUploadResult[],
	errors: readonly SkillUploadFailure[],
	leftover: unknown,
): NpmInstallSummary | OrgCommandFailure {
	const summary: NpmInstallSummary = {
		source,
		skillsUploaded: results.length,
		...(errors.length > 0 ? { skillsFailed: errors.length, errors } : {}),
		skills: results,
		...(leftover === undefined ? {} : { warnings: [leftoverIssueOf(leftover)] }),
	};
	if (errors.length === 0) return summary;
	// Some landed: the workspace is in a mixed state (`partial`). None did: `failed`.
	return orgCommandFailure(summary, results.length > 0
		? { kind: 'partial', failed: errors.length }
		: { kind: 'failed', cause: `no skill from ${source} uploaded` });
}

/**
 * Upload skills from an npm package. Exported for testing.
 */
export async function installFromNpm(
	npmPackage: string,
	skillFilter: string | undefined,
	client: OrgApiClient,
	logger: UploadLogger,
): Promise<object> {
	// The download lives in a temp dir disposed of however the upload ends. One the OS will not
	// remove after the uploads is reported beside them, never in their place: they landed.
	const { value, leftover } = await withTempDir('vat-org-skills-', async (tempDir) => {
		logger.info(`Downloading: ${npmPackage}`);
		const packageDir = await downloadNpmPackage(npmPackage, tempDir);

		const skillsDir = findSkillsDir(packageDir);
		if (!skillsDir) {
			throw new CommandRefusalError('USAGE_INVALID', `No dist/skills/ directory found in ${npmPackage}. Was the package built with vat skills build?`);
		}
		logger.info(`Found skills at: ${safePath.relative(packageDir, skillsDir) || 'dist/skills/'}`);

		// Followed: a built skill directory that is a link is still a skill to upload.
		const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
			.filter(e => direntKindFollowingSync(skillsDir, e, packageDir) === 'directory')
			.map(e => e.name);

		if (skillDirs.length === 0) {
			throw new CommandRefusalError('USAGE_INVALID', `No skills found in dist/skills/ of ${npmPackage}`);
		}

		const toUpload = skillFilter
			? skillDirs.filter(name => name === skillFilter)
			: skillDirs;

		if (toUpload.length === 0) {
			throw new CommandRefusalError('USAGE_INVALID', `Skill "${String(skillFilter)}" not found in ${npmPackage}. Available: ${skillDirs.join(', ')}`);
		}

		logger.info(`Found ${toUpload.length} skill(s) to upload from ${npmPackage}`);

		const results: SkillUploadResult[] = [];
		const errors: SkillUploadFailure[] = [];

		// In order: one rate-limited API, and the result and failure lists follow `toUpload`.
		await forEachInOrder(toUpload, async (skillName) => {
			const skillDir = safePath.join(skillsDir, skillName);
			try {
				const result = await uploadSkillDir(client, skillDir, undefined, logger);
				results.push(result);
			} catch (error) {
				const failure = skillUploadFailure(skillName, error);
				logger.info(`   ⚠ ${skillName}: ${failure.error.message}`);
				errors.push(failure);
			}
		});

		return { results, errors };
	});
	return summarizeNpmInstall(npmPackage, value.results, value.errors, leftover);
}

/**
 * Upload a local skill directory or ZIP file. Exported for testing.
 */
export async function installFromLocal(
	source: string,
	titleOverride: string | undefined,
	client: OrgApiClient,
	logger: UploadLogger,
): Promise<object> {
	const sourcePath = resolveSourceArgument(source);

	// The operator's own argument: its own `within`.
	const stat = statNamedPath(sourcePath, sourcePath, `Source not found: ${sourcePath}`);

	// Case-INSENSITIVE: `MySkill.ZIP` is a zip archive on Windows and macOS.
	if (!stat.isDirectory() && sourcePath.toLowerCase().endsWith('.zip')) {
		return await installZipArchive(sourcePath, titleOverride, client, logger);
	}

	if (!stat.isDirectory()) {
		throw new CommandRefusalError('USAGE_INVALID', `Source must be a directory or .zip file: ${sourcePath}`);
	}

	// "Packaging", not "Uploading": what follows happens locally and can refuse
	// locally. Naming the source before the work makes a failure attributable.
	logger.info(`Packaging skill directory: ${sourcePath}`);
	return await uploadSkillDir(client, sourcePath, titleOverride, logger);
}

/**
 * Publish a ZIP archive as a NEW skill.
 */
async function installZipArchive(
	sourcePath: string,
	titleOverride: string | undefined,
	client: OrgApiClient,
	logger: UploadLogger,
): Promise<object> {
	// `basename(path, ext)` matches the extension exactly, so the literal '.zip'
	// leaves `.ZIP` on the title. Slice the length instead.
	const displayTitle = titleOverride ?? basename(sourcePath).slice(0, -'.zip'.length);
	// The ONE read of the file: everything below is decided on, and sent from, what this read.
	const inspected = await inspectZipArchive(sourcePath);
	const fileBytes = 'archiveUnreadable' in inspected ? inspected.bytes.length : inspected.fileBytes;
	// Reports the file's own bytes; the ceiling is gated in `sendSkillUpload` on
	// the multipart body. "Preparing", not "Uploading": nothing has been sent yet.
	logger.info(`Preparing ZIP: ${sourcePath} (${formatBytes(fileBytes)} of file content)`);
	// Where the title came FROM: a ZIP's title is its filename, while a directory
	// takes SKILL.md's name, so the inspection reports any divergence below.
	logger.info(`Display title: "${displayTitle}" (${titleOverride === undefined
		? 'from the ZIP filename — NOT from the SKILL.md inside it; pass --title to set it'
		: 'from --title'})`);

	let content: Buffer;
	if ('archiveUnreadable' in inspected) {
		// Degrade, and SAY so. Every check below is skipped, and a skipped check
		// that is not announced is indistinguishable from one that passed.
		logger.warn(
			`Could not read the archive (${inspected.archiveUnreadable}); the answer-key, expanded-size, `
			+ `name and portability checks were not run on it. The API decides the upload.`,
		);
		content = inspected.bytes;
	} else {
		refuseOrWarnOnArchive(inspected, displayTitle, fileBytes, logger);
		if (inspected.hostAdded.length > 0) {
			logger.info(`Left out of the upload (added by the host that made the archive, not part of the skill): ${inspected.hostAdded.join(', ')}`);
		}
		// What is sent is what was judged: VAT's own ZIP of the entries it read, never the operator's bytes.
		content = await inspected.upload();
	}

	return sendSkillUpload(client, displayTitle, [{ fieldName: 'files[]', filename: basename(sourcePath), content }]);
}

/**
 * The archive lane's own decisions, over what {@link inspectZipArchive} read:
 * two refusals (answer key, expanded size), and the warnings the inspection
 * earns (title/name divergence, portability, members it could not inflate).
 */
function refuseOrWarnOnArchive(
	inspected: ZipInspection,
	displayTitle: string,
	wireBytes: number,
	logger: UploadLogger,
): void {
	// 🚨 REFUSED, not warned: two lanes of one command must not disagree about
	// whether a skill's answer key may be published. This lane sees only the
	// CONVENTIONAL names — no skill directory to walk up from to a config.
	if (inspected.neverUploaded.length > 0) {
		throw new CommandRefusalError(
			'USAGE_INVALID',
			`This ZIP contains ${String(inspected.neverUploaded.length)} entr`
			+ `${inspected.neverUploaded.length === 1 ? 'y' : 'ies'} that are never published with a `
			+ `skill: ${inspected.neverUploaded.slice(0, 10).join(', ')}`
			+ `${inspected.neverUploaded.length > 10 ? ', …' : ''}. An eval suite is the skill's ANSWER `
			+ `KEY and this would publish it to everyone in the organization. Rebuild the archive from `
			+ `the BUILT skill directory (\`vat skills build\`), or upload that directory directly — `
			+ `\`install <dir>\` withholds these and reports each one.`,
		);
	}
	if (inspected.uncompressedBytes > API_SKILL_MAX_UPLOAD_BYTES) {
		throw new CommandRefusalError(
			'USAGE_INVALID',
			`ZIP expands to ${formatBytes(inspected.uncompressedBytes)}, over the `
			+ `${formatBytes(API_SKILL_MAX_UPLOAD_BYTES)} ceiling. The API expands the archive and `
			+ `weighs the UNCOMPRESSED total, so ${formatBytes(wireBytes)} on the wire does not `
			+ `get this under the limit — it will refuse with "Zip file uncompressed size exceeds 30MB". `
			+ `Remove files from the bundle; compressing harder cannot help.`,
		);
	}
	// The title/name divergence, stated as a FACT: it makes a title-keyed lookup
	// unsafe, so it is named at the moment it is minted.
	if (inspected.declaredName !== undefined && inspected.declaredName !== displayTitle) {
		logger.warn(
			`Title/name divergence: this uploads with display title "${displayTitle}", but the `
			+ `SKILL.md inside declares name "${inspected.declaredName}". Every version will carry `
			+ `the declared name. Pass --title "${inspected.declaredName}" to make them agree.`,
		);
	}
	// 🚨 The SAME function the directory lane calls, over the archive's markdown.
	//
	// ⚠️ NO validation config (stated in the help text): an archive member has no
	// path on disk to walk up from to its governing project, so a waiver that
	// silences `vat skills build` does NOT silence this lane. The checks only warn.
	warnUnportableReferences(inspected.documents, inspected.bundleRoot, undefined, logger);
	if (inspected.unreadable.length > 0) {
		const named = inspected.unreadable.map(({ entry, reason }) => `${entry} (${reason})`).join(', ');
		logger.warn(
			`${String(inspected.unreadable.length)} archive member(s) could not be inflated: ${named}. `
			+ 'They were not checked, and the upload will refuse the archive when it re-reads them — nothing is sent.',
		);
	}
}

/** One version the sweep could not delete, and the reason it gave. */
export interface VersionDeleteFailure {
	readonly version: string;
	readonly reason: string;
}

/** What a `--all` sweep did to the versions it was handed. */
export interface VersionSweep {
	/** Versions this run destroyed. Irreversible, and the record of it. */
	readonly deleted: readonly string[];
	/** Versions still there, each with why. Empty means the sweep is complete. */
	readonly failures: readonly VersionDeleteFailure[];
}

/**
 * Delete every version handed in, and keep going when one refuses.
 *
 * 🚨 **One refusal is a fact about ONE version.** Deleting a skill requires
 * deleting every version first, so the operator needs every version's state.
 *
 * The sweep therefore ATTEMPTS all of them and reports both lists. The caller
 * decides what the outcome means: some deleted plus some failed is a `partial`
 * write that publishes the record; nothing deleted at all is a refusal with no
 * record worth publishing. Both end on 2.
 *
 * ⛔ It deliberately does NOT stop early on a repeated failure. A "the API is
 * clearly down, give up" heuristic is how the abandoned-versions defect reads
 * from inside: the whole value here is that every version's state is KNOWN when
 * the command ends.
 */
export async function deleteEveryVersion(
	client: Pick<OrgApiClient, 'deleteSkillVersion'>,
	skillId: string,
	versions: readonly string[],
	logger: UploadLogger,
): Promise<VersionSweep> {
	const deleted: string[] = [];
	const failures: VersionDeleteFailure[] = [];
	// In order: one rate-limited API, and both lists follow the order versions were handed in.
	await forEachInOrder(versions, async (version) => {
		try {
			await client.deleteSkillVersion(skillId, version);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({ version, reason });
			logger.info(`   ⚠ version ${version} was not deleted: ${reason}`);
			return;
		}
		deleted.push(version);
		logger.info(`   Deleted version ${version}`);
	});
	return { deleted, failures };
}

/**
 * Every version the sweep could not delete, and why — the one sentence both the
 * published report and the refusal's throw are built from, so the two endings never
 * describe the same run differently.
 */
export function describeVersionSweepFailures(failures: readonly VersionDeleteFailure[]): string {
	return failures.map(failure => `${failure.version}: ${failure.reason}`).join('; ');
}

/** What {@link reportHalfDeleted} needs to describe a run that destroyed some of what it was asked to. */
export interface HalfDeletedReport {
	readonly skillId: string;
	readonly deletedVersions: readonly string[];
	/** Versions still present. Empty when the sweep completed and the SKILL delete is what failed. */
	readonly failedVersions: readonly string[];
	/** Why the run stopped. Not `error`: on this verb `error` is the refusal's `{ code, message }`. */
	readonly reason: string;
}

/**
 * The document a `--all` run publishes when it destroyed something and then did
 * not finish.
 *
 * 🔑 The deleted list is a RECORD, not a progress counter: deletion is
 * irreversible, and throwing here would DISCARD the document. So the lists
 * travel with the failure as a `partial` outcome, ending on 2; `failedVersions`
 * is what a re-run still has to deal with.
 */
export function reportHalfDeleted(report: HalfDeletedReport): OrgCommandFailure {
	const { skillId, deletedVersions, failedVersions } = report;
	// Some writes landed (the deleted versions) and some did not: every version
	// still there, plus the skill itself, which is never deleted on this path.
	const outcome: OrgFailureOutcome = { kind: 'partial', failed: failedVersions.length + 1 };
	return orgCommandFailure({
		id: skillId,
		deleted: false,
		deletedVersions,
		failedVersions,
		reason: report.reason,
		note:
			`${String(deletedVersions.length)} version(s) of ${skillId} were deleted and cannot be `
			+ `restored; ${String(failedVersions.length)} could not be deleted and are still there. `
			+ 'The skill itself still exists — the API refuses a skill that still has versions. '
			+ 'Re-run `--all` once the cause is cleared: it will attempt only what is left.',
	}, outcome);
}

// ── Commands ───────────────────────────────────────────────────────────

export function createOrgSkillsCommand(): Command {
	const command = new Command('skills');

	command
		.description('Manage organization skills (requires ANTHROPIC_API_KEY)')
		.helpCommand(false);

	// list
	const listCmd = new Command('list');
	listCmd
		.description('List organization skills')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (options: { debug?: boolean }) => {
			await executeOrgCommand('claude org skills list', options.debug, ({ client }) => {
				return autopaginateSkills(client, '/v1/skills');
			});
		})
		.addHelpText('after', `
Description:
  Lists skills in the organization. Uses the Skills API (beta).
  Requires ANTHROPIC_API_KEY (regular key, not admin key).
  Skill IDs are slugs, not UUIDs.

Example:
  $ vat claude org skills list
`);

	// install
	const installCmd = new Command('install');
	installCmd
		.description('Upload skill(s) to the organization via Skills API')
		.argument('[source]', 'Path to built skill directory or ZIP file')
		.option('--from-npm <package>', 'Download skills from an npm package (e.g. vibe-agent-toolkit@0.1.22-rc.3)')
		.option('--skill <name>', 'Upload only this skill (with --from-npm)')
		.option('--title <title>', 'Display title override (single skill only)')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (source: string | undefined, options: { fromNpm?: string; skill?: string; title?: string; debug?: boolean }) => {
			await executeOrgCommand('claude org skills install', options.debug, ({ client, logger }) => {
				// INSIDE the action: thrown from the Commander handler they are a floating
				// rejection that reaches no catch and exits 1 with a raw stack trace.
				if (!source && !options.fromNpm) {
					throw new CommandRefusalError('USAGE_INVALID', 'Provide a <source> path or use --from-npm <package>');
				}
				if (source && options.fromNpm) {
					throw new CommandRefusalError('USAGE_INVALID', 'Provide either <source> or --from-npm, not both');
				}
				// The other two illegal combinations, refused rather than silently ignored.
				if (options.title !== undefined && options.fromNpm) {
					throw new CommandRefusalError(
						'USAGE_INVALID',
						'--title applies to a single skill and --from-npm can publish several, so it is '
						+ 'refused here rather than silently ignored. Publish the one skill with '
						+ '--skill and set its title in its SKILL.md, or upload its directory directly.',
					);
				}
				if (options.skill !== undefined && !options.fromNpm) {
					throw new CommandRefusalError('USAGE_INVALID', '--skill selects one skill inside an npm package; it applies only with --from-npm');
				}
				if (options.fromNpm) {
					return installFromNpm(options.fromNpm, options.skill, client, logger);
				}
				return installFromLocal(source as string, options.title, client, logger);
			});
		})
		.addHelpText('after', `
Description:
  Uploads skill(s) to the organization via the Anthropic Skills API (beta).
  Accepts a built skill directory, a ZIP file, or an npm package.
  Requires ANTHROPIC_API_KEY (regular key, not admin key).

  A DIRECTORY uploads under the "name" its SKILL.md frontmatter declares, which
  is also the default display_title.

  A ZIP takes its display_title from the ZIP FILENAME, so my-skill-v2.zip
  publishes a skill titled "my-skill-v2", which is a separate skill from
  "my-skill" and is not refused as a duplicate. VAT reads the archive's SKILL.md
  and WARNS when the name it declares differs from that title, because every
  version the skill ever gets will carry the declared name. Pass --title to set
  the title explicitly.

  A ZIP holds SKILL.md at its top level, or exactly one top-level folder with
  SKILL.md directly inside (a skill folder, compressed) — the layout the install
  verbs take. Any other layout is refused (INPUT_UNREADABLE), and so is a ZIP
  holding a symbolic link, a name that leaves the archive, one name twice, or
  more than 50,000 entries / 256 MiB expanded, a name Windows cannot hold (a
  ":", < > " | ? *, a control character, a device name such as CON or aux.md,
  a trailing "." or space), a ZIP64 archive, one whose end record two readers
  could read differently or is not in its last 64 KiB, one with data before its
  first local header (a self-extracting ZIP) or a directory entry whose local
  header is not its own, or one holding an entry VAT cannot inflate. What is
  sent is VAT's own ZIP of the entries it read and checked (its names, order,
  timestamps, compression and 0644/0755 modes) — never your file's bytes — so a
  top-level __MACOSX/ folder or .DS_Store (what macOS adds) is left out.
  Only bytes that are no ZIP at all (no local-file-header or end-record
  signature anywhere in them) are sent as they are, with a warning that the
  checks below were skipped.

  A skill's eval suite is its answer key and is never uploaded: whatever the
  governing vibe-agent-toolkit.config.yaml declares as this skill's test input
  (skills.config.<name>.test.evals) is withheld, and so is ANY directory named
  evals/ — unconditionally, whether or not a config was found. node_modules/ and
  .git/ are never uploaded either. Each exclusion is reported in the output.

  A ZIP is REFUSED outright when it contains any of those three directory names,
  rather than having them withheld: the archive is posted as one part, so there
  is nothing to strip out of it. Rebuild it from the built skill directory, or
  upload that directory. (A config-declared suite in some other location is
  invisible to this lane — there is no directory to resolve a config from.)

  Those same three directory names are also left out of the bytes weighed against
  the ceiling below, and out of the build-time PACKAGED_SIZE_EXCEEDS_API_LIMIT
  total, so \`du -sb\` on the directory will report more than VAT does.

  A symbolic link is refused rather than followed, whatever it points at: a
  multipart body cannot express one, and reading through it would publish the
  target's bytes under an in-bundle name.

  Before anything is sent, every markdown document in the bundle is run through
  the non-portable reference, non-portable command, and unqualified MCP tool-name
  checks — the ones that catch a skill referencing a path outside its own tree,
  which cannot resolve once the API publishes it alone. These WARN and never
  block. Run \`vat audit <dir>\` for the full report.

  A ZIP faces the same three checks: its markdown members are read out of the
  archive and run through them, so a hand-built bundle is not the quiet lane.
  The one difference is the config. On a DIRECTORY, \`validation.allow\` /
  \`validation.severity\` from the governing vibe-agent-toolkit.config.yaml are
  honoured, so a waiver that makes \`vat skills build\` green makes this quiet
  too. On a ZIP there is no directory to resolve that config from — the same
  reason a config-declared eval-suite location is invisible here — so the checks
  run UNWAIVED and a warning you have already waived elsewhere will still print.

  There are TWO size gates and a ZIP faces both. The REQUEST gate weighs the
  multipart body — file bytes plus about 156 bytes of framing per file — against
  the API's ${formatBytes(API_SKILL_MAX_UPLOAD_BYTES)} ceiling; it is inclusive,
  measured: a body of exactly ${API_SKILL_MAX_UPLOAD_BYTES.toLocaleString('en-US')}
  bytes is accepted and one byte more is refused 413. A directory and a ZIP both
  go through it. The API then EXPANDS a ZIP and applies the same ceiling to the
  uncompressed total, so an archive far under the request ceiling can still be
  refused — VAT reads the archive's own headers and refuses first, naming the
  expanded size, because compressing harder cannot get it under the limit.

Exit Codes:
  0 - Every skill uploaded
  2 - At least one skill failed to upload (--from-npm uploads several; the ones
      that landed are still listed under skills, each failure under errors as
      { skill, error: { code, message } }), or the run was refused: no
      API key, no such source, unusable input ({ error: { code, message } })

Examples:
  $ vat claude org skills install dist/skills/org-admin
  $ vat claude org skills install my-skill.zip --title "My Custom Skill"
  $ vat claude org skills install --from-npm vibe-agent-toolkit@0.1.22-rc.3
  $ vat claude org skills install --from-npm vibe-agent-toolkit@0.1.22-rc.3 --skill org-admin
`);

	// delete
	const deleteCmd = new Command('delete');
	deleteCmd
		.description('Delete a skill from the organization')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		.option('--all', 'Auto-delete all versions before deleting the skill')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, options: { all?: boolean; debug?: boolean }) => {
			await executeOrgCommand('claude org skills delete', options.debug, async ({ client, logger }) => {
				// Every version this run actually destroyed: a RECORD — see `reportHalfDeleted`.
				const deletedVersions: string[] = [];
				const halfDeleted = (error: unknown, failedVersions: readonly string[]): OrgCommandFailure =>
					reportHalfDeleted({
						skillId,
						deletedVersions,
						failedVersions,
						reason: errorMessageOf(error),
					});

				if (options.all) {
					const versions = await autopaginateSkills(client, skillVersionsPath(skillId));
					const versionData = versions.data as Array<{ id: string; version: string }>;
					// "Found …", not "Deleting …": nothing has been deleted at this point
					// and the very next call can be refused. Cf. `installFromLocal`.
					logger.info(`Found ${String(versionData.length)} version(s) of ${skillId} to delete first`);
					// ATTEMPTS every version, whatever any one of them answers (`deleteEveryVersion`).
					const sweep = await deleteEveryVersion(client, skillId, versionData.map(v => v.version), logger);
					deletedVersions.push(...sweep.deleted);
					if (sweep.failures.length > 0) {
						const detail = describeVersionSweepFailures(sweep.failures);
						// Nothing was destroyed, so the refusal (EXTERNAL_API_FAILED, exit 2) is the
						// honest ending.
						if (deletedVersions.length === 0) {
							throw new CommandRefusalError(
								'EXTERNAL_API_FAILED',
								`No version of ${skillId} could be deleted, so the skill was left alone. `
								+ `${String(sweep.failures.length)} attempt(s) failed — ${detail}`,
							);
						}
						// The skill delete is not attempted: the API refuses a skill that still
						// has versions, so it would spend a round trip to be told what is
						// already known here.
						return halfDeleted(new Error(detail), sweep.failures.map(failure => failure.version));
					}
				}

				logger.info(`Deleting skill: ${skillId}`);
				// The vendor's refusal here names no VAT command — measured live as
				// `400 Cannot delete skill with existing versions. Delete all versions
				// first.` — so the one that answers it is appended, unless this run
				// already deleted them.
				let raw: unknown;
				try {
					raw = await deleteSkillOrExplain(
						client, skillId, options.all === true ? DELETE_REMEDIES_AFTER_ALL : DELETE_REMEDIES,
					);
				} catch (error) {
					if (deletedVersions.length === 0) throw error;
					// The sweep completed — every version is gone — and the SKILL delete is
					// what failed, so nothing is left in `failedVersions`.
					return halfDeleted(error, []);
				}
				const deleted = reportDelete(raw, skillId, SKILL_DELETED_TYPES);
				return deletedVersions.length === 0
					? deleted
					// The versions are part of what this run DID, so they belong in the
					// document either way — and the failure tag has to survive being
					// merged with them.
					: mergeDeleteReport(deleted, deletedVersions);
			});
		})
		.addHelpText('after', `
Description:
  Deletes a skill from the organization. Uses the Skills API (beta).
  Requires ANTHROPIC_API_KEY (regular key, not admin key).

  The API refuses to delete a skill that still has versions (400). Use --all to
  delete every version and then the skill in one command; without it, delete the
  versions yourself with \`vat claude org skills versions delete\` first.

  --all deletes irreversibly and in a loop, and it ATTEMPTS EVERY VERSION even
  when one refuses — one refusal is a fact about one version, not about the ones
  after it. When the sweep ends with anything left, the versions it destroyed are
  listed under deletedVersions, the ones still there under failedVersions, why
  under reason, and the run exits 2 with that record published. The skill itself
  is then left alone, because the API refuses a skill that still has versions.
  When nothing was deleted at all, it publishes only the refusal
  ({ error: { code, message } }), also at 2.

  A version delete whose response is lost is replayed, and the replay is answered
  404 because the first attempt already removed it. That 404 is read as the
  delete it is, not as a failure — the version appears under deletedVersions.

Exit Codes:
  0 - The skill was deleted
  2 - The skill was NOT deleted: the API named a different outcome, or --all
      destroyed some versions and could not destroy the rest (the document
      lists both); or the run was refused — no API key, the first request was
      refused, or --all deleted no version at all ({ error: { code, message } })

Example:
  $ vat claude org skills delete skill_abc123 --all
`);

	// versions subgroup
	const versionsCmd = new Command('versions');
	versionsCmd.description('Manage skill versions').helpCommand(false);

	const versionsListCmd = new Command('list');
	versionsListCmd
		.description('List versions of a skill')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, options: { debug?: boolean }) => {
			await executeOrgCommand('claude org skills versions list', options.debug, ({ client }) => {
				return autopaginateSkills(client, skillVersionsPath(skillId));
			});
		})
		.addHelpText('after', `
Description:
  Lists all versions of a skill. Uses the Skills API (beta).
  Requires ANTHROPIC_API_KEY.

Example:
  $ vat claude org skills versions list skill_abc123
`);

	const versionsDeleteCmd = new Command('delete');
	versionsDeleteCmd
		.description('Delete a specific version of a skill')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		.argument('<version>', 'Version to delete')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, version: string, options: { debug?: boolean }) => {
			await executeOrgCommand('claude org skills versions delete', options.debug, async ({ client, logger }) => {
				logger.info(`Deleting version ${version} of skill ${skillId}`);
				return reportVersionDelete(
					await client.deleteSkillVersion<unknown>(skillId, version),
					skillId,
					version,
				);
			});
		})
		.addHelpText('after', `
Description:
  Deletes a specific version of a skill. Uses the Skills API (beta).
  All versions must be deleted before a skill can be deleted.
  Requires ANTHROPIC_API_KEY.

Output:
  - id: the SKILL this version belonged to (always the id you passed)
  - version: the version that was destroyed (always the one you passed)
  - deleted: whether the API confirmed the deletion

Exit Codes:
  0 - The version was deleted
  2 - The API named an outcome other than a deletion, or the run was refused:
      no API key, or the request was refused ({ error: { code, message } })

Example:
  $ vat claude org skills versions delete skill_abc123 1775007400733130
`);

	const versionsAddCmd = new Command('add');
	versionsAddCmd
		.description('Publish a new version of an existing skill')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		// NOT "or ZIP file": a ZIP posted to POST /v1/skills/{id}/versions has never
		// been tried against the live API, and the guard below refuses one.
		.argument('<source>', 'Path to a built skill directory')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, source: string, options: { debug?: boolean }) => {
			await executeOrgCommand('claude org skills versions add', options.debug, ({ client, logger }) => {
				const resolved = resolveSourceArgument(source);
				if (!statNamedPath(resolved, resolved, `Source not found: ${resolved}`).isDirectory()) {
					// Name the asymmetry IN the refusal: `install` accepts a ZIP and this verb
					// does not.
					const zipHint = resolved.toLowerCase().endsWith('.zip')
						? ' A ZIP is accepted by `vat claude org skills install`, not here:'
							+ ' publish a new version from the built skill directory instead.'
						: '';
					throw new CommandRefusalError('USAGE_INVALID', `Source must be a skill directory: ${resolved}.${zipHint}`);
				}
				// "Packaging", not "Publishing" — see `installFromLocal`.
				logger.info(`Packaging new version of ${skillId} from: ${resolved}`);
				return uploadSkillVersionDir(client, skillId, resolved, logger);
			});
		})
		.addHelpText('after', `
Description:
  Publishes the contents of a skill directory as a NEW VERSION of an existing
  skill. Uses the Skills API (beta). Requires ANTHROPIC_API_KEY.

  This is how you ship a change to a skill you have already published. It is a
  separate command from \`install\` on purpose: \`install\` always creates a new
  skill, this always adds a version to the skill you name, and neither inspects
  the workspace to decide which it "should" do. A display title is NOT unique in
  a workspace, so resolving one to a skill can match none, one, or several — and
  a wrong match would append your version to somebody else's skill.

  Find the id with \`vat claude org skills list\`. The API assigns the version
  identifier and makes it the skill's latest; nothing is numbered locally.

  Takes a built skill DIRECTORY. A ZIP is accepted by \`install\`, not here.

  The same exclusions and the same ${formatBytes(API_SKILL_MAX_UPLOAD_BYTES)} request
  ceiling as \`install\` apply: the eval suite, node_modules/ and .git/ are never
  uploaded, and a symbolic link is refused rather than followed.

  The uploaded files are keyed under the top-level directory named by this
  tree's SKILL.md \`name\`, and that root is printed as the upload runs. The API
  enforces that name against the one this skill already has, so publishing from a
  renamed tree is refused with a 400 rather than silently re-rooting the version's
  files. VAT does not check it first — it reports the root it used and lets the
  server be the authority.

Exit Codes:
  0 - The version was published
  2 - The run was refused ({ error: { code, message } }): no API key, no such
      source, not a directory,
      over the upload ceiling, or a response the version identifier
      cannot be read from

Example:
  $ vat claude org skills versions add skill_abc123 dist/skills/org-admin
`);

	versionsCmd.addCommand(versionsListCmd);
	versionsCmd.addCommand(versionsAddCmd);
	versionsCmd.addCommand(versionsDeleteCmd);

	command.addCommand(listCmd);
	command.addCommand(installCmd);
	command.addCommand(deleteCmd);
	command.addCommand(versionsCmd);

	return command;
}
