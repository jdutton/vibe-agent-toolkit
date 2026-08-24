/**
 * A broken INSTALL must not be reported as a broken DOCUMENT.
 *
 * `traverseLinks` walks the skill's link graph with a per-document `try` for a
 * real reason: a skill may link a file that exists but cannot be parsed, and one
 * such file must not abort the validation of the rest. Once the markdown parser
 * started arriving by `import()`, that same catch silently acquired the LOADER's
 * failures — so a `chmod 000` on the built `link-parser.js` produced one
 * `LINK_INTEGRITY_BROKEN` per document, blamed every innocent file, never walked
 * the link graph at all, and still reported "Audit passed with warnings" at
 * exit 0. The install was broken and the command said the skills were.
 *
 * ## Why the fix is a type and not a hoist, and not an inspection either
 *
 * The two classes are NOT distinguishable by inspecting the error: Node's ESM
 * loader reads the module through `fs`, so an unloadable parser throws the same
 * `EACCES` an unreadable *document* throws. A blocklist of loader codes was
 * tried and deleted, and a test fabricating a coded error out of the parse would
 * only prove that such a blocklist matched its own members.
 *
 * Awaiting `loadParser` above the loop was tried too, and is what this suite
 * used to drive. It works and it costs too much: the load happens inside
 * `parseFileCached`, past the parse cache's hit-path return, precisely so a
 * fully warm validation loads no parser at all. Any hoist cancels that silently
 * and no test in this package can see it.
 *
 * So the load stays lazy and the catch rethrows one TYPE —
 * `ParserUnavailableError`, minted at VAT's single parser-import boundary and
 * matched by `isParserUnavailable`, which is complete by construction rather
 * than by enumeration. That the boundary really mints it is pinned in
 * `packages/resources/test/parser-unavailable-error.test.ts`, against the real
 * `import()`; what this suite owns is the attribution decision here.
 *
 * ## Why both directions are pinned
 *
 * A suite that only proved propagation would pass equally against a catch that
 * rethrew EVERYTHING — resurrecting the aborted-walk bug the catch exists to
 * prevent. The ordinary-parse-failure case below is the negative control that
 * makes the propagation evidence of a DISCRIMINATION rather than of a blanket.
 */

import type * as ResourcesModule from '@vibe-agent-toolkit/resources';
import { ParserUnavailableError } from '@vibe-agent-toolkit/resources';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ValidationResult } from '../../src/validators/types.js';
import {
  createSkillContent,
  createTransitiveSkillStructure,
  setupTempDir,
  validateSkillWithTransitiveChecking,
} from '../test-helpers.js';

/**
 * What the next `parseFileCached` call throws, or nothing.
 *
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * would otherwise close over an uninitialised binding. The parse arm is a path
 * SUBSTRING rather than a flag: the negative control has to let SKILL.md parse
 * (or nothing downstream is ever queued) while failing the documents it links,
 * which is the only shape that can show the walk continuing past a failure.
 */
const failures = vi.hoisted(() => ({ load: undefined as Error | undefined, parseFor: undefined as ParseArm }));

/** A parse failure armed for every path containing `pathContains`. */
type ParseArm = { pathContains: string; error: Error } | undefined;

// Only `parseFileCached` is replaced — the seam the lazy parser load throws
// THROUGH. Link resolution, the content-key machinery, the real parser and the
// real `isParserUnavailable` all stay live via `importOriginal`, so the walk
// under test is the one a real validation performs and the predicate under test
// is the shipped one.
vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof ResourcesModule>();
  const parseFileCached = async (filePath: string, kind: ResourcesModule.ParserKind) => {
    if (failures.load) return Promise.reject(failures.load);
    return failures.parseFor && filePath.includes(failures.parseFor.pathContains)
      ? Promise.reject(failures.parseFor.error)
      : actual.parseFileCached(filePath, kind);
  };
  return { ...actual, parseFileCached };
});

/**
 * Two linked documents, deliberately: the defect is "once per document", so a
 * skill linking a single file could not tell an aborted walk apart from one
 * recorded finding.
 */
