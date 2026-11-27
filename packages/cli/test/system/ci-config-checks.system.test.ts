/**
 * The repo's CI configuration rules, run as the `vat resources check` they ship as: CI tests Node at
 * or above the root engines.node floor and names no Node version of its own (the header of
 * .github/actions/setup/action.yml), and every vibe-validate step has the shape the header of
 * vibe-validate.config.yaml describes (two tiers; pre-commit is build, typecheck and lint).
 *
 * The rules are `resources.checks` entries in the repo's own `vibe-agent-toolkit.config.yaml`, and
 * every case routes its files with that config's own `resources.extractors.data` block. The suite
 * harness reads both FROM that file, so a case exercises the shipped statements and the shipped
 * routing, never a copy. Both checks run in every case, so a case also proves the other stays silent.
 */

import { describe, it } from 'vitest';

import {
  brokenSubjectCase,
  shippedCheckTest,
  shippedDataBlock,
  type CaseTree,
  type ShippedCheckCase,
} from '../helpers/shipped-check-suite.js';

import { fs, getMonorepoRoot, safePath } from './test-common.js';

const VV = 'vibe-validate.config.yaml';
const WORKFLOW = '.github/workflows/validate.yml';
const SETUP = '.github/actions/setup/action.yml';
const FLOOR = '>=22.16.0';
const SHIPPED_DATA = shippedDataBlock();

const UNIT_STEP = `        - name: Unit tests
          command: bun run test:unit
          runScope: ci
`;

/** A vibe-validate config: the matrix, then the two-tier step list with the unit step last. */
function vibeValidate(nodeVersions = "['24']", unitStep = UNIT_STEP, lintExtra = ''): string {
  return `ci:
  nodeVersions: ${nodeVersions}
  os: [ubuntu-latest]
validation:
  phases:
    - name: Build
      steps:
        - name: Build packages
          command: bun run build
        - name: TypeScript type checking
          command: bun run typecheck
        - name: ESLint
          command: bun run lint
${lintExtra}    - name: Tests
      steps:
${unitStep}`;
}

/** A workflow whose second step runs the setup action, plus any further steps. */
function workflow(withNodeVersion = `\${{ matrix.node }}`, extraSteps = ''): string {
  return `name: Validation
on: push
jobs:
  validate:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['24']
    steps:
      - uses: actions/checkout@v7
      - name: Setup toolchain
        uses: ./.github/actions/setup
        with:
          node-version: ${withNodeVersion}
${extraSteps}`;
}

const SETUP_ACTION = `name: Setup toolchain
runs:
  using: composite
  steps:
    - name: Setup Node.js
      uses: actions/setup-node@v7
      with:
        node-version: \${{ steps.node.outputs.version }}
`;

const DIRECT_SETUP_NODE = `      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
`;

/** The tree every case starts from: a floor, a matrix above it, a workflow and the setup action that derive it. */
const CLEAN: CaseTree = {
  'package.json': { name: 'root', private: true, engines: { node: FLOOR } },
  [VV]: vibeValidate(),
  [WORKFLOW]: workflow(),
  [SETUP]: SETUP_ACTION,
};

const YAML_EXTENSIONS = ['yml', 'yaml'] as const;

/**
 * The repo's own files those rules read, as they are now: the real tree must be clean. `ciFiles`
 * is how many workflows and composite actions it holds, every one of which has steps.
 */
function realTree(): { tree: CaseTree; ciFiles: number } {
  const root = getMonorepoRoot(import.meta.url);
  const read = (path: string): string => fs.readFileSync(safePath.join(root, path), 'utf-8');
  const tree: Record<string, string> = { 'package.json': read('package.json'), [VV]: read(VV) };
  let ciFiles = 0;
  const add = (path: string): void => {
    tree[path] = read(path);
    ciFiles += 1;
  };
  for (const name of fs.readdirSync(safePath.join(root, '.github/workflows'))) {
    if (YAML_EXTENSIONS.some((extension) => name.endsWith(`.${extension}`))) add(`.github/workflows/${name}`);
  }
  for (const name of fs.readdirSync(safePath.join(root, '.github/actions'))) {
    for (const extension of YAML_EXTENSIONS) {
      const action = `.github/actions/${name}/action.${extension}`;
      if (fs.existsSync(safePath.join(root, action))) add(action);
    }
  }
  return { tree, ciFiles };
}

