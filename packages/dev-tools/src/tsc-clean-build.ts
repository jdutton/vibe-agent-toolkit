/**
 * CLI entry for {@link ./clean-build.ts}: builds the package in the current
 * working directory. Every package's `build` script is
 * `tsx ../dev-tools/src/tsc-clean-build.ts [--compiler=<name>] [tsc args…]`.
 *
 * Unconditional on purpose — there is no "am I the entrypoint?" guard, because
 * nothing imports this file (the library beside it is what tests import), and
 * the guard this repo trusts lives in `@vibe-agent-toolkit/utils`, which this
 * script builds and therefore cannot load.
 */

import { buildPackage, parseArgs } from './clean-build.js';

const { compiler, compilerArgs } = parseArgs(process.argv.slice(2));
buildPackage(process.cwd(), compiler, compilerArgs);