const LINKED_FILES = {
  'linked-a.md': '# A\n\nNothing links out of here.\n',
  'linked-b.md': '# B\n\nNothing links out of here either.\n',
};

const SKILL_BODY = createSkillContent(
  { name: 'parser-load-attribution', description: 'Links two documents so the walk has more than one victim' },
  '\n# Test Skill\n\nSee [a](./linked-a.md) and [b](./linked-b.md).\n',
);

const suite = setupTempDir('skill-validator-parser-load-');

beforeEach(() => {
  failures.load = undefined;
  failures.parseFor = undefined;
});

/**
 * The failure the reproduction actually produced, as it arrives at the parse
 * site: `chmod 000` on the built parser, surfacing as the ESM loader's own `fs`
 * read failing, wrapped at VAT's import boundary.
 *
 * Built from the REAL exported class rather than hand-rolled, so a change to
 * what `isParserUnavailable` accepts cannot pass here by agreeing with a
 * fixture's idea of the type. The `EACCES` underneath is deliberate — it is
 * precisely the error an inspection-based guard could never tell apart from an
 * unreadable document, and it stays reachable only via `loaderError`.
 *
 * @returns A fresh error per test, so identity assertions are meaningful
 */
function parserLoadFailure(): Error {
  return new ParserUnavailableError(
    'markdown',
    './link-parser.js',
    Object.assign(new Error("permission denied, open '.../dist/link-parser.js'"), { code: 'EACCES' }),
  );
}

/**
 * Write the fixture skill into this test's temp directory.
 *
 * @returns The absolute path of the skill's SKILL.md
 */
function writeSkill(): string {
  return createTransitiveSkillStructure(suite.getTempDir(), LINKED_FILES, SKILL_BODY).skillPath;
}

/**
 * The `LINK_INTEGRITY_BROKEN` findings a result carries that blame the parse
 * rather than a missing target — the exact rows a loader failure used to mint.
 *
 * @param result - A completed validation
 * @returns One entry per document the walk said it could not parse
 */
function unparseableFindings(result: ValidationResult): string[] {
  return result.issues
    .filter((issue) => issue.code === 'LINK_INTEGRITY_BROKEN' && issue.message.startsWith('File exists but could not be parsed'))
    .map((issue) => issue.message);
}

describe('a parser-load failure during skill link traversal', () => {
  it('propagates instead of blaming every document in the skill', async () => {
    const thrown = parserLoadFailure();
    failures.load = thrown;
    const skillPath = writeSkill();

    // Identity, not `toThrow(message)`: what must survive is the loader's own
    // error object, because the caller's top-level handler prints its code.
    //
    // Under the defect this did not reject at all — it RESOLVED, carrying one
    // `LINK_INTEGRITY_BROKEN` per document and a status the command reported as
    // "passed with warnings" at exit 0.
    await expect(validateSkillWithTransitiveChecking(skillPath)).rejects.toBe(thrown);
  });
});

/**
 * The discriminator. Without it, a `traverseLinks` that rethrew unconditionally
 * would satisfy every assertion above — and would abandon a whole skill on one
 * unparseable linked file, which is the failure the catch exists to prevent.
 */
describe('an ordinary parse failure during skill link traversal', () => {
  it('still records one finding per document and walks the rest of the graph', async () => {
    failures.parseFor = {
      // SKILL.md keeps parsing, so both linked documents are still discovered
      // and queued; only they fail.
      pathContains: 'linked-',
      error: new Error('unexpected token'),
    };
    const skillPath = writeSkill();

    const result = await validateSkillWithTransitiveChecking(skillPath);

    // Two findings, not one: the walk did not stop at the first failure.
    expect(unparseableFindings(result)).toHaveLength(Object.keys(LINKED_FILES).length);
  });

  it('records nothing when every document parses', async () => {
    const skillPath = writeSkill();

    const result = await validateSkillWithTransitiveChecking(skillPath);

    // The baseline the two cases above are read against: with no failure armed
    // the fixture is clean, so neither finding count is an artifact of the
    // fixture itself.
    expect(unparseableFindings(result)).toEqual([]);
    expect(result.linkedFiles).toHaveLength(Object.keys(LINKED_FILES).length);
  });
});
