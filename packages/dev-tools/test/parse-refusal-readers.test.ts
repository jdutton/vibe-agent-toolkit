/**
 * Every resource crawl in `src` reports the files whose parse it refused.
 *
 * A file whose parse was stopped at a limit, or lost with its worker, is in no
 * list a `ResourceRegistry` keeps but `getParseRefusedResources()`: not
 * admitted, not unreadable, not in `getAllResources()`. A consumer that crawls
 * and never reads that log drops a pathological document from its output at
 * exit 0. Nothing in the type system makes the read happen — the log must
 * outlive the crawl, for `validate()` and for registries shared across lanes —
 * so this test holds it from the tree.
 *
 * A file that runs a crawl — `.crawl(`, `.addResources(`, `.fromCrawl(`, or a
 * call to a builder named in {@link BUILDERS} — must do one of:
 *
 * 1. read `getParseRefusedResources()` itself;
 * 2. be a builder: hand the crawled registry out through the functions it is
 *    listed with here, whose every caller is then held to this same rule;
 * 3. be listed in {@link NOT_READ_HERE}, with how its refusals still reach
 *    the user, or why it has no user to reach.
 *
 * Both tables are asserted both ways: a builder must still crawl and define its
 * functions, and a {@link NOT_READ_HERE} entry must still crawl and must
 * not read the log itself (then it needs no entry).
 *
 * Two more routes reach a parse that can be refused, each with its own read:
 *
 * - **A single-file add.** `.addResource(` THROWS a per-run refusal instead of
 *   logging it, so its caller must classify it (`isPerRunParseRefusal(`) or the
 *   refusal escapes as a raw `ParseLimitError` with no file named. Same three
 *   ways out, through {@link SINGLE_ADD_NOT_CLASSIFIED_HERE}.
 * - **A population.** A projection files a refused parse, and a file it could
 *   not read, as a condition row or an `unreadable` realization, in no list but
 *   its rows. A file that runs one — `populate(`, or a builder in
 *   {@link POPULATION_BUILDERS} — must read the rows
 *   (`describeBlobRefusals(`, `notAdmittedRealizations(`), be a listed builder,
 *   or be listed in {@link POPULATION_NOT_READ_HERE}.
 *
 * - **A direct parse.** The cached parses and the SKILL.md name readers throw a
 *   per-run refusal for one file, and `parseFrontmatter(` returns it, so a
 *   caller must report it through the one not-admitted contract every lane
 *   shares — {@link CONTRACT_READS}, a kept `parseRefusedEntryFor(` result, or a
 *   listed reporter — or be listed in {@link DIRECT_PARSE_NOT_REPORTED_HERE}. A lane-local finding built
 *   from `parseRefusal(` alone is NOT the contract: it reaches no allow list and
 *   no severity, which is how `vat okf validate` once reported its refusals.
 *
 * ⚠️ The detector is textual: a crawl reached through a name not listed here —
 * a new builder — is invisible until it is added to {@link BUILDERS} or
 * {@link POPULATION_BUILDERS}.
 */

import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';

/** The registry's own crawl entry points, called as methods. */
const CRAWL_METHODS = ['crawl', 'addResources', 'fromCrawl'] as const;

/**
 * Files that hand a crawled registry out, and the functions they hand it out
 * through. Every caller of one of these is held to the rule in turn.
 */
const BUILDERS: Readonly<Record<string, readonly string[]>> = {
  // `vat resources scan`, `vat resources validate` and `vat rag index` each crawl through it.
  'packages/cli/src/utils/resource-loader.ts': ['loadResourcesWithConfig'],
};

/**
 * Files that crawl and do not read the refusal log themselves, with how the
 * refusals still reach the user, or why there is no user to reach.
 */
const NOT_READ_HERE: Readonly<Record<string, string>> = {
  'packages/cli/src/commands/skills/validate.ts':
    'its shared registry reaches `registryForSkill` in `packaging-validator.ts`, which reads the log for every skill it validates.',
  'packages/cli/src/pipeline-oracles/lanes.ts':
    'an oracle that builds each lane\'s registry to compare their enumerations; it reports to no user.',
};

/** The registry itself: it defines the log and reads it in `validate()`. */
const OWNER = 'packages/resources/src/resource-registry.ts';

/** The reads that discharge a registry crawl: the refusal log, or both not-admitted logs. */
const READS = ['getParseRefusedResources(', 'getNotAdmitted('] as const;