const REAL = realTree();

// The messages, written out in full: a case pins what a finding SAYS, not only where it is.
const TIER = '"bun run build", "bun run typecheck", "bun run lint"';
const VV_ABSENT_FLOOR =
  'vibe-validate.config.yaml is not routed (absent, git-ignored, or excluded from the data instance), so there is no CI Node matrix to hold to the floor and the rule cannot run.';
const VV_ABSENT_SHAPE =
  'vibe-validate.config.yaml is not routed (absent, git-ignored, or excluded from the data instance), so its step shape cannot be checked.';
const NO_MATRIX =
  'vibe-validate.config.yaml declares no ci.nodeVersions list with an entry, so there is no CI Node matrix to hold to the floor and the rule cannot run.';
const NO_FLOOR =
  'Root package.json is not routed or declares no engines.node, so there is no Node floor to hold the CI matrix to and the rule cannot run.';

function below(shown: string, major: number): string {
  return `ci.nodeVersions entry ${shown} is Node ${major}, below the floor root package.json declares (engines.node "${FLOOR}", Node 22). CI would test a Node no package supports; raise the entry or lower the floor.`;
}

function noMajor(shown: string): string {
  return `ci.nodeVersions entry ${shown} does not begin with a major version number (as "24" and "24.x" do), so it cannot be held to the Node floor.`;
}

function nodeVersion(pointer: string, shown: string): string {
  return `${pointer} sets node-version to ${shown}. CI names no Node version of its own: only .github/workflows/validate.yml passes one, exactly "\${{ matrix.node }}" (the matrix generated from vibe-validate.config.yaml ci.nodeVersions), and only .github/actions/setup/action.yml hands setup-node one, as a \${{ }} expression it derives from root package.json engines.node. Omit node-version to run the floor.`;
}

function directSetupNode(pointer: string, shown: string): string {
  return `${pointer} uses ${shown} directly. Only .github/actions/setup/action.yml sets up Node, because it derives the version from what the repo declares; use ./.github/actions/setup instead.`;
}

const UNIT = 'Step "Unit tests" (/validation/phases/1/steps/0)';
const SHAPE = 'Every step is a map with a string name and a string command.';

const FLOOR_CHECK = 'ci-node-floor';

/** A copy of the setup action under another path: both of its Node lines are then CI's own. */
function setupActionCopy(path: string): Array<readonly [string, string]> {
  return [
    [path, directSetupNode('/runs/steps/0/uses', '"actions/setup-node@v7"')],
    [path, nodeVersion('/runs/steps/0/with/node-version', `"\${{ steps.node.outputs.version }}"`)],
  ];
}

/** A composite action other than the setup action, whose one step runs the setup action with `with`. */
function otherAction(withBlock: string): string {
  return `name: Other
runs:
  using: composite
  steps:
    - uses: ./.github/actions/setup
${withBlock}`;
}

