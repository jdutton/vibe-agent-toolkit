#!/usr/bin/env tsx
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './common.js';

function extractChangelog(version: string): string {
  const changelogPath = join(process.cwd(), 'CHANGELOG.md');

  if (!existsSync(changelogPath)) {
    log('✗ CHANGELOG.md not found', 'red');
    process.exit(1);
  }

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