/** The single-file add, which throws its refusal. */
const SINGLE_ADD = '.addResource(';

/** The classification every single-file add owes. */
const SINGLE_ADD_READ = 'isPerRunParseRefusal(';

/**
 * Files that call `.addResource(` and do not classify the refusal themselves,
 * with how it still reaches the user.
 */
const SINGLE_ADD_NOT_CLASSIFIED_HERE: Readonly<Record<string, string>> = {
  'packages/resources/src/projection/merge.ts':
    '`builder.addResource(row)` inserts a projection row; it is no registry\'s single-file add and parses nothing.',
};

/** The projection driver: it defines `populate` and runs no population of its own. */
const POPULATION_OWNER = 'packages/resources/src/projection/merge.ts';

/** The projection's own entry point. */
const POPULATE = 'populate';

/** The reads that discharge a population: its refusal rows, as a line or per path. */
const POPULATION_READS = ['describeBlobRefusals(', 'notAdmittedRealizations('] as const;

/**
 * Functions that run a caller's population build and read its refusal rows
 * themselves: a call to one discharges the caller. Asserted to still define the
 * function and still make a {@link POPULATION_READS} read.
 */
const POPULATION_REPORTERS: Readonly<Record<string, string>> = {
  'packages/cli/src/utils/population-wiring.ts': 'populateAndReport',
};

/**
 * Files that run a population and hand it out, and the functions they hand it
 * out through. Every caller of one of these is held to the rule in turn.
 */
const POPULATION_BUILDERS: Readonly<Record<string, readonly string[]>> = {
  'packages/resources/src/projection/resource-population.ts': ['buildResourcePopulation', 'buildResourceProjection'],
  'packages/resources/src/projection/claude-context-population.ts': ['buildClaudeContextPopulation'],
};

/**
 * Files that run a population and do not read its refusal rows, with how the
 * refusals still reach the user, or why there is no user to reach.
 */
const POPULATION_NOT_READ_HERE: Readonly<Record<string, string>> = {
  'packages/cli/src/utils/resource-loader.ts':
    'the population only ENUMERATES (`ResourcePopulationSource` hands the registry paths): the registry parses each on its own '
    + 'bounded route and logs every refusal, which `loadResourcesWithConfig`\'s callers read (`getNotAdmitted()`).',
};

/**
 * The single-file parses, which refuse their one file for this run: the cached
 * parses and the SKILL.md name readers throw the refusal, `parseFrontmatter`
 * returns it as `{ success: false, cause }`.
 */
const DIRECT_PARSES = [
  'parseFileCached',
  'parseContentCached',
  'parseFrontmatter',
  'declaredSkillNameIn',
  'readDeclaredSkillName',
] as const;

/** Where the cached parses are defined; it reports nothing itself. */
const DIRECT_PARSE_OWNER = 'packages/resources/src/parse-dispatcher.ts';

/** The not-admitted contract's entry points: each yields the `RESOURCE_PARSE_*` code and sentence under the project's allow list and severity. */
const CONTRACT_READS = [
  'parseRefusedEntry(',
  'parseRefusalIssue(',
  'notAdmittedIssues(',
  'notAdmittedFindings(',
] as const;

/** The classifier: a read only when its result is kept — a bare `parseRefusedEntryFor(…);` reports nothing. */
const CONTRACT_CLASSIFIER = 'parseRefusedEntryFor(';

/**
 * Functions that run a caller's direct parse and report its refusal through the
 * contract themselves: a call to one discharges the caller. Asserted to still
 * define the function and still read the contract.
 */
const DIRECT_PARSE_REPORTERS: Readonly<Record<string, string>> = {
  'packages/cli/src/commands/skills/skill-discovery.ts': 'declaredNameOrRefuse',
};

/**
 * Files that parse directly and do not report a refusal through the contract
 * themselves, with how it still reaches the user.
 */
