/**
 * Agent command group
 */

import { Command } from 'commander';

import { buildCommand } from './build.js';
import { listCommand } from './list.js';
import { runCommand } from './run.js';
import { validateCommand } from './validate.js';

const DEBUG_OPTION_DESC = 'Enable debug logging';

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

  return agent;
}

export { showAgentVerboseHelp } from './help.js';
