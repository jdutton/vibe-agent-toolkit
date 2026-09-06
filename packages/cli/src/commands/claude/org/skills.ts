/**
 * `vat claude org skills` — manage organization skills via Skills API.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import {   basename } from 'node:path';

import {
  API_SKILL_MAX_UPLOAD_BYTES,
  describeOversizeBundle,
  evalSuiteUnitPath,
  formatBytes,
  NEVER_UPLOADED_DIR_NAMES,
  readDeclaredSkillName,
} from '@vibe-agent-toolkit/agent-skills';
import {
  ApiRequestError,
  buildMultipartFormData,
  skillVersionsPath,
} from '@vibe-agent-toolkit/claude-marketplace';
import type {
  MultipartFile,
  MultipartResult,
  OrgApiClient,
} from '@vibe-agent-toolkit/claude-marketplace';
import {
  isAbsoluteAnyPlatform,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
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
 * must not paper over.
 */
export function readDeleteResponse(
	raw: unknown,
	requestedId: string,
	expectedType: string,
): SkillDeleteResult {
	const body: Record<string, unknown> =
		typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
	const echoedId = body['id'];
	const type = body['type'];
	return {
		id: typeof echoedId === 'string' && echoedId.length > 0 ? echoedId : requestedId,
		deleted: typeof type === 'string' ? type === expectedType : true,
	};
}

/** Read `POST /v1/skills/{id}/versions`. */
export function readSkillVersionResponse(raw: unknown): SkillUploadResult {
	return readSkillUploadResponse('POST /v1/skills/{id}/versions', raw, {
		id: 'skill_id', displayTitle: 'name', version: 'version', createdAt: 'created_at',
	});
}

/**
 * Build the multipart request body for an upload, refusing it before anything is
 * sent when THAT BODY is at or over the API's upload ceiling.
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
): MultipartResult {
	const multipart = buildMultipartFormData(fields, [...files]);
	if (multipart.body.length >= API_SKILL_MAX_UPLOAD_BYTES) {
		const sized = files.map(f => ({ path: f.filename, bytes: f.content.length }));
		const measure = { of: 'upload-request' as const, bytes: multipart.body.length };
		throw new Error(`${describeOversizeBundle(sized, measure)}. The API will refuse this upload.`);
	}
	return multipart;
}

/**
 * The remedy for the one vendor refusal that has a specific next command.
 *
 * It tells the operator how to FIND the id and does not offer to find it for
 * them: `display_title` is unique only when the field is sent explicitly, so a
 * workspace can hold several skills of one title and a title→id lookup matches
 * none, one, or several. Appending a version to the wrong match is silent and
 * destroys somebody else's skill, so the id is always the operator's to supply.
 */
const DUPLICATE_TITLE_REMEDY =
	'This workspace already has a skill with that display title, and `install` only ever CREATES. '
	+ 'To ship a change to that skill, add a version to it: find its id with '
	+ '`vat claude org skills list`, then run '
	+ '`vat claude org skills versions add <skill-id> <source>`. '
	+ 'VAT will not turn the title into an id for you — display_title is not unique in general '
	+ '(the API enforces it only when the field is sent), so a title can match none, one, or '
	+ 'several skills. To create a genuinely separate skill instead, pass a different --title.';

/**
 * A failed create, re-thrown with the command that answers it when — and only
 * when — the API said the display title is taken.
 *
 * **What is matched, exactly:** an {@link ApiRequestError} whose `statusCode` is
 * 400, whose message names `display_title`, and which also carries a
 * reuse/duplicate word. The live API's wording is
 * `400 Skill cannot reuse an existing display_title`, measured; all three
 * conditions must hold.
 *
 * **How it fails safe:** anything that does not match is returned UNTOUCHED, so
 * an unrelated 400 keeps the API's exact words and gets no misleading remedy. If
 * the vendor rewords the refusal, the operator loses a hint — they never gain a
 * wrong one. The remedy is appended, never substituted, so the vendor's sentence
 * survives in full.
 *
 * Only the CREATE path is wrapped. `versions add` sends no `display_title` at
 * all, and the uniqueness rule is a property of that field being sent — so this
 * refusal is unreachable there, and suggesting `versions add` to somebody already
 * running it would be nonsense.
 */