const DIRECT_PARSE_NOT_REPORTED_HERE: Readonly<Record<string, string>> = {
  'packages/agent-skills/src/parsers/frontmatter-parser.ts':
    'Defines `parseFrontmatter`: it returns the refusal as its result\'s `cause`, and each caller is held by this same rule at its own call site.',
  'packages/agent-skills/src/skill-identity.ts':
    'Defines the name readers: `declaredSkillNameIn` rethrows a refused parse, and each caller is held by this same rule at its own call site.',
  'packages/agent-skills/src/validators/compat-detectors.ts':
    '`detectorFrontmatter` rethrows a refused parse for the one caller with no parse of its own — the compatibility analyzer, which names '
    + 'the file under `unchecked`. Every skill lane hands the detectors the frontmatter its own parse returned.',
  'packages/agent-skills/src/import.ts':
    '`vat agent import` converts the one SKILL.md the user named: a refused parse refuses the run (`INPUT_UNREADABLE`) with the parser\'s sentence. '
    + 'There is no project allow list to consult.',
  'packages/claude-marketplace/src/settings/settings-compat-checker.ts':
    'A refused parse names the SKILL.md under `unchecked` with the parser\'s sentence; a settings conflict check has no allow list.',
};

/** What a comment line starts with, once indentation is trimmed. */
const COMMENT_STARTS = ['*', '//', '/*'] as const;

/** `text` with comment lines removed, so a JSDoc example is not a call. */
function code(text: string): string {
  const kept = text.split('\n').filter((line) => !COMMENT_STARTS.some((start) => line.trimStart().startsWith(start)));
  return kept.join('\n');
}

/** A character that continues an identifier or a member access, so `x` in `ax(` or `.x(` is not a call to `x`. */
function continuesName(char: string | undefined): boolean {
  return char !== undefined && (char === '.' || char === '_' || char === '$' || /[\p{L}\p{N}]/u.test(char));
}

/**
 * Whether the name at `at` in `body` continues another name or a member access. A spread
 * (`...x(`) is neither: it is a call to `x`, which a bare `continuesName` read as `.x(`.
 */
function precededByName(body: string, at: number): boolean {
  return continuesName(body[at - 1]) && !body.slice(0, at).endsWith('...');
}

/**
 * Whether `body` calls the free function `name` — never its definition, never a
 * method of that name, never a backquoted mention in a message string.
 */
function callsFunction(body: string, name: string): boolean {
  const call = `${name}(`;
  for (let at = body.indexOf(call); at !== -1; at = body.indexOf(call, at + 1)) {
    if (!precededByName(body, at) && body[at - 1] !== '`' && !body.slice(0, at).endsWith('function ')) return true;
  }
  return false;
}

/** Whether `body` calls one of the crawl entry points (builder definitions excluded). */
function crawls(body: string, builderNames: readonly string[]): boolean {
  return CRAWL_METHODS.some((method) => body.includes(`.${method}(`)) || builderNames.some((name) => callsFunction(body, name));
}

/** Whether `body` runs a population: `populate(` itself or a listed builder (definitions excluded). */
function populates(body: string, builderNames: readonly string[]): boolean {
  return [POPULATE, ...builderNames].some((name) => callsFunction(body, name));
}

/** Whether `body` makes any of `reads`. */
function readsAny(body: string, reads: readonly string[]): boolean {
  return reads.some((read) => body.includes(read));
}

/** Whether `body` reads a population's refusal rows, itself or through a listed reporter. */
function readsPopulation(body: string): boolean {
  return readsAny(body, POPULATION_READS) || Object.values(POPULATION_REPORTERS).some((name) => callsFunction(body, name));
}

/**
 * The entries of a builder table that no longer crawl, or no longer define a
 * function they are listed with.
 */
function staleBuilders(
  table: Readonly<Record<string, readonly string[]>>,
  files: ReadonlyMap<string, string>,
  runs: (body: string, otherBuilders: readonly string[]) => boolean,
): string[] {
  const all = Object.values(table).flat();
  return Object.entries(table).flatMap(([file, names]) => {
    const body = files.get(file);
    if (body === undefined || !runs(body, all.filter((name) => !names.includes(name)))) return [file];
    return names.filter((name) => !body.includes(`function ${name}(`) && !body.includes(`function ${name}<`)).map((name) => `${file}#${name}`);
  });
}

