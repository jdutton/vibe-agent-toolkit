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
});
