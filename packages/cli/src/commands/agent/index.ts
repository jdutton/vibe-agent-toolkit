/**
 * Agent command group
 */

import { Command } from 'commander';

import { buildCommand } from './build.js';
import { importCommand } from './import.js';
import { installAgent } from './install.js';
import { installedCommand } from './installed.js';
import { listCommand } from './list.js';
import { runCommand } from './run.js';
import { uninstallAgent } from './uninstall.js';
import { validateCommand } from './validate.js';

const DEBUG_OPTION_DESC = 'Enable debug logging';
const SCOPE_OPTION = '--scope <scope>';
const SCOPE_OPTION_DESC = 'Installation scope (user, project)';
const SCOPE_DEFAULT = 'user';
const RUNTIME_OPTION = '--runtime <name>';
const RUNTIME_OPTION_DESC = 'Target runtime';
const RUNTIME_DEFAULT = 'agent-skill';
const DEV_MODE_DESC = 'Development mode (symlink instead of copy)';

export function createAgentCommand(): Command {
  const agent = new Command('agent');

  agent
    .description('Manage and execute AI agents')
    .option('--verbose', 'Show verbose help')
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Description:
  Define AI agents using Kubernetes-style YAML manifests with LLM
  configuration, tools, prompts, and resources.

Example:
  $ vat agent list                      # List discovered agents
  $ vat agent validate agent-generator  # Validate by name
  $ vat agent build agent-generator     # Build as Agent Skill
  $ vat agent run agent-generator "Create a PR review agent"  # Execute agent

Configuration:
  Create agent.yaml in your agent directory. See --help --verbose for details.
`
    );

  agent
    .command('list')
    .description('List all discovered agents')
    .option('--debug', DEBUG_OPTION_DESC)
    .action(listCommand)
    .addHelpText(
      'after',
      `
Description:
  Discovers agents in common locations and lists them with their metadata.

  Search paths:
    - packages/vat-development-agents/agents/
    - agents/
    - . (current directory)

Output (YAML on stdout; the human list on stderr):
  status: ok | findings;  examined: 3 (the search paths scanned)
  findings[]: SCAN_PATH_UNREADABLE (warning) per search path, agent
    directory or manifest the OS would not read — the list is then a
    floor, not the answer
  data: { root, agents: [{ name, version, path }] } — path relative to root

Exit Codes (derived from the document):
  0 - ok, or findings (an unreadable path is a warning)
  2 - error: only a defect in VAT (INTERNAL_ERROR)

Requirements:
  projectRoot: optional (tolerates absence)
  config:      not used

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat agent list                      # List all agents
  $ vat agent list --debug              # Show discovery details
`
    );

  agent
    .command('build <pathOrName>')
    .description('Build agent for deployment target')
    .option('--target <type>', 'Build target (skill, langchain, etc.)', 'skill')
    .option('--output <path>', 'Output directory (default: dist/vat-bundles/<target>/<agent>)')
    .option('--force', 'Replace a previous build: remove and rebuild <output>/<agent>; without it, one that holds anything is refused')
    .option('--debug', DEBUG_OPTION_DESC)
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Packages an agent for a specific deployment target. Converts agent manifest,
  prompts, and resources into target-specific format.

  Argument: agent name OR path to agent directory/manifest file

  VAT never deletes or overwrites what it did not produce. With --output, an
  <output>/<agent-name>/ that already holds anything is refused (USAGE_INVALID)
  and left exactly as it was, unless --force says it is a previous build to
  replace (removed and rebuilt). An empty directory is used as-is; an output
  holding the agent's own source is refused even with --force. The default
  location is VAT's and is built into in place. Every source is read before
  anything is written.

Targets:
  - skill: Agent Skills (for Claude Desktop/Code)
  - More targets coming soon (langchain, etc.)

Output (YAML on stdout):
  status: ok | error;  examined: 1 (the agent built)
  data: { agent, target, output, files }
  findings[]: only SKILL_PACKAGING_FAILED, on the error branch
  Default build location: dist/vat-bundles/<target>/<agent-name>/

Exit Codes (derived from the document):
  0 - ok: the agent was built
  2 - error: nothing was built — USAGE_INVALID (a --target other than
      skill, no projectRoot, the path or name names no manifest, no
      package.json encloses the agent and --output was not given, an
      --output whose agent directory holds something and no --force, or an
      output holding the agent's own source),
      CONFIG_INVALID (the manifest does not validate, declares no system
      prompt, or its $ref names no file), INPUT_UNREADABLE (an agent
      search path looked up by name, the manifest, its system prompt,
      scripts/, LICENSE.txt or package.json cannot be read, or the system
      prompt, LICENSE.txt or a file under scripts/ is a named pipe, socket or
      device), RUN_INCOMPLETE (the packager refused the bundle's content — a
      SKILL_PACKAGING_FAILED finding at the agent — or the OS would not let
      the build write its output: a full disk, a read-only or unwritable
      --output, a file in its way; no finding)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file with agents.* fields populated

  See docs/concepts/roots-and-config.md for terminology.

Examples:
  $ vat agent build agent-generator                    # Build as Agent Skill
  $ vat agent build agent-generator --target skill     # Explicit target
  $ vat agent build ./my-agent --output ./my-skill     # Custom output path
  $ vat agent build ./my-agent --output ./my-skill --force  # Replace the previous build there
`
    );

  agent
    .command('run <pathOrName> <userInput>')
    .description('Execute an agent with user input')
    .option('--debug', DEBUG_OPTION_DESC)
    .action(runCommand)
    .addHelpText(
      'after',
      `
Description:
  Executes an agent by loading its manifest, prompts, and calling the
  configured LLM provider with the user input. Response is output to stdout.

  Argument: agent name OR path to agent directory/manifest file
  User input: The input text/query for the agent

Exit Codes:
  0 - Success  |  2 - Any failure (the agent did not load, or the run failed)

Examples:
  $ vat agent run agent-generator "Create a code review agent"
  $ vat agent run ./my-agent "analyze this code"
  $ vat agent run my-agent "help me with..." --debug

Prerequisites:
  - ANTHROPIC_API_KEY environment variable (for Anthropic-based agents)
  - Valid agent manifest with prompts configured

Requirements:
  projectRoot: optional (path-explicit; tolerates absence)
  config:      optional (uses defaults if absent)

  See docs/concepts/roots-and-config.md for terminology.
`
    );

  agent
    .command('validate <pathOrName>')
    .description('Validate agent manifest and prerequisites')
    .option('--debug', DEBUG_OPTION_DESC)
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates agent manifest schema (using @vibe-agent-toolkit/schema),
  LLM configuration, tool definitions, and resource availability. Outputs
  the report envelope (YAML) to stdout, findings to stderr.

  Argument: agent name OR path to agent directory/manifest file