describe('every resource crawl reports its parse refusals', () => {
  const files = new Map([...packageSources()].map(([file, text]) => [file, code(text)]));
  const builderNames = Object.values(BUILDERS).flat();
  const crawlers = [...files].filter(([file, body]) => file !== OWNER && crawls(body, builderNames));

  it('finds the crawlers — at least the CLI resource loader', () => {
    expect(crawlers.map(([file]) => file)).toContain('packages/cli/src/utils/resource-loader.ts');
  });

  it('reads getParseRefusedResources(), hands the registry to a listed builder\'s callers, or is listed as not read here', () => {
    const unread = crawlers
      .filter(([file, body]) => !readsAny(body, READS) && BUILDERS[file] === undefined && NOT_READ_HERE[file] === undefined)
      .map(([file]) => file);
    expect(unread).toEqual([]);
  });

  it('lists only builders that still crawl and still define what they are listed with', () => {
    expect(staleBuilders(BUILDERS, files, crawls)).toEqual([]);
  });

  it('lists as not read here only files that still crawl and do not read the log themselves', () => {
    const stale = Object.keys(NOT_READ_HERE).filter((file) => {
      const body = files.get(file);
      return body === undefined || !crawls(body, builderNames) || readsAny(body, READS);
    });
    expect(stale).toEqual([]);
  });
});

describe('every single-file add classifies the refusal it throws', () => {
  const files = new Map([...packageSources()].map(([file, text]) => [file, code(text)]));
  const adders = [...files].filter(([file, body]) => file !== OWNER && body.includes(SINGLE_ADD));

  it('finds the adders — at least the projection builder it lists', () => {
    // The skill packager admits its bundled assets in one `addResources` batch
    // now (one dispatcher, so a broken install trips the pool's breaker); the
    // listed projection builder is what proves the detector still sees a call.
    expect(adders.map(([file]) => file)).toContain('packages/resources/src/projection/merge.ts');
  });

  it('classifies isPerRunParseRefusal(), or is listed as not classified here', () => {
    const unclassified = adders
      .filter(([file, body]) => !body.includes(SINGLE_ADD_READ) && SINGLE_ADD_NOT_CLASSIFIED_HERE[file] === undefined)
      .map(([file]) => file);
    expect(unclassified).toEqual([]);
  });

  it('lists as not classified here only files that still add and do not classify', () => {
    const stale = Object.keys(SINGLE_ADD_NOT_CLASSIFIED_HERE).filter((file) => {
      const body = files.get(file);
      return body === undefined || !body.includes(SINGLE_ADD) || body.includes(SINGLE_ADD_READ);
    });
    expect(stale).toEqual([]);
  });
});

describe('every population reports its parse refusals', () => {
  const files = new Map([...packageSources()].map(([file, text]) => [file, code(text)]));
  const builderNames = Object.values(POPULATION_BUILDERS).flat();
  const populators = [...files].filter(([file, body]) => file !== POPULATION_OWNER && populates(body, builderNames));

  it('finds the populators — at least the inventory lane', () => {
    expect(populators.map(([file]) => file)).toContain('packages/claude-marketplace/src/inventory/inventory-population.ts');
  });

  it('reads the refusal rows, hands the population to a listed builder\'s callers, or is listed as not read here', () => {
    const unread = populators
      .filter(([file, body]) => !readsPopulation(body)
        && POPULATION_BUILDERS[file] === undefined && POPULATION_NOT_READ_HERE[file] === undefined)
      .map(([file]) => file);
    expect(unread).toEqual([]);
  });

  it('lists only builders that still populate and still define what they are listed with', () => {
    expect(staleBuilders(POPULATION_BUILDERS, files, populates)).toEqual([]);
  });

  it('lists as not read here only files that still populate and do not read the rows themselves', () => {
    const stale = Object.keys(POPULATION_NOT_READ_HERE).filter((file) => {
      const body = files.get(file);
      return body === undefined || !populates(body, builderNames) || readsPopulation(body);
    });
    expect(stale).toEqual([]);
  });

  it('lists as reporters only files that still define the function and still read the rows', () => {
    const stale = Object.entries(POPULATION_REPORTERS).filter(([file, name]) => {
      const body = files.get(file);
      return body === undefined || !body.includes(`function ${name}<`) && !body.includes(`function ${name}(`) || !readsAny(body, POPULATION_READS);
    });
    expect(stale).toEqual([]);
  });
});

/**
 * Whether `body` keeps the result of a `call` somewhere — assigned, returned,
 * passed, thrown. A call that opens its statement (`await` or `void` aside)
 * discards it.
 */
function keepsResultOf(body: string, call: string): boolean {
  for (let at = body.indexOf(call); at !== -1; at = body.indexOf(call, at + 1)) {
    const before = body.slice(body.lastIndexOf('\n', at) + 1, at).trim();
    if (!['', 'await', 'void'].includes(before) && !precededByName(body, at)) return true;
  }
  return false;
}

