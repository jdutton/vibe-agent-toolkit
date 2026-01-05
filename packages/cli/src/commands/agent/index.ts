/**
 * Agent command group
 */

import { Command } from 'commander';

import { auditCommand } from './audit.js';
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
const RUNTIME_DEFAULT = 'claude-skill';
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
  $ vat agent build agent-generator     # Build as Claude Skill
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
    .option('--debug', DEBUG_OPTION_DESC)
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Packages an agent for a specific deployment target. Converts agent manifest,
  prompts, and resources into target-specific format.

  Argument: agent name OR path to agent directory/manifest file

Targets:
  - skill: Claude Skills (for Claude Desktop/Code)
  - More targets coming soon (langchain, etc.)

Output:
  Default location: dist/vat-bundles/<target>/<agent-name>/

Exit Codes:
  0 - Success  |  1 - Build error  |  2 - System error

Examples:
  $ vat agent build agent-generator                    # Build as Claude Skill
  $ vat agent build agent-generator --target skill     # Explicit target
  $ vat agent build ./my-agent --output ./my-skill     # Custom output path
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
  0 - Success  |  1 - Execution error  |  2 - System error

Examples:
  $ vat agent run agent-generator "Create a code review agent"
  $ vat agent run ./my-agent "analyze this code"
  $ vat agent run my-agent "help me with..." --debug

Requirements:
  - ANTHROPIC_API_KEY environment variable (for Anthropic-based agents)
  - Valid agent manifest with prompts configured
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
  Validates agent manifest schema (using @vibe-agent-toolkit/agent-schema),
  LLM configuration, tool definitions, and resource availability. Outputs
  YAML validation report to stdout, errors to stderr.

  Argument: agent name OR path to agent directory/manifest file

Validation Checks:
  - Manifest schema (apiVersion, kind, metadata, spec)
  - LLM provider and model configuration
  - Tool configurations (RAG databases)
  - Resource files (prompts, docs, templates)
  - Prompt references ($ref paths)

Exit Codes:
  0 - Valid  |  1 - Validation errors  |  2 - System error

Examples:
  $ vat agent validate agent-generator          # Validate by name
  $ vat agent validate ./my-agent               # Validate by path
  $ vat agent validate ./agent.yaml             # Validate specific file
`
    );

  agent
    .command('audit [path]')
    .description('Audit Claude plugins, marketplaces, registries, and skills')
    .option('-r, --recursive', 'Scan directories recursively for all resource types')
    .option('--debug', DEBUG_OPTION_DESC)
    .action(auditCommand)
    .addHelpText(
      'after',
      `
Description:
  Audits Claude plugins, marketplaces, registries, and Claude Skills for
  quality, correctness, and compatibility. Automatically detects resource
  type and validates accordingly. Outputs YAML report to stdout,
  errors/warnings to stderr.

  Supported resource types:
  - Plugin directories (.claude-plugin/plugin.json)
  - Marketplace directories (.claude-plugin/marketplace.json)
  - Registry files (installed_plugins.json, known_marketplaces.json)
  - Claude Skills (SKILL.md files)
  - VAT agents (agent.yaml + SKILL.md)

  Path can be: resource directory, registry file, SKILL.md file, or scan directory
  Default: current directory

Validation Checks:
  Errors (must fix):
  - Missing or invalid manifests/frontmatter
  - Schema validation failures
  - Broken links to other files (Skills only)
  - Reserved words in names (Skills only)
  - XML tags in frontmatter fields (Skills only)
  - Windows-style backslashes in paths (Skills only)

  Warnings (should fix):
  - Skill exceeds recommended length (>5000 lines)
  - References console-incompatible tools (Skills only)

Exit Codes:
  0 - Success  |  1 - Errors found  |  2 - System error

Examples:
  $ vat agent audit                          # Audit current directory
  $ vat agent audit ./my-plugin              # Audit plugin directory
  $ vat agent audit installed_plugins.json   # Audit registry file
  $ vat agent audit ./resources --recursive  # Audit all resources recursively
`
    );

  agent
    .command('import <skillPath>')
    .description('Import Claude Skill (SKILL.md) to VAT agent format (agent.yaml)')
    .option('-o, --output <path>', 'Output path for agent.yaml (default: same directory as SKILL.md)')
    .option('-f, --force', 'Overwrite existing agent.yaml')
    .option('--debug', DEBUG_OPTION_DESC)
    .action(importCommand)
    .addHelpText(
      'after',
      `
Description:
  Converts a third-party Claude Skill (SKILL.md) to VAT agent format
  (agent.yaml). Validates the skill frontmatter and creates a proper VAT
  agent manifest with the claude-skills runtime.

  Use this to import existing Claude Skills into your VAT project for
  further customization or to use with VAT's build and deployment tools.

Conversion:
  - Extracts name, description, license from SKILL.md frontmatter
  - Creates agent.yaml with runtime: claude-skills
  - Preserves version from metadata.version or defaults to 0.1.0
  - Validates frontmatter before conversion

Exit Codes:
  0 - Success  |  1 - Validation/conversion error  |  2 - System error

Examples:
  $ vat agent import ./my-skill/SKILL.md              # Import to same directory
  $ vat agent import ./SKILL.md -o ./agent.yaml       # Custom output path
  $ vat agent import ./SKILL.md --force               # Overwrite existing
`
    );

  agent
    .command('install <agentName>')
    .description('Install agent to Claude Skills directory')
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
  Installs a built agent skill to Claude Skills directory. By default,
  copies to user scope (~/.claude/skills/). Use --dev for symlink mode
  (rapid development iteration).

Scopes:
  - user: ~/.claude/skills/ (default, personal skills)
  - project: ./.claude/skills/ (project-local skills)

Exit Codes:
  0 - Success  |  1 - Installation error  |  2 - System error

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
    .description('Uninstall agent from Claude Skills directory')
    .option(SCOPE_OPTION, SCOPE_OPTION_DESC, SCOPE_DEFAULT)
    .option(RUNTIME_OPTION, RUNTIME_OPTION_DESC, RUNTIME_DEFAULT)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(uninstallAgent)
    .addHelpText(
      'after',
      `
Description:
  Removes an installed agent skill from Claude Skills directory.
  Handles both copied installations and symlinks.

Scopes:
  - user: ~/.claude/skills/ (default)
  - project: ./.claude/skills/

Exit Codes:
  0 - Success  |  1 - Not installed  |  2 - System error

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
  - user: Only ~/.claude/skills/
  - project: Only ./.claude/skills/

Output:
  YAML summary → stdout (for programmatic parsing)
  Human-readable list → stderr

Exit Codes:
  0 - Success  |  2 - System error

Examples:
  $ vat agent installed                    # List all installed skills
  $ vat agent installed --scope user       # Only user scope
  $ vat agent installed --scope project    # Only project scope
`
    );

  return agent;
}

export { showAgentVerboseHelp } from './help.js';
