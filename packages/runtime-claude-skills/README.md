# @vibe-agent-toolkit/runtime-claude-skills

Build and package VAT agents as Claude Skills for Claude Desktop and Claude Code.

## Features

- Generate SKILL.md from agent manifests
- Package agent resources in Claude Skills format
- Support for tools and resource references
- Automatic resource directory copying

## Installation

```bash
bun add @vibe-agent-toolkit/runtime-claude-skills
```

## Usage

```typescript
import { buildClaudeSkill } from '@vibe-agent-toolkit/runtime-claude-skills';

await buildClaudeSkill({
  agentPath: './my-agent',
  outputPath: './dist/skills/my-agent',
});
```

## API

### `buildClaudeSkill(options: BuildOptions): Promise<BuildResult>`

Build a Claude Skill from a VAT agent.

**Parameters**:
- `agentPath` - Path to agent directory or manifest file
- `outputPath` - Where to write the skill bundle

**Returns**: Build result with output path and metadata

## License

MIT