Validation Checks:
  - Manifest schema (apiVersion, kind, metadata, spec) — AGENT_MANIFEST_INVALID
  - Tool configurations (RAG databases) — AGENT_REFERENCE_MISSING,
    AGENT_RAG_NO_SOURCES
  - Resource files and prompt $ref paths — AGENT_REFERENCE_MISSING,
    AGENT_REFERENCE_UNREADABLE

Output (YAML on stdout):
  status: ok | findings | error;  examined: 1 (the manifest read)
  findings[]: each located at the manifest, relative to data.root
  data: { root, manifest: { name, version, path } }

Exit Codes (derived from the document):
  0 - ok, or findings with no error-severity finding
  1 - findings with an error-severity finding
  2 - error: no manifest to judge — USAGE_INVALID (the path or name names
      no manifest), INPUT_UNREADABLE (the manifest is unreadable or not
      YAML, or an agent search path looked up by name cannot be read)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      optional (uses defaults if absent)

  See docs/concepts/roots-and-config.md for terminology.

Examples:
  $ vat agent validate agent-generator          # Validate by name
  $ vat agent validate ./my-agent               # Validate by path
  $ vat agent validate ./agent.yaml             # Validate specific file
`
    );

  agent
    .command('import <skillPath>')
    .description('Import Agent Skill (SKILL.md) to VAT agent format (agent.yaml)')
    .option('-o, --output <path>', 'Output path for agent.yaml (default: same directory as SKILL.md)')
    .option('-f, --force', 'Overwrite existing agent.yaml')
    .option('--debug', DEBUG_OPTION_DESC)
    .action(importCommand)
    .addHelpText(
      'after',
      `
Description:
  Converts a third-party Agent Skill (SKILL.md) to VAT agent format
  (agent.yaml). Validates the skill frontmatter and creates a proper VAT
  agent manifest with the agent-skills runtime.

  Use this to import existing Agent Skills into your VAT project for
  further customization or to use with VAT's build and deployment tools.

Conversion:
  - Extracts name, description, license from SKILL.md frontmatter
  - Creates agent.yaml with runtime: agent-skills
  - Preserves version from metadata.version or defaults to 0.1.0
  - Validates frontmatter before conversion

Output (YAML on stdout):
  status: ok | error;  examined: 1 (the skill imported)
  data: { agentPath }

Exit Codes (derived from the document):
  0 - ok: agent.yaml was written
  2 - error: nothing was written — USAGE_INVALID (no SKILL.md at the path,
      or agent.yaml exists and --force was not given), INPUT_UNREADABLE (the
      SKILL.md cannot be read, or no Agent Skills schema accepts its
      frontmatter), RUN_INCOMPLETE (the agent.yaml write failed); a
      --output whose directory does not exist is USAGE_INVALID

Examples:
  $ vat agent import ./my-skill/SKILL.md              # Import to same directory
  $ vat agent import ./SKILL.md -o ./agent.yaml       # Custom output path
  $ vat agent import ./SKILL.md --force               # Overwrite existing