export function withDuplicateTitleRemedy(error: unknown): unknown {
	if (!(error instanceof ApiRequestError) || error.statusCode !== 400) return error;
	if (!/display_title/i.test(error.message)) return error;
	if (!/reuse|already|exist|duplicat|unique/i.test(error.message)) return error;
	return new ApiRequestError(
		`${error.message}\n${DUPLICATE_TITLE_REMEDY}`,
		error.statusCode,
		error.retryAfterHeader,
	);
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
async function sendSkillUpload(
	client: OrgApiClient,
	displayTitle: string,
	files: MultipartFile[],
): Promise<SkillUploadResult> {
	const multipart = buildUploadBodyOrRefuse({ display_title: displayTitle }, files);
	try {
		return readCreateSkillResponse(await client.uploadSkill<unknown>(multipart));
	} catch (error) {
		throw withDuplicateTitleRemedy(error);
	}
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
 * A symlinked directory is REFUSED rather than skipped or followed. Skipping it
 * would change what gets published without the skill breaking until someone
 * opens it — and the one thing this collector guarantees is that every
 * withholding is reported. Following it would send bytes the build-time size
 * check never weighed (that walk does not descend a linked directory either),
 * re-opening the very divergence the shared exclusion set closed. There is no
 * third option: a multipart body has no way to express a link, so refusing and
 * naming the path is the only answer that is both complete and honest.
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
		} else if (linkedDirectory) {
			throw new Error(
				`Cannot upload ${relativePath}: it is a symbolic link to a directory, which a `
				+ 'multipart upload cannot express. Replace it with a real copy of the directory, '
				+ 'or remove it.',
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
		`   ${dirName}: ${files.length} files, ${formatBytes(contentBytes)} of file content, `
		+ `title="${displayTitle}"`,
	);
	for (const excluded of collected.excluded) {
		logger.info(`   Excluded from upload: ${excluded} (never published with a skill)`);
	}

	return { displayTitle, files, dirName };
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
	const { displayTitle, files } = await prepareSkillUpload(skillDir, titleOverride, logger);
	return sendSkillUpload(client, displayTitle, files);
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
 * measured, and guessing at one is how you append to the wrong thing. So the
 * root is REPORTED rather than enforced — publishing from a tree whose
 * frontmatter `name` has changed since the last version silently re-roots that
 * version's file tree, and the log line below is what lets an operator notice
 * before they wonder why the skill stopped finding its own files.
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
		+ 'Earlier versions of this skill used whatever their own tree declared.',
	);
	// No `display_title` field: this version belongs to a skill that already has a
	// title, and sending one here would be an attempt to rename by side effect.
	// Its absence also changes the body's length, which is why the ceiling is
	// weighed on the body this endpoint sends rather than on the one `install` builds.
	const multipart = buildUploadBodyOrRefuse({}, files);
	return readSkillVersionResponse(await client.uploadSkillVersion<unknown>(skillId, multipart));
}

/**
 * List candidate package directories in node_modules (scoped + unscoped).
 */
function listNodeModulePackages(nodeModulesDir: string): string[] {
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
function findSkillsDir(packageDir: string): string | undefined {
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

	if (!stat.isDirectory() && sourcePath.endsWith('.zip')) {
		const displayTitle = titleOverride ?? basename(sourcePath, '.zip');
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
		logger.info(`Uploading ZIP: ${sourcePath} (${formatBytes(zipContent.length)} of file content)`);
		logger.info(`Display title: ${displayTitle}`);

		return sendSkillUpload(client, displayTitle, files);
	}

	if (!stat.isDirectory()) {
		throw new Error(`Source must be a directory or .zip file: ${sourcePath}`);
	}

	logger.info(`Uploading skill directory: ${sourcePath}`);
	return uploadSkillDir(client, sourcePath, titleOverride, logger);
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

  The skill uploads under the "name" its SKILL.md frontmatter declares, which
  is also the default display_title.

  A skill's eval suite is its answer key and is never uploaded: whatever the
  governing vibe-agent-toolkit.config.yaml declares as this skill's test input
  (skills.config.<name>.test.evals) is withheld, and so is any evals/ directory
  when no config is discoverable. node_modules/ and .git/ are never uploaded
  either. Each exclusion is reported in the output.

  An upload is refused before anything is sent when it would reach the API's
  30 MiB ceiling. What is weighed is the multipart REQUEST — the file bytes plus
  about 156 bytes of framing per file — because that is what the API measures.
  A directory and a ZIP go through that same gate.

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
				if (options.all) {
					// Fetch and delete all versions first
					const versions = await autopaginateSkills(client, skillVersionsPath(skillId));
					const versionData = versions.data as Array<{ id: string; version: string }>;
					logger.info(`Deleting ${versionData.length} version(s) of ${skillId}`);
					for (const ver of versionData) {
						await client.deleteSkillVersion(skillId, ver.version);
						logger.info(`   Deleted version ${ver.version}`);
					}
				}

				logger.info(`Deleting skill: ${skillId}`);
				return readDeleteResponse(
					await client.deleteSkill<unknown>(skillId), skillId, 'skill_deleted',
				);
			});
		})
		.addHelpText('after', `
Description:
  Deletes a skill from the organization. Uses the Skills API (beta).
  Use --all to auto-delete all versions before the skill.
  Requires ANTHROPIC_API_KEY (regular key, not admin key).

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
				return readDeleteResponse(
					await client.deleteSkillVersion<unknown>(skillId, version),
					skillId,
					'skill_version_deleted',
				);
			});
		})
		.addHelpText('after', `
Description:
  Deletes a specific version of a skill. Uses the Skills API (beta).
  All versions must be deleted before a skill can be deleted.
  Requires ANTHROPIC_API_KEY.

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
					throw new Error(`Source must be a skill directory: ${resolved}`);
				}
				logger.info(`Publishing new version of ${skillId} from: ${resolved}`);
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

  The same exclusions and the same 30 MiB request ceiling as \`install\` apply: the
  eval suite, node_modules/ and .git/ are never uploaded.

  The uploaded files are keyed under the top-level directory named by this
  tree's SKILL.md \`name\`, and that root is printed as the upload runs. Publish
  from a tree whose name has changed since the last version and the new version's
  files sit under a different root than every earlier one — this command reports
  the root it used but cannot check it against versions it did not create.

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
