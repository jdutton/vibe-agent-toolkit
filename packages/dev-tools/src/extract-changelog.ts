#!/usr/bin/env tsx
import { readFileSync, existsSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

import { log } from './common.js';

function extractChangelog(version: string): string {
  const changelogPath = safePath.join(process.cwd(), 'CHANGELOG.md');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from cwd and constant CHANGELOG.md filename
  if (!existsSync(changelogPath)) {
    log('✗ CHANGELOG.md not found', 'red');
    process.exit(1);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same validated changelogPath as existsSync above
  const content = readFileSync(changelogPath, 'utf-8');
  const versionHeader = `## [${version}]`;
  const lines = content.split('\n');

  let startIndex = -1;
  let endIndex = -1;

  for (const [i, line] of lines.entries()) {
    if (!line) continue;

    if (line.startsWith(versionHeader)) {
      startIndex = i;
    } else if (startIndex !== -1 && line.startsWith('## [')) {
      endIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    log(`✗ Version ${version} not found in CHANGELOG.md`, 'red');
    process.exit(1);
  }

  if (endIndex === -1) {
    endIndex = lines.length;
  }

  const excerpt = lines.slice(startIndex + 1, endIndex).join('\n').trim();
  return excerpt;
}

const version = process.argv[2];
if (!version) {
  console.error('Usage: extract-changelog.ts <version>');
  process.exit(1);
}

const changelog = extractChangelog(version);
console.log(changelog);