/** Whether `body` reports a refusal through the contract, itself or through a listed reporter. */
function readsContract(body: string): boolean {
  return readsAny(body, CONTRACT_READS)
    || keepsResultOf(body, CONTRACT_CLASSIFIER)
    || Object.values(DIRECT_PARSE_REPORTERS).some((name) => callsFunction(body, name));
}

describe('every direct parse reports its refusal through the one contract', () => {
  const files = new Map([...packageSources()].map(([file, text]) => [file, code(text)]));
  const parses = (body: string): boolean => DIRECT_PARSES.some((name) => callsFunction(body, name));
  const parsers = [...files].filter(([file, body]) => file !== DIRECT_PARSE_OWNER && parses(body));

  it('finds the direct parsers — the OKF lane, and the SKILL.md name readers\' callers', () => {
    expect(parsers.map(([file]) => file)).toEqual(expect.arrayContaining([
      'packages/resources/src/okf/validate.ts',
      'packages/cli/src/commands/claude/plugin/install.ts',
      'packages/claude-marketplace/src/inventory/extract-skill.ts',
    ]));
  });

  it('reads a spread call as a call, and a member call as none', () => {
    expect(callsFunction('  issues.push(...notAdmittedIssues(paths));\n', 'notAdmittedIssues')).toBe(true);
    expect(callsFunction('  issues.push(lane.notAdmittedIssues(paths));\n', 'notAdmittedIssues')).toBe(false);
  });

  it('keeps a classified refusal only when the result is used', () => {
    expect(keepsResultOf('  parseRefusedEntryFor(p, e);\n', CONTRACT_CLASSIFIER)).toBe(false);
    expect(keepsResultOf('  await parseRefusedEntryFor(p, e);\n', CONTRACT_CLASSIFIER)).toBe(false);
    expect(keepsResultOf('  const refused = parseRefusedEntryFor(p, e);\n', CONTRACT_CLASSIFIER)).toBe(true);
    expect(keepsResultOf('  return parseRefusedEntryFor(p, e);\n', CONTRACT_CLASSIFIER)).toBe(true);
  });

  it('reports through the not-admitted contract, or is listed as not reported here', () => {
    const unreported = parsers
      .filter(([file, body]) => !readsContract(body) && DIRECT_PARSE_NOT_REPORTED_HERE[file] === undefined)
      .map(([file]) => file);
    expect(unreported).toEqual([]);
  });

  it('lists as not reported here only files that still parse directly and do not report', () => {
    const stale = Object.keys(DIRECT_PARSE_NOT_REPORTED_HERE).filter((file) => {
      const body = files.get(file);
      return body === undefined || !parses(body) || readsContract(body);
    });
    expect(stale).toEqual([]);
  });

  it('lists as reporters only files that still define the function and still read the contract', () => {
    const stale = Object.entries(DIRECT_PARSE_REPORTERS).filter(([file, name]) => {
      const body = files.get(file);
      return body === undefined || !body.includes(`function ${name}(`)
        || !(readsAny(body, CONTRACT_READS) || keepsResultOf(body, CONTRACT_CLASSIFIER));
    });
    expect(stale).toEqual([]);
  });
});

/**
 * The producers of a not-admitted finding left at its default severity:
 * `RESOURCE_UNREADABLE`, `RESOURCE_PARSE_LIMIT_EXCEEDED`, `RESOURCE_PARSE_WORKER_DIED`.
 */
const UNRESOLVED_PRODUCERS = ['notAdmittedIssues', 'parseRefusalIssue', 'parseRefusedIssues'] as const;

/**
 * The resolvers: each settles those codes through the project's
 * `resources.validation` alone, never through a skill's `validation`.
 */
const NOT_ADMITTED_RESOLVERS = ['notAdmittedFindings', 'partitionNotAdmitted', 'resolveNotAdmittedAmong'] as const;

/** Where the producers and resolvers are defined. */
const NOT_ADMITTED_OWNERS = new Set(['packages/resources/src/not-admitted.ts', 'packages/agent-skills/src/parse-refusal-issues.ts']);

/**
 * Files that produce an unresolved not-admitted finding and resolve none
 * themselves, with where it is resolved under `resources.validation`.
 */
