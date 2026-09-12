/**
 * `vat claude org skills` — manage organization skills via Skills API.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
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
import { createAllowUsageLedger, runValidationFramework } from '@vibe-agent-toolkit/schema';
import type { ValidationConfig, ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  isAbsoluteAnyPlatform,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
// Type-only: the runtime import stays lazy inside `inspectZipArchive`, so the
// archive reader is loaded on the one path that parses an archive.
import type AdmZipArchive from 'adm-zip';
import { Command } from 'commander';

import { resolveSkillPackagingConfig } from '../../../skill-resolution/packaging-config.js';
import { downloadNpmPackage } from '../plugin/helpers.js';

import type { OrgCommandFailure } from './helpers.js';
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
 * body satisfies it. Without this, a response whose keys differ from the ones
 * named here resolves happily and the operator reads `status: success` beside
 * `version: null` — and `version` is precisely the value a later
 * `skills versions delete` takes, so the run that "succeeded" leaves them unable
 * to address what it created. The create endpoint's shape was measured against
 * the live API; `POST /v1/skills/{id}/versions` was not, which is exactly why it
 * must fail loudly rather than print nulls if it differs.
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
		throw new Error(
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
 * 🔑 Same class of problem as {@link readSkillUploadResponse} — the client's
 * `<T>` is an assertion, not a check — but the OPPOSITE verdict on an empty
 * body, and deliberately so. The client used to reject a 2xx carrying no body
 * with a parse error, which reported a 204 DELETE that SUCCEEDED as a failure;
 * that is fixed, and the value now handed to this reader for such a response is
 * `undefined`. Refusing it here, the way an upload response is refused, would
 * reinstate the same lie one layer up — and reading `.id` off it, which is what
 * the two call sites did, is a `TypeError` in place of a report.
 *
 * So an empty body is read as the success it is: the status already said the
 * resource is gone, the id is the one this process asked for, and there is
 * nothing else to learn. Measured live behaviour today is a JSON body carrying
 * `type: skill_deleted`, so the empty case is LATENT rather than a live
 * regression — but it is one 204 away, and a latent `TypeError` is not a
 * contract.
 *
 * `deleted` is false only when the body affirmatively names a DIFFERENT
 * outcome, which is the one case where the API is saying something this command
 * must not paper over — and {@link reportDelete} is what makes the run END that
 * way rather than merely say so in a field nothing reads.
 *
 * ⚠️ `expectedTypes` is a LIST because only one member of it is measured.
 * `skill_deleted` came back from a live `DELETE /v1/skills/{id}`;
 * `skill_version_deleted` is the plausible spelling for the version endpoint and
 * has never been seen. A single guessed string would make every version delete
 * report `deleted: false` — and now exit 1 — if the vendor spells it differently
 * by one character. Accepting either keeps the check honest about what it knows:
 * a body naming something that is neither is a real divergence worth failing on.
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

/**
 * A delete's document, tagged as a FAILED run when the API said the thing was
 * not deleted.
 *
 * 🔑 Without this, `deleted: false` was computed, printed under
 * `status: success`, and exited 0 — the exact "the run completed and its outcome
 * is wrong" shape that {@link orgCommandFailure} was added in this same change to
 * fix for `--from-npm`, in the one branch that never got wired to it. A CI
 * wrapper spelled `vat claude org skills delete X || fail` reported green while
 * the skill was still there.
 *
 * The document is still PUBLISHED — the id and the verdict are what the operator
 * needs — and only the exit code changes. Throwing instead would end non-zero and
 * discard the report.
 */
export function reportDelete(
	raw: unknown,
	requestedId: string,
	expectedTypes: readonly string[],
): SkillDeleteResult | OrgCommandFailure {
	const result = readDeleteResponse(raw, requestedId, expectedTypes);
	return result.deleted ? result : orgCommandFailure(result);
}

/** The document a version delete publishes: which version, of which skill. */
export interface SkillVersionDeleteResult extends SkillDeleteResult {
	readonly version: string;
}

/**
 * A version delete's document — the same verdict as {@link reportDelete}, about
 * a subject that can actually be identified.
 *
 * 🚨 **The version-delete document used to name no version at all, and its `id`
 * meant two different things depending on the response.** It went through
 * `reportDelete(raw, skillId, …)`, so `readDeleteResponse` returned the API's
 * ECHOED id when there was a body — the VERSION identifier — and fell back to
 * the requested id — the SKILL identifier — on a 204. Two runs of the same
 * command therefore published `id` fields from two different namespaces, and
 * neither run's document said which of a skill's versions had been destroyed.
 * An audit trail of an irreversible operation that cannot name what it destroyed
 * is not an audit trail.
 *
 * Both fields are now local knowledge, which is the whole point: this process
 * asked to delete `version` of `skillId` and the API confirmed a deletion, so
 * nothing about the subject's identity has to be recovered from the response
 * shape. The response is still read — for the VERDICT, which is the one thing
 * only the API knows.
 */
