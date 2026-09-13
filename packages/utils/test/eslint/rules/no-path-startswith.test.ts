/**
 * `no-path-startswith` — `x.startsWith(y)` where `x` is NAMED like a path.
 *
 * A heuristic keyed on the receiver's name (`path`, `dir`, `file`, `location`)
 * and released by a `normalized` prefix or a URL-scheme / root-slash argument.
 * The VALID rows are where it earns its keep: `url.startsWith('http://')`,
 * `href.startsWith('#')` and `normalizedDir.startsWith(root)` are all shapes a
 * real tree writes constantly, and each has to stay silent.
 */

import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const NAME = 'no-path-startswith';
const ERR = [{ messageId: 'useNormalizeHelper' }];

const CASES: RuleCases = {
  valid: [
    // Receiver is not path-named.
    { code: "if (name.startsWith('x')) {}" },
    { code: "if (value.startsWith(prefix)) {}" },
    // Already normalized, by name.
    { code: 'if (normalizedPath.startsWith(root)) {}' },
    { code: 'if (resource.normalizedFilePath.startsWith(root)) {}' },
    // URL schemes and anchors need no separator normalization.
    { code: "if (filePath.startsWith('http://')) {}" },
    { code: "if (filePath.startsWith('https://x')) {}" },
    { code: "if (filePath.startsWith('file://')) {}" },
    { code: "if (dir.startsWith('/')) {}" },
    { code: "if (location.startsWith('#')) {}" },
    // A call, not a member: `startsWith(...)` as a free function.
    { code: 'if (startsWith(filePath, root)) {}' },
    // A computed receiver the rule cannot name.
    { code: "if (paths[0].startsWith('x')) {}" },
  ],
  invalid: [
    { code: 'if (filePath.startsWith(root)) {}', errors: ERR },
    { code: 'if (pluginDir.startsWith(marketplaceDir)) {}', errors: ERR },
    { code: "if (location.startsWith('src')) {}", errors: ERR },
    { code: "if (someFile.startsWith('C:')) {}", errors: ERR },
    // A member receiver with a path-named property.
    { code: 'if (resource.filePath.startsWith(root)) {}', errors: ERR },
    // Case-insensitive keyword match.
    { code: 'if (OUTPUT_PATH.startsWith(root)) {}', errors: ERR },
    // The scheme check reads the ARGUMENT: a root-slash STRING that is not
    // exactly `/` is still a path prefix.
    { code: "if (filePath.startsWith('/usr')) {}", errors: ERR },
    // `normalized` must be the PREFIX of the name, not merely present in it.
    { code: 'if (unnormalizedPath.startsWith(root)) {}', errors: ERR },
  ],
};

describe(NAME, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(NAME, CASES); });
});