const RESOLVED_ELSEWHERE: Readonly<Record<string, string>> = {
  'packages/resources/src/resource-registry.ts':
    '`validate()` runs the framework over them under the config it was given — `resources.validation`, the codes\' one owner.',
  'packages/agent-skills/src/validators/referenced-path-missing.ts':
    'a post-build check: the packager splits its findings with `partitionNotAdmitted` (under no config — a refused file never ships) before the skill\'s framework sees them.',
  'packages/agent-skills/src/post-build-checks.ts':
    'a post-build check, as above; `vat build`\'s shipped-links lane reports its findings at their default severity, under no config.',
};

/**
 * The calls that resolve findings under a SKILL's (or a lane's own) `validation`.
 * In a producer file, each must be handed only what a not-admitted split left —
 * a finding these codes produce reaching one is resolved by the wrong owner.
 */
const FRAMEWORK_CALLS = ['runSingleUnitValidation', 'runValidationFramework', 'resolveFindings'] as const;

/** The splits whose `rest` is a framework input free of not-admitted findings. */
const NOT_ADMITTED_SPLITS = ['partitionNotAdmitted'] as const;

/**
 * Framework inputs in a producer file that are not a split's remainder, with why
 * no not-admitted finding can be among them. Keyed `file` → input text.
 */
const FRAMEWORK_INPUTS_CLEAR: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

/**
 * Producer files whose framework runs under `resources.validation` itself, so every
 * input is already resolved by its owner. Asserted to still produce.
 */
const FRAMEWORK_IS_RESOURCES_VALIDATION = new Set(['packages/resources/src/resource-registry.ts']);

/** The first argument of the call whose `(` is at `open`, as written. */
function firstArgument(body: string, open: number): string {
  let depth = 0;
  for (let at = open + 1; at < body.length; at++) {
    const char = body[at];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return body.slice(open + 1, at).trim();
      depth--;
    } else if (char === ',' && depth === 0) return body.slice(open + 1, at).trim();
  }
  return body.slice(open + 1).trim();
}

/** The elements an argument hands in: an array literal's entries (spreads unwrapped), or the argument itself. */
function argumentElements(argument: string): string[] {
  if (!argument.startsWith('[') || !argument.endsWith(']')) return [argument];
  const inner = argument.slice(1, -1);
  const elements: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at <= inner.length; at++) {
    const char = inner[at];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    else if ((char === ',' && depth === 0) || at === inner.length) {
      const element = inner.slice(start, at).trim().replace(/^\.\.\./, '');
      if (element.length > 0) elements.push(element);
      start = at + 1;
    }
  }
  return elements;
}

/**
 * What the one-line `const <binding> = [await] <split>(` that a split call at `at` opens binds,
 * or `undefined` when the call is not so bound.
 */
function splitBinding(body: string, at: number): string | undefined {
  const head = body.slice(body.lastIndexOf('\n', at) + 1, at).trim();
  if (!head.startsWith('const ') || !head.endsWith('=') && !head.endsWith('= await')) return undefined;
  return head.slice('const '.length, head.lastIndexOf('=')).trim();
}

/** The names `body` binds to a not-admitted split's remainder: `rest` destructured (or renamed), or `<split>.rest`. */
function splitRemainders(body: string): Set<string> {
  const remainders = new Set<string>();
  for (const split of NOT_ADMITTED_SPLITS) {
    for (let at = body.indexOf(`${split}(`); at !== -1; at = body.indexOf(`${split}(`, at + 1)) {
      if (precededByName(body, at)) continue;
      const binding = splitBinding(body, at);
      if (binding === undefined) continue;
      if (!binding.startsWith('{')) {
        remainders.add(`${binding}.rest`);
        continue;
      }
      for (const entry of binding.slice(1, -1).split(',')) {
        const [key, renamed] = entry.split(':').map((part) => part.trim());
        if (key === 'rest') remainders.add(renamed ?? key);
      }
    }
  }
  return remainders;
}

/**
 * Every framework input in `body` that is neither a split's remainder nor listed
 * as clear for `file`, as `call(input)`.
 */
function unsplitFrameworkInputs(file: string, body: string): string[] {
  const remainders = splitRemainders(body);
  const clear = FRAMEWORK_INPUTS_CLEAR[file] ?? {};
  const found: string[] = [];
  for (const name of FRAMEWORK_CALLS) {
    const call = `${name}(`;
    for (let at = body.indexOf(call); at !== -1; at = body.indexOf(call, at + 1)) {
      if (precededByName(body, at) || body.slice(0, at).endsWith('function ')) continue;
      for (const element of argumentElements(firstArgument(body, at + name.length))) {
        if (!remainders.has(element) && clear[element] === undefined) found.push(`${name}(${element})`);
      }
    }
  }
  return found;
}

