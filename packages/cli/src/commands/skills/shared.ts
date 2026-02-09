/**
 * Shared utilities for skills commands
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { VatSkillMetadata } from '@vibe-agent-toolkit/agent-schema';

import type { createLogger } from '../../utils/logger.js';

/**
 * Package.json with VAT skill metadata
 */
export interface PackageJson {
	name?: string;
	vat?: {
		skills: VatSkillMetadata[];
	};
}

/**
 * Read and parse package.json from current directory
 */
export async function readPackageJson(cwd: string): Promise<PackageJson> {
	const packageJsonPath = join(cwd, 'package.json');

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- Reading from validated current directory
	if (!existsSync(packageJsonPath)) {
		throw new Error(`package.json not found in current directory: ${cwd}`);
	}

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- Reading from validated current directory
	const content = await readFile(packageJsonPath, 'utf-8');
	return JSON.parse(content) as PackageJson;
}

/**
 * Validate skill source exists
 */
export function validateSkillSource(
	skill: VatSkillMetadata,
	cwd: string,
	logger: ReturnType<typeof createLogger>
): string {
	const sourcePath = resolve(cwd, skill.source);

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- Path resolved from package.json
	if (!existsSync(sourcePath)) {
		logger.error(`❌ Skill source not found: ${skill.source}`);
		logger.error(`   Expected path: ${sourcePath}`);
		process.exit(1);
	}

	return sourcePath;
}
