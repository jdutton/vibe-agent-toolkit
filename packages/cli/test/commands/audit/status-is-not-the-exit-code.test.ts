/**
 * `vat audit` publishes TWO verdicts, and says so where a consumer will read it.
 *
 * 🔑 **The contract, stated once so it stops being a surprise.** `status` in the
 * report describes the FINDINGS. The exit code describes whether the RUN
 * completed. On a tree with errors that is `status: error` beside exit `0`, and
 * measured on `packages/agent-skills/test/fixtures/skill-files` it is exactly
 * that pair. Both are correct and both are worth publishing — but `status` means
 * something else in every other command of this CLI, where it moves with the exit
 * code, so a reader is entitled to be told.
 *
 * The reader was NOT told. The command's stderr wording was reconciled — "Audit
 * failed" became "Audit found N file(s) with errors — advisory, exit 0" — and a
 * comment beside it claimed the three signals had been brought into agreement.
 * Two of the three had. The DOCUMENT still says `error` where the process says
 * success, and neither `--help` nor the audit reference mentioned it, so the one
 * signal a CI script actually parses was the one nothing explained.
 *
 * Hence this suite asserts on the DOCUMENTATION rather than on behaviour. The
 * behaviour is correct and already pinned elsewhere; what regressed is whether
 * anyone is told. Anchors are chosen to be the words a confused operator would
 * search for — `status: error`, `exit`, `0` — not a paraphrase that could be
 * reworded into meaninglessness while still matching.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { createAuditCommand } from '../../../src/commands/audit.js';
import { renderCommandHelp } from '../../help-text-helpers.js';

const AUDIT_DOC = safePath.resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/audit.md',
);

/**
 * The two surfaces that owe the reader this contract, and the text of each.
 *
 * `--help` is what an operator reaches for at the terminal; the reference doc is
 * what they reach for after the help. A reader who meets `status: error` beside
 * exit 0 will consult one or the other, so both must answer — which is why this
 * is a table rather than two copies of the same assertions.
 */
const SURFACES: readonly (readonly [string, () => string])[] = [
  ['vat audit --help', () => renderCommandHelp(createAuditCommand())],
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path built from this file's own location
  ['packages/cli/docs/audit.md', () => readFileSync(AUDIT_DOC, 'utf8')],
];

describe('vat audit documents that `status` is not the exit code', () => {
  it.each(SURFACES)('%s shows the pair a reader actually meets', (_name, read) => {
    // The literal spelling from the document, so the search that brings a reader
    // here matches. A surface that only says "status" in the abstract has not
    // addressed the case that confuses them.
    expect(read()).toContain('status: error');
  });

  it.each(SURFACES)('%s says what each of the two verdicts answers', (_name, read) => {
    const text = read().toLowerCase();

    // `status` is about findings...
    expect(text).toContain('findings');
    // ...and the exit code is about the run, which for this command is always 0.
    expect(text).toContain('exit 0');
  });
});