describe('every not-admitted finding resolves under resources.validation, never a skill\'s validation', () => {
  const files = new Map([...packageSources()].map(([file, text]) => [file, code(text)]));
  const produces = (body: string): boolean => UNRESOLVED_PRODUCERS.some((name) => callsFunction(body, name));
  const resolves = (body: string): boolean => NOT_ADMITTED_RESOLVERS.some((name) => callsFunction(body, name));
  const producers = [...files].filter(([file, body]) => !NOT_ADMITTED_OWNERS.has(file) && produces(body));

  it('finds the producers — at least both skill validators and audit', () => {
    expect(producers.map(([file]) => file)).toEqual(expect.arrayContaining([
      'packages/agent-skills/src/validators/packaging-validator.ts',
      'packages/agent-skills/src/validators/skill-validator.ts',
      'packages/cli/src/commands/audit.ts',
    ]));
  });

  it('resolves through a resources.validation resolver, or is listed as resolved elsewhere', () => {
    const unresolved = producers
      .filter(([file, body]) => !resolves(body) && RESOLVED_ELSEWHERE[file] === undefined)
      .map(([file]) => file);
    expect(unresolved).toEqual([]);
  });

  it('lists as resolved elsewhere only files that still produce and do not resolve', () => {
    const stale = Object.keys(RESOLVED_ELSEWHERE).filter((file) => {
      const body = files.get(file);
      return body === undefined || !produces(body) || resolves(body);
    });
    expect(stale).toEqual([]);
  });

  // The file-coarse check above passes a file that calls a resolver ANYWHERE. This one holds each
  // framework call: a not-admitted finding handed to a skill's framework is resolved by the skill.
  it('hands every framework call in a producer file only a not-admitted split\'s remainder', () => {
    const leaks = producers
      .filter(([file]) => !FRAMEWORK_IS_RESOURCES_VALIDATION.has(file))
      .flatMap(([file, body]) => unsplitFrameworkInputs(file, body).map((input) => `${file}: ${input}`));
    expect(leaks).toEqual([]);
  });

  it('lists as clear only inputs a producer file still hands a framework call', () => {
    const stale = Object.entries(FRAMEWORK_INPUTS_CLEAR).flatMap(([file, inputs]) => {
      const body = files.get(file) ?? '';
      const handed = new Set(FRAMEWORK_CALLS.flatMap((name) => {
        const elements: string[] = [];
        for (let at = body.indexOf(`${name}(`); at !== -1; at = body.indexOf(`${name}(`, at + 1)) {
          elements.push(...argumentElements(firstArgument(body, at + name.length)));
        }
        return elements;
      }));
      return Object.keys(inputs).filter((input) => !produces(body) || !handed.has(input)).map((input) => `${file}: ${input}`);
    });
    expect(stale).toEqual([]);
  });

  it('lists as framed by resources.validation only files that still produce', () => {
    expect([...FRAMEWORK_IS_RESOURCES_VALIDATION].filter((file) => !produces(files.get(file) ?? ''))).toEqual([]);
  });

  // The shape `vat audit` had: an allow-only filter, then the skill's severity over the not-admitted
  // findings it left — a `resources.validation` severity overridden by `skills.defaults`.
  it('flags a framework call handed findings no split removed', () => {
    const leaky = [
      '  const allowed = resolveNotAdmittedAmong(result.issues, config, roots);',
      '  const resolvedIssues = resolveFindings(allowed, { severity });',
    ].join('\n');
    expect(unsplitFrameworkInputs('x.ts', leaky)).toEqual(['resolveFindings(allowed)']);

    const split = [
      '  const { rest, notAdmitted } = partitionNotAdmitted([issue], resourceValidation, roots);',
      '  return [...resolveFindings(rest, { severity }), ...notAdmitted];',
      '  const parts = partitionNotAdmitted(issues, v, roots);',
      '  runSingleUnitValidation(parts.rest, v);',
      '  runValidationFramework([...rawLinkIssues, ...rest], v, ledger);',
    ].join('\n');
    expect(unsplitFrameworkInputs('x.ts', split)).toEqual(['runValidationFramework(rawLinkIssues)']);
  });
});
