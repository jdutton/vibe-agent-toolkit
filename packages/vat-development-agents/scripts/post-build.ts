#!/usr/bin/env node
/**
 * Post-build script - Copy generated resources to dist
 * Uses the resource-compiler utility for cross-platform copying
 */

import { createPostBuildScript } from '@vibe-agent-toolkit/resource-compiler/utils';

createPostBuildScript({
  generatedDir: 'generated',
  distDir: 'dist',
  verbose: true,
  // Eval fixtures are test input for vat-audit/vat-skill-review, not distributed
  // skill content (mirrors the resources.exclude entry in this package's
  // vibe-agent-toolkit.config.yaml) — keep them out of the published package.
  exclude: ['resources/skills/evals'],
});