const CASES: readonly ShippedCheckCase[] = [
  { name: 'a clean tree is silent', files: {}, expected: [], examined: { [FLOOR_CHECK]: 2 } },
  {
    name: "the repo's own CI files are clean",
    files: REAL.tree,
    expected: [],
    examined: { [FLOOR_CHECK]: REAL.ciFiles },
  },
  {
    // A workflow that only calls a reusable one, and a JavaScript action: no file has steps.
    name: 'no workflow or composite action with steps means the floor rule examined nothing',
    files: {
      [WORKFLOW]: 'name: Validation\non: push\njobs:\n  validate:\n    uses: ./.github/workflows/other.yml\n',
      [SETUP]: 'name: Setup toolchain\nruns:\n  using: node24\n  main: index.js\n',
    },
    expected: [],
    examined: { [FLOOR_CHECK]: 0 },
  },
  {
    // Only validate.yml passes the matrix; the same expression elsewhere is a Node version of its own.
    name: 'the matrix expression in another workflow is a finding',
    files: { '.github/workflows/other.yml': workflow() },
    expected: [['.github/workflows/other.yml', nodeVersion('/jobs/validate/steps/1/with/node-version', `"\${{ matrix.node }}"`)]],
    examined: { [FLOOR_CHECK]: 3 },
  },
  {
    name: 'an expression other than the matrix in validate.yml is a finding',
    files: { [WORKFLOW]: workflow(`\${{ inputs.node }}`) },
    expected: [[WORKFLOW, nodeVersion('/jobs/validate/steps/1/with/node-version', `"\${{ inputs.node }}"`)]],
  },
  {
    name: 'an expression passed by a composite action other than the setup action is a finding',
    files: { '.github/actions/other/action.yml': otherAction(`      with:\n        node-version: \${{ inputs.node }}\n`) },
    expected: [['.github/actions/other/action.yml', nodeVersion('/runs/steps/0/with/node-version', `"\${{ inputs.node }}"`)]],
  },
  {
    name: 'a .yaml workflow is read like a .yml one',
    files: { '.github/workflows/other.yaml': workflow("'22'") },
    expected: [['.github/workflows/other.yaml', nodeVersion('/jobs/validate/steps/1/with/node-version', '"22"')]],
    examined: { [FLOOR_CHECK]: 3 },
  },
  {
    name: 'an action.yaml composite action is read like an action.yml one',
    files: { '.github/actions/other/action.yaml': SETUP_ACTION },
    expected: setupActionCopy('.github/actions/other/action.yaml'),
    examined: { [FLOOR_CHECK]: 3 },
  },
  {
    // A string and a number below the floor; '22.x' is at it, and is silent.
    name: 'a matrix entry below the floor is a finding, string or number',
    files: { [VV]: vibeValidate("['20', 21, '22.x', '24']") },
    expected: [[VV, below('"20"', 20)], [VV, below('21', 21)]],
  },
  {
    name: 'a matrix entry that does not begin with a major is a finding',
    files: { [VV]: vibeValidate("['lts/*', 'v24', '24']") },
    expected: [[VV, noMajor('"lts/*"')], [VV, noMajor('"v24"')]],
  },
  {
    name: 'a matrix that is not a list cannot be checked',
    files: { [VV]: vibeValidate("'24'") },
    expected: [[VV, NO_MATRIX]],
  },
  {
    // The include glob for vibe-validate.config.yaml then matches nothing, which allowEmpty excuses.
    name: 'an absent vibe-validate.config.yaml means neither rule can run',
    files: { [VV]: null },
    data: { ...SHIPPED_DATA, allowEmpty: true },
    expected: [[VV, VV_ABSENT_FLOOR], [VV, VV_ABSENT_SHAPE]],
  },
  {
    name: 'a root manifest with no engines.node means the floor rule cannot run',
    files: { 'package.json': { name: 'root', private: true } },
    expected: [['package.json', NO_FLOOR]],
  },
  {
    name: 'a root floor with no major means the floor rule cannot run',
    files: { 'package.json': { name: 'root', private: true, engines: { node: 'latest' } } },
    expected: [
      [
        'package.json',
        'Root package.json declares engines.node "latest", which names no major version once its leading operator is stripped (">=22.16.0" names 22), so there is no Node floor to hold the CI matrix to and the rule cannot run.',
      ],
    ],
  },
  {
    // Unquoted, YAML reads 22 as a number: its lexeme is what the message shows.
    name: 'a literal node-version in a workflow step is a finding',
    files: { [WORKFLOW]: workflow('22') },
    expected: [[WORKFLOW, nodeVersion('/jobs/validate/steps/1/with/node-version', '22')]],
  },
  {
    name: 'a literal node-version in a composite action step is a finding',
    files: { [SETUP]: SETUP_ACTION.replace(`\${{ steps.node.outputs.version }}`, "'24.x'") },
    expected: [[SETUP, nodeVersion('/runs/steps/0/with/node-version', '"24.x"')]],
  },
  {
    name: 'a workflow step that runs setup-node directly is a finding',
    files: { [WORKFLOW]: workflow(undefined, DIRECT_SETUP_NODE) },
    expected: [[WORKFLOW, directSetupNode('/jobs/validate/steps/2/uses', '"actions/setup-node@v4"')]],
  },
  {
    // The clean tree's setup action already runs setup-node; another action that does is a finding.
    name: 'setup-node is silent only inside the setup action',
    files: { '.github/actions/other/action.yml': SETUP_ACTION },
    expected: setupActionCopy('.github/actions/other/action.yml'),
  },
  {
    name: 'a step with no command is a finding',
    files: { [VV]: vibeValidate(undefined, UNIT_STEP.replace('          command: bun run test:unit\n', '')) },
    expected: [[VV, `${UNIT} has no string command. ${SHAPE}`]],
  },
  {
    name: 'a step that is not a map is a finding',
    files: { [VV]: vibeValidate(undefined, `${UNIT_STEP}        - bun run test:system\n`) },
    expected: [[VV, `Step /validation/phases/1/steps/1 is a string, not a map. ${SHAPE}`]],
  },
  {
    name: 'a runScope other than ci is a finding',
    files: { [VV]: vibeValidate(undefined, UNIT_STEP.replace('runScope: ci', 'runScope: local')) },
    expected: [
      [
        VV,
        `${UNIT} sets runScope to "local". The only runScope is "ci", which puts a step in the full tier; a step with no runScope is in the pre-commit tier.`,
      ],
    ],
  },
  {
    name: 'a test step with no runScope grows the pre-commit tier',
    files: { [VV]: vibeValidate(undefined, UNIT_STEP.replace('          runScope: ci\n', '')) },
    expected: [
      [
        VV,
        `${UNIT} sets no runScope, so it runs in the pre-commit tier, which the header of vibe-validate.config.yaml fixes at exactly ${TIER}. Mark this step runScope: ci.`,
      ],
    ],
  },
  {
    name: 'lint marked runScope ci leaves the pre-commit tier one short',
    files: { [VV]: vibeValidate(undefined, UNIT_STEP, '          runScope: ci\n') },
    expected: [
      [
        VV,
        `No pre-commit-tier step (one with no runScope) runs "bun run lint". The header of vibe-validate.config.yaml fixes the pre-commit tier at exactly ${TIER}. Add the step, or remove runScope: ci from the step that runs it.`,
      ],
    ],
  },
  {
    name: 'a step name used in two phases is a finding at the repeat',
    files: { [VV]: vibeValidate(undefined, UNIT_STEP.replace('Unit tests', 'ESLint')) },
    expected: [
      [
        VV,
        'Step "ESLint" (/validation/phases/1/steps/0) repeats the name of the step at /validation/phases/0/steps/2. Step names are unique across phases, because vibe-validate reports a step by its name.',
      ],
    ],
  },
  brokenSubjectCase('a vibe-validate.config.yaml that does not parse is not a finding', VV, {
    files: { [WORKFLOW]: workflow('22') },
    expected: [[WORKFLOW, nodeVersion('/jobs/validate/steps/1/with/node-version', '22')]],
  }),
  brokenSubjectCase('a root manifest that does not parse is not a finding', 'package.json'),
];

const SUITE = {
  checks: ['ci-node-floor', 'vibe-validate-step-shape'],
  base: CLEAN,
  data: SHIPPED_DATA,
  cases: CASES,
  prefix: 'ci-config',
} as const;

describe(`the shipped ${SUITE.checks.join(', ')} checks`, () => {
  it.each(CASES)('$name', shippedCheckTest(SUITE));
});