`
    );

  agent
    .command('install <agentName>')
    .description('Install agent to Agent Skills directory')
    .option(SCOPE_OPTION, SCOPE_OPTION_DESC, SCOPE_DEFAULT)
    .option('--dev', DEV_MODE_DESC)
    .option('--force', 'Overwrite existing installation')
    .option(RUNTIME_OPTION, RUNTIME_OPTION_DESC, RUNTIME_DEFAULT)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(installAgent)
    .addHelpText(
      'after',
      `
Description:
  Installs a built agent skill to Agent Skills directory. By default,
  copies to user scope. Use --dev for symlink mode
  (rapid development iteration).

Scopes:
  - user: $CLAUDE_CONFIG_DIR/skills/, else ~/.claude/skills/ (default, personal skills)
  - project: .claude/skills/ under the working directory (--cwd sets it)

Output (YAML on stdout):
  status: ok | error;  examined: 1 (the agent named)
  data: { agent, installPath, symlink } — symlink is true under --dev

Exit Codes (derived from the document):
  0 - ok: the agent was installed
  2 - error: nothing was installed — USAGE_INVALID (an unknown --scope or
      --runtime, a name that is not one path segment or names no agent,
      the agent is already installed and --force was not given, or no
      package.json encloses the agent), NOT_IMPLEMENTED (--dev on Windows),
      CONFIG_INVALID (the manifest does not validate), INPUT_UNREADABLE (the
      bundle was never built, holds a named pipe, socket or device or a
      symlink that leads out of it or nowhere, or a search path, the
      manifest, any file in the bundle or the install path cannot be read),
      RUN_INCOMPLETE (a write under the scope directory failed).
      A copy replaces a previous install only once it is whole, so a refused
      --force copy keeps it; --force --dev removes it before linking, and a
      failed link says so in the message

Examples:
  $ vat agent install agent-generator                  # Install to user scope
  $ vat agent install agent-generator --scope project  # Install to project
  $ vat agent install agent-generator --dev            # Symlink for dev mode
  $ vat agent install agent-generator --force          # Overwrite existing

Note: --dev (symlink) not supported on Windows. Use WSL for development.
`
    );

  agent
    .command('uninstall <agentName>')
    .description('Uninstall agent from Agent Skills directory')
    .option(SCOPE_OPTION, SCOPE_OPTION_DESC, SCOPE_DEFAULT)
    .option(RUNTIME_OPTION, RUNTIME_OPTION_DESC, RUNTIME_DEFAULT)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(uninstallAgent)
    .addHelpText(
      'after',
      `
Description:
  Removes an installed agent skill from Agent Skills directory.
  Handles both copied installations and symlinks.

Scopes:
  - user: $CLAUDE_CONFIG_DIR/skills/, else ~/.claude/skills/ (default)
  - project: .claude/skills/ under the working directory (--cwd sets it)

Output (YAML on stdout):
  status: ok | error;  examined: 1 (the agent named)
  data: { agent, installPath, wasSymlink } — wasSymlink for a --dev install
    (only the link is removed, never its target)

Exit Codes (derived from the document):
  0 - ok: the install was removed
  2 - error: nothing was removed — USAGE_INVALID (an unknown --scope or
      --runtime, a name that is not one path segment, or the agent is not
      installed in that scope), INPUT_UNREADABLE (the install path cannot be
      read), RUN_INCOMPLETE (the removal failed)

Examples:
  $ vat agent uninstall agent-generator                  # Remove from user scope
  $ vat agent uninstall agent-generator --scope project  # Remove from project
`
    );

  agent
    .command('installed')
    .description('List installed agent skills')
    .option(SCOPE_OPTION, 'Filter by scope (user, project, all)', 'all')
    .option(RUNTIME_OPTION, RUNTIME_OPTION_DESC, RUNTIME_DEFAULT)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(installedCommand)
    .addHelpText(
      'after',
      `
Description:
  Lists all installed agent skills across scopes. Shows installation
  type (copied or symlinked) and location.

Scopes:
  - all: Scan all scopes (default)
  - user: Only $CLAUDE_CONFIG_DIR/skills/, else ~/.claude/skills/
  - project: Only .claude/skills/ under the working directory (--cwd sets it)

Output (YAML on stdout; the human list on stderr):
  status: ok | findings | error;  examined: the scopes scanned
  findings[]: SCAN_PATH_UNREADABLE (warning) per scope directory the OS
    would not list — the list is then a floor, not the answer; its field
    is the scope, its location the scope directory's last two segments
  data: { scanned, skills: [{ name, scope, type: symlink | directory, path }] }

Exit Codes (derived from the document):
  0 - ok, or findings (an unreadable scope is a warning)
  2 - error: USAGE_INVALID (a --scope or --runtime it does not know)

Examples:
  $ vat agent installed                    # List all installed skills
  $ vat agent installed --scope user       # Only user scope
  $ vat agent installed --scope project    # Only project scope
`
    );

  return agent;
}

export { showAgentVerboseHelp } from './help.js';