export function reportVersionDelete(
	raw: unknown,
	skillId: string,
	version: string,
): SkillVersionDeleteResult | OrgCommandFailure {
	const { deleted } = readDeleteResponse(raw, skillId, SKILL_VERSION_DELETED_TYPES);
	const document: SkillVersionDeleteResult = { id: skillId, version, deleted };
	return deleted ? document : orgCommandFailure(document);
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
	const failed = 'orgCommandFailed' in result;
	const document = { ...(failed ? result.document : result), deletedVersions };
	return failed ? orgCommandFailure(document) : document;
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
 * 🔑 **The ceiling is INCLUSIVE, and that is measured rather than reasoned.** A
 * request body of exactly {@link API_SKILL_MAX_UPLOAD_BYTES} bytes is ACCEPTED;
 * one byte more is refused `413`:
 *
 * | raw file bytes | + framing | = body | live API |
 * |---|---|---|---|
 * | 31,456,735 | 545 | **31,457,280** | `status: success` |
 * | 31,456,736 | 545 | 31,457,281 | `413` |
 *
 * So the comparison here is `>`, not `>=`. An earlier version of this code used
 * `>=` on the argument that firing AT the ceiling was the conservative reading —
 * an argument that was never measured, and the measurement above refutes it. It
 * is not conservative: it refuses a body the API takes, and the operator has no
 * way to tell that VAT and not Anthropic said no.
 *
 * ⚠️ **The build-time lane deliberately differs, and must not be "harmonised"
 * with this one.** `checkPackagedSizeLimit` fires when FILE BYTES reach the same
 * number — `>=` — because framing is never zero, so files totalling exactly the
 * limit always produce a request LARGER than the limit and therefore a real 413.
 * Two lanes, two measures, two rules: **file bytes `>=` refuse; request bytes `>`
 * refuse.** Both are right about the quantity each can see.
 *
 * THE one gate every upload passes through, whichever shape it started as. The
 * check used to live inside the directory-packaging step alone, so
 * `skills install big-skill.zip` — the one input that is by construction a
 * single large binary, and the shape the check was written for — reached the
 * wire unmeasured.
 *
 * 🔑 **It weighs the BODY, not the sum of the file bytes.** The API measures the
 * request, and the request is this buffer. Summing `file.content.length` — what
 * this did — ignores the per-part framing `buildMultipartFormData` adds: a
 * 51-byte boundary line, a `Content-Disposition` of 61 bytes plus the filename, a
 * 42-byte content-type-and-blank-line and a 2-byte trailing CRLF, so 156 bytes
 * plus the filename PER FILE, plus a 53-byte terminator. A 1,000-file bundle
 * therefore carries ~180 KiB that the old measure could not see, and a bundle
 * whose content sat just under the ceiling passed the pre-flight and then earned
 * the 413 this check exists to prevent — 11 seconds for 30 MB, measured.
 *
 * No headroom constant closes that gap, and none is added: the exact number is
 * available for free by building the body first and asking it how long it is.
 * The body is then RETURNED, so the bytes that were weighed are the bytes that go
 * out; a gate that only inspected its inputs would be one refactor away from
 * measuring something the caller no longer sends.
 *
 * The build-time `PACKAGED_SIZE_EXCEEDS_API_LIMIT` cannot do this — there is no
 * request at build time — so it weighs files on disk and says so. The two
 * messages name what each measured rather than pretending to be the same number.
 */
export function buildUploadBodyOrRefuse(
	fields: Record<string, string>,
	files: readonly MultipartFile[],
	bundleRoot?: string,
): MultipartResult {
	const multipart = buildMultipartFormData(fields, [...files]);
	// `>`, not `>=`: a body of exactly the ceiling was ACCEPTED by the live API and
	// one byte more was refused 413. The two measured rows, and why the build-time
	// lane keeps `>=` on a different quantity, are in this function's doc comment.
	if (multipart.body.length > API_SKILL_MAX_UPLOAD_BYTES) {
		const sized = files.map(f => ({ path: bundleRelativeName(f.filename, bundleRoot), bytes: f.content.length }));
		const measure = { of: 'upload-request' as const, bytes: multipart.body.length };
		throw new Error(`${describeOversizeBundle(sized, measure)}. The API will refuse this upload.`);
	}
	return multipart;
}

/**
 * An uploaded part's filename in the SAME namespace the build-time finding uses.
 *
 * A directory's parts are keyed `<declared-name>/<bundle-relative-path>`, because
 * that is how the API roots them; `PACKAGED_SIZE_EXCEEDS_API_LIMIT` names files
 * relative to the bundle root. Printing the keyed spelling here meant the path an
 * author copied out of an upload refusal never matched the `link` their build had
 * reported, so a `validation.allow` entry written from one message did not waive
 * the other. The prefix is stripped when it is there and left alone when it is
 * not — a ZIP is one part named for the archive itself, with no root to strip.
 */
function bundleRelativeName(filename: string, bundleRoot: string | undefined): string {
	if (bundleRoot === undefined) return filename;
	// Both sides normalized before comparing. The parts are minted from
	// `safePath.relative`, so they are already forward-slashed — but a prefix test
	// that only holds because of where its inputs came from is one refactor from
	// silently never matching on Windows.
	const name = toForwardSlash(filename);
	const prefix = `${toForwardSlash(bundleRoot)}/`;
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
 * ⛔ **The trigger is a RECORDED FACT, never the error's class.** This used to
 * read `if (error instanceof ApiRequestError) return error;` — "a completed
 * exchange always arrives as an `ApiRequestError`, so anything else must be a
 * dropped connection". The first half is true and the converse is not, and the
 * converse is what shipped: `buildSkillsHeaders()` throws a plain `Error` before
 * a socket is ever opened, so
 * `ANTHROPIC_API_KEY= vat claude org skills install <dir>` told a first-time
 * operator, on top of the real "no key" message, that a connection had closed,
 * that VAT had sent 6.8 KiB (the length of a buffer that never left the process),
 * and that the outcome was unknown — then sent them to a recovery command that
 * fails with the identical missing-key error. Three false statements and a loop.
 *
 * So the gate is POSITIVE and evidential: annotate only an
 * {@link ApiTransportError}, which exists only once the transport has been
 * reached and carries `bytesSent` read off the socket at failure time. Anything
 * else — a missing credential, a bad URL, a response VAT refused to read —
 * passes through with its own message untouched.
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
		return new Error(
			`${error.message}\nNo byte of the request left this machine, so nothing was created and `
			+ 'there is nothing to clean up. Fix the connection and re-run the same command.',
			{ cause: error },
		);
	}
	return new Error(
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
 * 🪤 The test used to be `source.startsWith('/')`, which is false for
 * `D:\builds\skill` — so a Windows operator's absolute path was joined onto the
 * working directory and reported back as `Source not found: <cwd>/D:/builds/skill`.
 * {@link isAbsoluteAnyPlatform} answers for POSIX roots, drive letters and UNC
 * paths on EVERY host, so the behaviour is the same wherever it runs and a
 * POSIX-only CI can see the drive-letter case at all.
 */
export function resolveSourceArgument(source: string): string {
	return isAbsoluteAnyPlatform(source)
		? toForwardSlash(source)
		: safePath.resolve(process.cwd(), source);
}

/**
 * Send multipart files to the Skills API as a NEW skill, and return a normalized
 * result.
 *
 * The body is built through the ceiling gate, so every create — a directory or a
 * ZIP — is weighed as the request it will become before a byte is sent.
 */
/** One entry of a ZIP's central directory, as `adm-zip` hands it back. */
type ZipEntry = ReturnType<AdmZipArchive['getEntries']>[number];

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
}

/**
 * The largest single markdown member this will decompress to read.
 *
 * Not a limit on what may be PUBLISHED — the API's own ceiling decides that, and
 * a bigger document simply goes unread rather than refused. It bounds the
 * allocations this module performs on attacker-supplied metadata: `getData()`
 * inflates whatever `header.size` claims, and a header can claim anything. A
 * megabyte is two orders of magnitude above any real skill document.
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
 * not to the archive.** Measured against the live API by an adopter: a
 * 10,707,463-byte archive of a 47.85 MiB tree — comfortably inside the request
 * ceiling as bytes on the wire — came back
 * `400: Zip file uncompressed size exceeds 30MB`. So the body check every other
 * shape passes through is structurally blind here: compression is exactly the
 * thing that makes the measured quantity stop predicting the enforced one. A
 * ZIP is therefore the one input that could pass every local gate and still be
 * refused remotely, which is the same defect class as the ZIP path once
 * skipping the size check altogether.
 *
 * ⚠️ **The boundary itself is UNMEASURED on this lane.** One refusal at 47.85
 * MiB is all the evidence there is; nobody has bracketed where the uncompressed
 * rule actually cuts, or confirmed it is the same constant as the request lane.
 * So this refuses only on `>` — strictly the looser choice — and a bundle near
 * the line is still sent for the API to judge. Do not tighten this to `>=`, or
 * quote it as a measured ceiling, without bracketing it the way
 * {@link API_SKILL_MAX_UPLOAD_BYTES} was bracketed.
 *
 * ⛔ Sizes come from entry HEADERS, which an archive can lie about. That is
 * fine: a lie can only change whether VAT refuses early, never whether the API
 * does.
 *
 * ⚠️ **Reading an entry is not free, and the docstring here used to claim it
 * was** — "no zip-slip or zip-bomb surface is opened — the entries are read, not
 * written" was true of the enumeration half and FALSE of the one `getData()`
 * call, which inflates `header.size` bytes into memory. Worse, it ran BEFORE the
 * caller's uncompressed-total gate, so the ceiling this function exists to
 * enforce could not protect the inflation this function performed. Nothing is
 * written to disk — that part stands — but the decompression is now ordered
 * after the total is known and bounded by {@link MAX_INSPECTED_DOCUMENT_BYTES},
 * so an archive declaring a 4 GiB SKILL.md is enumerated and never inflated.
 */
export async function inspectZipArchive(zipPath: string): Promise<ZipInspection | undefined> {
	// `adm-zip` is already a runtime dependency of this package (the packager and
	// the url skill-source both use it). An earlier comment here reasoned that
	// reading the archive would mean "adding a dependency … for a log line" and
	// declined on that basis; the premise was false, and the payoff is not a log
	// line but a refusal that saves a doomed upload of up to 30 MiB.
	const AdmZip = (await import('adm-zip')).default;
	let entries: ZipEntry[];
	try {
		entries = new AdmZip(zipPath).getEntries();
	} catch {
		// An archive VAT cannot parse is not an archive VAT should block. The API
		// is the authority on the upload either way, and refusing here would turn
		// "our reader disagrees with your zip tool" into a failed publish.
		return undefined;
	}

	// PASS 1 — headers only. Nothing is decompressed while this runs, so both
	// refusals the caller can reach are decided on metadata alone.
	const files = entries.filter(entry => !entry.isDirectory);
	const uncompressedBytes = files.reduce((sum, entry) => sum + entry.header.size, 0);
	const neverUploaded = files
		.map(entry => toForwardSlash(entry.entryName))
		.filter(name => name.split('/').some(segment => NEVER_UPLOADED_DIR_NAMES.has(segment)));

	// PASS 2 — the entries worth inflating, and only once the total says this
	// archive is not already refused. An over-ceiling archive is about to be
	// rejected by the caller, so inflating anything out of it would be work spent
	// on an upload that cannot happen.
	if (uncompressedBytes > API_SKILL_MAX_UPLOAD_BYTES) {
		return { uncompressedBytes, declaredName: undefined, neverUploaded, documents: [], bundleRoot: undefined };
	}
	const elected = electShallowestSkillMd(files);
	return {
		uncompressedBytes,
		declaredName: declaredNameOf(elected),
		neverUploaded,
		documents: inflateMarkdownMembers(files),
		bundleRoot: archiveRootOf(elected?.entryName),
	};
}

/**
 * Every markdown member of the archive, as an upload part.
 *
 * 🔑 This exists so the ZIP lane can run the portability family through the ONE
 * function the directory lane runs it through. Until it did, `install <zip>`
 * performed none of the checks `install --help` promises of "every markdown
 * document in the bundle": the archive went to `sendSkillUpload` as one opaque
 * part, and an operator following the documented contract got silence where they
 * were promised warnings. Routing the parts back through
 * {@link warnUnportableReferences} keeps ONE implementation of the checks — a
 * second copy of the three collector calls is how the two lanes start disagreeing.
 *
 * An entry that will not inflate is SKIPPED, never fatal: this module's standing
 * position is that an archive VAT cannot read is not an archive VAT should block,
 * and the checks it feeds only ever warn.
 */
function inflateMarkdownMembers(files: readonly ZipEntry[]): MultipartFile[] {
	const documents: MultipartFile[] = [];
	for (const entry of files) {
		const filename = toForwardSlash(entry.entryName);
		if (!filename.toLowerCase().endsWith('.md')) continue;
		if (entry.header.size > MAX_INSPECTED_DOCUMENT_BYTES) continue;
		try {
			documents.push({ fieldName: 'files[]', filename, content: entry.getData() });
		} catch {
			continue;
		}
	}
	return documents;
}

/**
 * The directory the elected SKILL.md sits in, which is the archive's bundle root.
 *
 * `my-skill/SKILL.md` roots the bundle at `my-skill`; a SKILL.md at the archive
 * root has no prefix, and neither does an archive with no SKILL.md at all. ZIP
 * fixes `/` as the entry separator, so this reads the format rather than handling
 * a host path.
 */
function archiveRootOf(entryName: string | undefined): string | undefined {
	if (entryName === undefined) return undefined;
	const cut = toForwardSlash(entryName).lastIndexOf('/');
	return cut === -1 ? undefined : entryName.slice(0, cut);
}

/**
 * The SKILL.md nearest the archive root, which is the one whose `name` the API
 * will key the skill by.
 *
 * 🪤 Compared on DEPTH, with name length only as a tiebreak. It used to compare
 * `entryName.length` alone, on the reasoning that "a shortest-path comparison
 * needs no separator at all" — but shortest string is not shallowest path:
 * `a/b/SKILL.md` (12 chars, depth 2) beats `my-skill-bundle/SKILL.md` (24
 * chars, depth 1), so a bundled FIXTURE supplied the name and the operator was
 * advised to `--title` it. ZIP fixes `/` as the entry separator on every
 * platform, so splitting on it is not path handling — it is reading the format.
 */
function electShallowestSkillMd(files: readonly ZipEntry[]): ZipEntry | undefined {
	let elected: ZipEntry | undefined;
	for (const entry of files) {
		if (basename(entry.entryName) !== 'SKILL.md') continue;
		if (elected !== undefined && !isShallower(entry.entryName, elected.entryName)) continue;
		elected = entry;
	}
	return elected;
}

/** Fewer path segments wins; equal depth falls back to the shorter name. */
function isShallower(candidate: string, incumbent: string): boolean {
	const candidateDepth = zipEntryDepth(candidate);
	const incumbentDepth = zipEntryDepth(incumbent);
	return candidateDepth === incumbentDepth
		? candidate.length < incumbent.length
		: candidateDepth < incumbentDepth;
}

/**
 * How many segments a ZIP entry name has.
 *
 * Counted rather than `split('/')`-ed because the linter — correctly, for
 * FILESYSTEM paths — refuses that idiom: a host path's separator depends on the
 * platform. A ZIP entry name's does not; the format fixes it as `/`. Counting
 * the separator states that, and needs no exemption.
 */
function zipEntryDepth(entryName: string): number {
	let depth = 1;
	for (const character of entryName) {
		if (character === '/') depth += 1;
	}
	return depth;
}

/**
 * The frontmatter `name` inside the ELECTED entry — or `undefined`, including
 * when that entry declares none.
 *
 * 🪤 It used to be `declaredSkillNameIn(…) ?? declaredName`, which KEPT the
 * previous (deeper) candidate's name when a newly-elected shallower SKILL.md had
 * no `name`. The elected file and the reported name then came from two different
 * documents, and the divergence warning named a name no operator could find at
 * the root of their archive. The election decides; whatever it holds is the
 * answer, absence included.
 *
 * `getData()` is the only decompression in this module, so it is the only thing
 * that can throw here: adm-zip raises on BAD_CRC, on any compression method but
 * store/deflate, and on an encrypted entry. Those used to escape and abort the
 * publish on exit 2 — contradicting this module's own stance that an archive VAT
 * cannot parse is not an archive VAT should block. The size total is already
 * computed from headers, so failing here costs only the name.
 */
function declaredNameOf(entry: ZipEntry | undefined): string | undefined {
	if (entry === undefined || entry.header.size > MAX_INSPECTED_DOCUMENT_BYTES) return undefined;
	try {
		return declaredSkillNameIn(entry.getData().toString('utf8'));
	} catch {
		return undefined;
	}
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
function requireDeclaredName(skillMdPath: string): string {
	const declared = readDeclaredSkillName(skillMdPath);
	if (declared === undefined) {
		throw new Error(
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
	const config = await resolveSkillPackagingConfig(safePath.join(skillDir, 'SKILL.md'));
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
 * directory. That entry therefore used to fall into the FILE branch below and
 * `readFileSync` threw a raw `EISDIR`: the upload died on a Node error that
 * named no path and said nothing about what to do. A dangling link produced the
 * same shape of failure with `ENOENT`.
 *
 * `statSync` follows the link, which is the same thing the build-time size walk
 * does to classify one — so both lanes reach the same verdict about the same
 * entry.
 */
function resolvesToDirectory(entry: Dirent, fullPath: string, relativePath: string): boolean {
	if (!entry.isSymbolicLink()) return false;
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- collected from dir walk
		return statSync(fullPath).isDirectory();
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(
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
 * way to express a link, so there are only three things this could do with one
 * and two of them are wrong. Skipping it changes what gets published without the
 * skill breaking until someone opens it — and the one thing this collector
 * guarantees is that every withholding is reported. FOLLOWING it is data egress:
 * an earlier version refused only a link resolving to a DIRECTORY, so
 * `notes.md -> /etc/passwd` fell through both branches, `readFileSync` returned
 * the target's bytes, and they were posted under the in-bundle name `notes.md`
 * into a workspace every org member can read. Nothing in the run said a link had
 * been followed: the "every withholding is reported" guarantee covers
 * EXCLUSIONS, not DEREFERENCES. Any file the operator can read left the machine.
 *
 * The vector is not a registry tarball — node-tar 7 de-roots an absolute
 * linkpath and refuses an escaping relative one, measured — but a directory
 * extracted with system `tar`, which does recreate `-> /etc/passwd`, or cloned
 * from an untrusted repo and handed to `install <dir>`.
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
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- dir from CLI arg
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = safePath.join(dir, entry.name);
		const relativePath = safePath.relative(base, fullPath);
		const linkedDirectory = resolvesToDirectory(entry, fullPath, relativePath);
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
			// Whatever it points at. A link to a FILE used to fall through to the
			// branch below and be read through — see this function's doc comment.
			throw new Error(
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
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from CLI arg
	if (!existsSync(skillMdPath)) {
		throw new Error(`SKILL.md not found in ${skillDir}. Is this a built skill directory?`);
	}

	// The skill's own declared name — not the directory it happens to sit in,
	// which for a built or extracted tree carries no reliable identity.
	const declaredName = requireDeclaredName(skillMdPath);
	const displayTitle = titleOverride ?? declaredName;

	// API requires files inside a top-level directory (e.g. skill_name/SKILL.md)
	const dirName = declaredName;
	const collected = await collectSkillUploadFiles(skillDir);
	const files: MultipartFile[] = [];

	for (const file of collected.files) {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- collected from dir walk
		const content = readFileSync(file.absolutePath);
		files.push({
			fieldName: 'files[]',
			filename: `${dirName}/${file.relativePath}`,
			content,
		});
	}

	// Reported on the collected files, so the exclusions listed below are already
	// accounted for — this is the bundle actually being sent. It is FILE BYTES and
	// says so: the ceiling is enforced on the multipart body, which adds ~156 bytes
	// plus the filename per part, and a reader who mistook this line for the
	// measured quantity would not understand a refusal that names a larger number.
	const contentBytes = files.reduce((sum, f) => sum + f.content.length, 0);

	logger.info(
		`   ${dirName}: ${files.length} ${files.length === 1 ? 'file' : 'files'}, `
		+ `${formatBytes(contentBytes)} of file content, title="${displayTitle}"`,
	);
	for (const excluded of collected.excluded) {
		logger.info(`   Excluded from upload: ${excluded} (never published with a skill)`);
	}
	// The SAME merge `declaredTestInputPaths` read to find the eval suite — both
	// resolutions are served from `loadConfigCached` and the per-root discovery
	// cache, so asking twice costs one map lookup rather than a second walk-up.
	// Resolved HERE rather than plumbed out of `collectSkillUploadFiles`, which is
	// exported and deliberately resolves its own so no caller can hand it a config
	// with the exclusion skipped.
	const packaging = await resolveSkillPackagingConfig(skillMdPath);
	warnUnportableReferences(files, dirName, packaging?.validation, logger);

	return { displayTitle, files, dirName };
}

/**
 * Warn about references in the bundle that cannot resolve once it is published.
 *
 * 🚨 **Until this existed, `install` validated NOTHING.** It weighed the request
 * and sent it; every check VAT owns — the non-portable reference family, the
 * unqualified MCP tool names, the non-portable command family — ran in
 * `vat audit` and `vat skills build` and never on the one path where content
 * leaves the machine. An adopter found the consequence directly: of 54 built
 * skills, 10 referenced paths outside their own directory, one of them exec'ing
 * a script under a SIBLING skill. Under the Skills API each skill is its own
 * top-level tree with no siblings, so those uploaded with a green tick and could
 * not possibly run. "It uploaded" is not "it works", and the publish command was
 * the only lane in a position to say so before the bytes left.
 *
 * ⚠️ **Warns, never refuses.** These are `warning`-severity codes and the
 * operator may have reasons VAT cannot see; turning a publish into an exit 2 on
 * a heuristic is a worse failure than the one being reported. Blocking belongs
 * to `vat skills build` and `vat audit`, which run before this and can gate CI.
 *
 * Costs nothing extra: it reads the buffers already collected for the upload, so
 * no file is opened twice and nothing is walked again.
 *
 * 🚨 **The three collectors are RAW issue producers, and raw issues are not what
 * an adopter agreed to see.** Everywhere else in VAT they pass through
 * {@link runValidationFramework}, which applies `validation.allow` waivers and
 * `validation.severity` overrides. Printed unfiltered, this lane contradicted
 * VAT's own documented remedy: `MCP_TOOL_NAME_UNQUALIFIED` tells authors to
 * "waive that one identifier with a `validation.allow` entry", and an author who
 * did exactly that got a green `vat skills build` and then the same warning on
 * every publish with nothing left to silence it with.
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
	for (const issue of issues) {
		logger.warn(`     ${issue.location ?? ''}: ${issue.message}`);
	}
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
 * ⛔ It is NOT true that a changed name "silently re-roots" the version — this
 * comment and the command's help both said so, and the measurement says
 * otherwise: the SERVER enforces SKILL.md name consistency per `skill_id`, so
 * publishing from a renamed tree earns a loud 400. That is a better outcome than
 * the one the warning described, and it is the one refusal this endpoint can
 * earn, so it gets a remedy ({@link VERSION_NAME_MISMATCH_REFUSAL}) rather than
 * the bare vendor sentence it used to get.
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
	// The duplicate-title 400 is unreachable here — `versions add` sends no
	// `display_title` — but the NAME refusal is not: the server enforces SKILL.md
	// name consistency per skill_id, so publishing from a tree whose frontmatter
	// `name` has changed is a 400, and it is the one refusal this endpoint can
	// earn. It got no remedy at all until the reviewer who read the log line above
	// pointed out that the line describes silent behaviour the server forbids.
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
 * `--from-npm` publishes to an org, and the whole `--from-npm` path was
 * untested — `packages/cli/src/commands/**` is coverage-excluded, so nothing in
 * any report said so.
 */
export function listNodeModulePackages(nodeModulesDir: string): string[] {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
	if (!existsSync(nodeModulesDir)) return [];

	const results: string[] = [];
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith('@')) {
			const scopeDir = safePath.join(nodeModulesDir, entry.name);
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
			for (const scopedEntry of readdirSync(scopeDir, { withFileTypes: true })) {
				if (scopedEntry.isDirectory()) results.push(safePath.join(scopeDir, scopedEntry.name));
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
	const direct = safePath.join(packageDir, 'dist', 'skills');
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
	if (existsSync(direct)) return direct;

	const candidates = listNodeModulePackages(safePath.join(packageDir, 'node_modules'));
	for (const pkgDir of candidates) {
		const candidate = safePath.join(pkgDir, 'dist', 'skills');
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
		if (existsSync(candidate)) return candidate;
	}

	return undefined;
}

/** One skill the batch could not publish, and why. */
export interface SkillUploadFailure {
	readonly skill: string;
	readonly error: string;
}

/** The document `install --from-npm` publishes. */
export interface NpmInstallSummary {
	source: string;
	skillsUploaded: number;
	skillsFailed?: number;
	errors?: readonly SkillUploadFailure[];
	skills: readonly SkillUploadResult[];
}

/**
 * The batch's report, tagged as a failure when ANY skill did not publish.
 *
 * 🔑 Partial success is a failure. The old code returned this document plainly,
 * so `executeOrgCommand` stamped `status: success` on it and exited 0 — a run in
 * which all three skills were rejected printed `skillsUploaded: 0 /
 * skillsFailed: 3` under `status: success`, and a CI wrapper written as
 * `vat claude org skills install --from-npm … || fail` published nothing and
 * reported green.
 *
 * Some-succeeded is tagged the same way as none-succeeded, deliberately: the
 * workspace is now in a MIXED state that nobody asked for, which is exactly the
 * case a human has to look at. Calling it green because two of three landed is
 * the same lie, only smaller. What did land stays in the document, so the reader
 * can see how far the run got.
 */
export function summarizeNpmInstall(
	source: string,
	results: readonly SkillUploadResult[],
	errors: readonly SkillUploadFailure[],
): NpmInstallSummary | OrgCommandFailure {
	const summary: NpmInstallSummary = {
		source,
		skillsUploaded: results.length,
		...(errors.length > 0 ? { skillsFailed: errors.length, errors } : {}),
		skills: results,
	};
	return errors.length > 0 ? orgCommandFailure(summary) : summary;
}

/**
 * Upload skills from an npm package.
 */
async function installFromNpm(
	npmPackage: string,
	skillFilter: string | undefined,
	client: OrgApiClient,
	logger: UploadLogger,
): Promise<object> {
	const tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-org-skills-'));
	try {
		logger.info(`Downloading: ${npmPackage}`);
		const packageDir = downloadNpmPackage(npmPackage, tempDir);

		const skillsDir = findSkillsDir(packageDir);
		if (!skillsDir) {
			throw new Error(`No dist/skills/ directory found in ${npmPackage}. Was the package built with vat skills build?`);
		}
		logger.info(`Found skills at: ${safePath.relative(packageDir, skillsDir) || 'dist/skills/'}`);

		// eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from temp dir
		const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);

		if (skillDirs.length === 0) {
			throw new Error(`No skills found in dist/skills/ of ${npmPackage}`);
		}

		const toUpload = skillFilter
			? skillDirs.filter(name => name === skillFilter)
			: skillDirs;

		if (toUpload.length === 0) {
			throw new Error(`Skill "${String(skillFilter)}" not found in ${npmPackage}. Available: ${skillDirs.join(', ')}`);
		}

		logger.info(`Found ${toUpload.length} skill(s) to upload from ${npmPackage}`);

		const results: SkillUploadResult[] = [];
		const errors: SkillUploadFailure[] = [];

		for (const skillName of toUpload) {
			const skillDir = safePath.join(skillsDir, skillName);
			try {
				const result = await uploadSkillDir(client, skillDir, undefined, logger);
				results.push(result);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.info(`   ⚠ ${skillName}: ${msg}`);
				errors.push({ skill: skillName, error: msg });
			}
		}

		return summarizeNpmInstall(npmPackage, results, errors);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
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

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
	if (!existsSync(sourcePath)) {
		throw new Error(`Source not found: ${sourcePath}`);
	}

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
	const stat = statSync(sourcePath);

	// Case-INSENSITIVE. `endsWith('.zip')` refused `MySkill.ZIP` as "not a directory
	// or .zip file" — a file Windows and macOS both consider a zip archive, and one
	// an operator has no way to read that refusal as being about capitalisation.
	if (!stat.isDirectory() && sourcePath.toLowerCase().endsWith('.zip')) {
		return installZipArchive(sourcePath, titleOverride, client, logger);
	}

	if (!stat.isDirectory()) {
		throw new Error(`Source must be a directory or .zip file: ${sourcePath}`);
	}

	// "Packaging", not "Uploading". Everything that follows this line — reading the
	// config, collecting the file set, weighing the request — happens locally and
	// can refuse locally, and an operator who read "Uploading skill directory: X"
	// above a local size refusal was told about an upload that never started. The
	// line stays HERE rather than moving after the point of no return, because
	// naming the source before the work is what makes a failure attributable at
	// all — `--from-npm` packages several skills in a loop, and a packaging error
	// with no path above it names nothing.
	logger.info(`Packaging skill directory: ${sourcePath}`);
	return uploadSkillDir(client, sourcePath, titleOverride, logger);
}

/**
 * Publish a ZIP archive as a NEW skill.
 *
 * Split out of {@link installFromLocal} because the archive lane now has three
 * decisions of its own — an answer-key refusal, an expanded-size refusal, and a
 * title/name divergence warning — and inlining them made the dispatcher a
 * cognitively complex function whose real job (directory or archive?) was two
 * lines of it.
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
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
	const zipContent = readFileSync(sourcePath);
	const files: MultipartFile[] = [{
		fieldName: 'files[]',
		filename: basename(sourcePath),
		content: zipContent,
	}];
	// A ZIP is by construction a single large binary, so this is the shape most
	// likely to be over the ceiling — and the one that reached the wire unmeasured
	// while the check lived only in the directory-packaging path. It is gated in
	// `sendSkillUpload` below, on the same measure (the multipart body) as every
	// other shape; this line reports the file's own bytes, which are smaller.
	//
	// "Preparing", not "Uploading": nothing has been sent at this point, and the
	// very next step can refuse locally. A line that claims an upload started is
	// the log telling the operator about work that never happened.
	logger.info(`Preparing ZIP: ${sourcePath} (${formatBytes(zipContent.length)} of file content)`);
	// Where the title came FROM, not just what it is. A ZIP's title is the
	// filename — `wiki-lint-v2.zip` publishes a skill called `wiki-lint-v2`,
	// which is a DIFFERENT skill from `wiki-lint` and is not refused, because
	// display_title uniqueness is enforced only when the field is sent. A
	// directory takes its title from SKILL.md instead, so the same tree zipped
	// and unzipped can publish under two names.
	//
	// ⛔ This comment used to end "VAT cannot read the SKILL.md inside the
	// archive: Node ships no ZIP reader, and adding a dependency to parse one
	// here would mean owning central-directory, zip64 and zip-slip handling for
	// a log line." The PREMISE was false — `adm-zip` is already a runtime
	// dependency of this package — and the cost/benefit was weighed against the
	// wrong benefit: the same read also answers whether the archive EXPANDS
	// past the ceiling, which is a refusal, not a log line. So the archive is
	// now read (see {@link inspectZipArchive}) and the divergence is reported
	// as a fact below, in addition to this provenance line.
	logger.info(`Display title: "${displayTitle}" (${titleOverride === undefined
		? 'from the ZIP filename — NOT from the SKILL.md inside it; pass --title to set it'
		: 'from --title'})`);

	const inspected = await inspectZipArchive(sourcePath);
	if (inspected !== undefined) {
		// 🚨 REFUSED, not warned. The directory lane refuses an answer key
		// unconditionally (`NEVER_UPLOADED_DIR_NAMES`, plus whatever the config
		// declares), and until this existed the ZIP lane bypassed `collectFiles`
		// entirely and posted the archive as one opaque part — so
		// `zip -r my-skill.zip my-skill/` over a tree holding
		// `my-skill/evals/evals.json` published the answer key org-wide with a
		// green tick, while `install my-skill/` on the very same tree refused.
		// Two lanes of one command must not disagree about whether a skill's
		// answer key may be published, and a warning is a disagreement.
		//
		// This lane can only see the CONVENTIONAL names: there is no skill
		// directory to walk up from, so a config-declared suite location is
		// unreadable here. That is a narrower check than the directory lane's,
		// not a looser verdict on what it does see.
		if (inspected.neverUploaded.length > 0) {
			throw new Error(
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
			throw new Error(
				`ZIP expands to ${formatBytes(inspected.uncompressedBytes)}, over the `
				+ `${formatBytes(API_SKILL_MAX_UPLOAD_BYTES)} ceiling. The API expands the archive and `
				+ `weighs the UNCOMPRESSED total, so ${formatBytes(zipContent.length)} on the wire does not `
				+ `get this under the limit — it will refuse with "Zip file uncompressed size exceeds 30MB". `
				+ `Remove files from the bundle; compressing harder cannot help.`,
			);
		}
		// The title/name divergence this branch discloses above, now stated as a
		// FACT rather than as a caveat, because the archive can be read after
		// all. A ZIP whose inner SKILL.md declares a different name publishes a
		// skill whose title and versions disagree — and that divergence is what
		// makes a title-keyed lookup unsafe, so it is worth naming at the moment
		// it is minted rather than diagnosing later.
		if (inspected.declaredName !== undefined && inspected.declaredName !== displayTitle) {
			logger.warn(
				`Title/name divergence: this uploads with display title "${displayTitle}", but the `
				+ `SKILL.md inside declares name "${inspected.declaredName}". Every version will carry `
				+ `the declared name. Pass --title "${inspected.declaredName}" to make them agree.`,
			);
		}
		// 🚨 The SAME function the directory lane calls, over the archive's own
		// markdown. Until this line existed, `install <zip>` ran NONE of the
		// portability checks its `--help` promises of "every markdown document in
		// the bundle" — the archive went straight to `sendSkillUpload`, so the
		// adopter finding that produced the family (10 of 54 skills referencing a
		// path outside their own tree, published green and unable to run) was
		// invisible on the lane most likely to carry a hand-built bundle.
		//
		// ⚠️ NO validation config, and that is a real narrowing, stated in the
		// help text. `validation.allow` / `validation.severity` are resolved by
		// walking up from a skill's SKILL.md to its governing project — and an
		// archive member has no path on disk to walk up from, the same reason a
		// config-declared eval-suite location is unreadable here. So a waiver that
		// silences `vat skills build` does NOT silence this lane. The checks only
		// warn, so the cost of the narrowing is noise, never a blocked publish;
		// the cost of skipping them was silence on a documented promise.
		warnUnportableReferences(inspected.documents, inspected.bundleRoot, undefined, logger);
	}

	return sendSkillUpload(client, displayTitle, files);
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
 * 🚨 **One refusal is a fact about ONE version.** This loop used to return on the
 * first one, so every version after it was never ATTEMPTED — not failed, not
 * reported, unexamined. Deleting a workspace skill requires deleting every
 * version first, so the operator was left with a skill that could not be deleted,
 * a report that named one problem out of an unknown number, and no way to tell
 * from the output which versions were still there. A transient refusal on version
 * 2 of 30 hid the state of the other 28.
 *
 * The sweep therefore ATTEMPTS all of them and reports both lists. The caller
 * decides what the outcome means: some deleted plus some failed is a run that
 * happened and went wrong (exit 1, with the record); nothing deleted at all is
 * the ending the command's help documents as exit 2.
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
	for (const version of versions) {
		try {
			await client.deleteSkillVersion(skillId, version);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({ version, reason });
			logger.info(`   ⚠ version ${version} was not deleted: ${reason}`);
			continue;
		}
		deleted.push(version);
		logger.info(`   Deleted version ${version}`);
	}
	return { deleted, failures };
}

/**
 * Every version the sweep could not delete, and why — the one sentence both the
 * published report and the exit-2 throw are built from, so the two endings never
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
	readonly error: string;
}

/**
 * The document a `--all` run publishes when it destroyed something and then did
 * not finish.
 *
 * 🔑 The deleted list is a RECORD, not a progress counter. Version deletion is
 * irreversible, so a failure part-way through leaves a workspace nobody can
 * reconstruct — and throwing here would end on `handleCommandError`'s exit 2
 * ("the run could not happen") and DISCARD the document. It happened, and it
 * destroyed things the operator now has no other list of. So the lists travel
 * with the failure and the run ends 1: it happened, and its outcome is wrong.
 *
 * `failedVersions` is the other half, and the half a re-run needs: what is still
 * there. Without it the operator knows what they lost and not what they still
 * have to deal with.
 */
export function reportHalfDeleted(report: HalfDeletedReport): OrgCommandFailure {
	const { skillId, deletedVersions, failedVersions } = report;
	return orgCommandFailure({
		id: skillId,
		deleted: false,
		deletedVersions,
		failedVersions,
		error: report.error,
		note:
			`${String(deletedVersions.length)} version(s) of ${skillId} were deleted and cannot be `
			+ `restored; ${String(failedVersions.length)} could not be deleted and are still there. `
			+ 'The skill itself still exists — the API refuses a skill that still has versions. '
			+ 'Re-run `--all` once the cause is cleared: it will attempt only what is left.',
	});
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
			await executeOrgCommand('OrgSkillsList', options.debug, async ({ client }) => {
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
			const commandName = options.fromNpm ? 'OrgSkillsInstallNpm' : 'OrgSkillsInstall';
			await executeOrgCommand(commandName, options.debug, async ({ client, logger }) => {
				// INSIDE the action, like `versions add`'s own guards. Thrown from the
				// Commander handler instead, these were a floating rejection that
				// reached no catch: Node printed a raw stack trace with absolute $HOME
				// paths, wrote nothing to the stdout this command's help promises, and
				// exited 1 — which the documented contract reads as "at least one
				// error-severity finding" for a run in which nothing executed.
				if (!source && !options.fromNpm) {
					throw new Error('Provide a <source> path or use --from-npm <package>');
				}
				if (source && options.fromNpm) {
					throw new Error('Provide either <source> or --from-npm, not both');
				}
				// The other two illegal combinations, refused rather than dropped. Both
				// flags used to be accepted and silently ignored on the lane that cannot
				// honour them, which is how an operator gets a skill published under the
				// wrong title — or every skill in a package published when they named one.
				if (options.title !== undefined && options.fromNpm) {
					throw new Error(
						'--title applies to a single skill and --from-npm can publish several, so it is '
						+ 'refused here rather than silently ignored. Publish the one skill with '
						+ '--skill and set its title in its SKILL.md, or upload its directory directly.',
					);
				}
				if (options.skill !== undefined && !options.fromNpm) {
					throw new Error('--skill selects one skill inside an npm package; it applies only with --from-npm');
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
  "my-skill" and is not refused as a duplicate. VAT reads the SKILL.md nearest
  the root of the archive and WARNS when the name it declares differs from that
  title, because every version the skill ever gets will carry the declared name.
  Pass --title to set the title explicitly.

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
  1 - The run completed and at least one skill failed to upload (--from-npm
      uploads several; the ones that landed are listed under skills)
  2 - The run could not happen: no API key, no such source, unusable input

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
			await executeOrgCommand('OrgSkillsDelete', options.debug, async ({ client, logger }) => {
				// Every version this run actually destroyed, accumulated as it goes.
				//
				// 🔑 It is a RECORD, not a progress counter. Version deletion is
				// irreversible and `--all` does it in a loop, so a failure part-way
				// through leaves a workspace nobody can reconstruct — and the old code
				// threw at that point, which ends on `handleCommandError`'s exit 2
				// ("the run could not happen") and DISCARDS the document. It happened,
				// and it destroyed things the operator now has no list of. So the list
				// travels with the failure, and the run ends 1: it happened, and its
				// outcome is wrong.
				const deletedVersions: string[] = [];
				const halfDeleted = (error: unknown, failedVersions: readonly string[]): OrgCommandFailure =>
					reportHalfDeleted({
						skillId,
						deletedVersions,
						failedVersions,
						error: error instanceof Error ? error.message : String(error),
					});

				if (options.all) {
					const versions = await autopaginateSkills(client, skillVersionsPath(skillId));
					const versionData = versions.data as Array<{ id: string; version: string }>;
					// "Found …", not "Deleting …": nothing has been deleted at this point
					// and the very next call can be refused. Cf. `installFromLocal`.
					logger.info(`Found ${String(versionData.length)} version(s) of ${skillId} to delete first`);
					// ATTEMPTS every version, whatever any one of them answers. See
					// `deleteEveryVersion`: returning on the first refusal left the rest
					// unexamined, and the skill undeletable with no record of what remained.
					const sweep = await deleteEveryVersion(client, skillId, versionData.map(v => v.version), logger);
					deletedVersions.push(...sweep.deleted);
					if (sweep.failures.length > 0) {
						const detail = describeVersionSweepFailures(sweep.failures);
						// Nothing was destroyed, so there is no record worth publishing and
						// "could not happen" (exit 2, via the throw) is the honest ending —
						// the same rule as before, now decided on the WHOLE sweep rather than
						// on its first refusal.
						if (deletedVersions.length === 0) {
							throw new Error(
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
  listed under deletedVersions, the ones still there under failedVersions, and
  the run exits 1 — the run happened, and its outcome is wrong. The skill itself
  is then left alone, because the API refuses a skill that still has versions.
  It exits 2 only when nothing was deleted at all.

  A version delete whose response is lost is replayed, and the replay is answered
  404 because the first attempt already removed it. That 404 is read as the
  delete it is, not as a failure — the version appears under deletedVersions.

Exit Codes:
  0 - The skill was deleted
  1 - The run completed and the skill was NOT deleted: the API named a different
      outcome, or --all destroyed some versions and could not destroy the rest
  2 - The run could not happen: no API key, the first request was refused, or
      --all deleted no version at all

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
			await executeOrgCommand('OrgSkillsVersionsList', options.debug, async ({ client }) => {
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
			await executeOrgCommand('OrgSkillsVersionsDelete', options.debug, async ({ client, logger }) => {
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
  1 - The run completed and the API named an outcome other than a deletion
  2 - The run could not happen: no API key, or the request was refused

Example:
  $ vat claude org skills versions delete skill_abc123 1775007400733130
`);

	const versionsAddCmd = new Command('add');
	versionsAddCmd
		.description('Publish a new version of an existing skill')
		.argument(SKILL_ID_ARG, SKILL_ID_DESC)
		// NOT "or ZIP file", which is what this said when it was copied from
		// `install`: the guard below refuses anything that is not a directory, so the
		// help promised an input the command rejects. Narrowing the promise rather
		// than widening the code is the honest fix — a ZIP posted to
		// POST /v1/skills/{id}/versions has never been tried against the live API, and
		// this is not the place to find out by guessing.
		.argument('<source>', 'Path to a built skill directory')
		.option('--debug', DEBUG_OPT_DESC)
		.action(async (skillId: string, source: string, options: { debug?: boolean }) => {
			await executeOrgCommand('OrgSkillsVersionsAdd', options.debug, async ({ client, logger }) => {
				const resolved = resolveSourceArgument(source);
				// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
				if (!existsSync(resolved)) throw new Error(`Source not found: ${resolved}`);
				// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from CLI arg
				if (!statSync(resolved).isDirectory()) {
					// Name the asymmetry IN the refusal, not only in --help. `install`
					// accepts a ZIP and this verb does not, so the operator most likely to
					// hit this is the one who just read that `install` takes one — and a
					// refusal that says only "must be a directory" reads as a bug in their
					// path, not as a difference between two verbs.
					const zipHint = resolved.toLowerCase().endsWith('.zip')
						? ' A ZIP is accepted by `vat claude org skills install`, not here:'
							+ ' publish a new version from the built skill directory instead.'
						: '';
					throw new Error(`Source must be a skill directory: ${resolved}.${zipHint}`);
				}
				// "Packaging", not "Publishing" — see `installFromLocal`. Measured: this
				// line printed, then `Failed to load config: …`, and nothing had been
				// sent. The announcement now describes the step it actually precedes.
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
  2 - The run could not happen: no API key, no such source, not a directory,
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
