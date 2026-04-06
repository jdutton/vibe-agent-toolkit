/**
 * Shared utilities for skills commands
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import type { createLogger } from '../../utils/logger.js';

/**
 * Package.json with VAT skill metadata
 *
 * In v0.1.16+, vat.skills is an array of skill name strings.
 * All packaging configuration now lives in vibe-agent-toolkit.config.yaml.
 */
export interface PackageJson {
	name?: string;
	vat?: {
		skills: string[];
	};
}

/**
 * Read and parse package.json from current directory
 */
export async function readPackageJson(cwd: string): Promise<PackageJson> {
	const packageJsonPath = safePath.join(cwd, 'package.json');

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- Reading from validated current directory
	if (!existsSync(packageJsonPath)) {
		throw new Error(`package.json not found in current directory: ${cwd}`);
	}

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- Reading from validated current directory
	const content = await readFile(packageJsonPath, 'utf-8');
	return JSON.parse(content) as PackageJson;
}

/**
 * Validate that a skill source file exists on disk
 *
 * @param skillPath - Absolute path to the SKILL.md file
 * @param logger - Logger instance
 * @returns The validated absolute path (same as input)
 */
export function validateSkillSourcePath(
	skillPath: string,
	logger: ReturnType<typeof createLogger>
): string {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- Path from config-driven glob discovery
	if (!existsSync(skillPath)) {
		logger.error(`Skill source not found: ${skillPath}`);
		process.exit(1);
	}

	return skillPath;
}
