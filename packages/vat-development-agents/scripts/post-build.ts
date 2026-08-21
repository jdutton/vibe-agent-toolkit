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
  // skill content — keep them out of the published package.
  //
  // This literal is a MANUAL DUPLICATE of the resources.exclude entry
  // ("**/resources/skills/evals/**") in this package's
  // vibe-agent-toolkit.config.yaml, not read from it: copyResources() only
  // matches an exact/nested-prefix relative path, not a glob, and
  // vibe-agent-toolkit.config.yaml is loaded async (loadConfig() from
  // @vibe-agent-toolkit/resources) while this script's copy step is sync.
  // If that config's exclude list ever changes, update this one to match.
  exclude: ['resources/skills/evals'],
});
