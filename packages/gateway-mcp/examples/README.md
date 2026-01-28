# MCP Gateway Examples

Examples demonstrating how to expose VAT agents through MCP.

## Examples

### Haiku Validator Server

Exposes the haiku-validator agent (Pure Function Tool) via MCP stdio transport.

**Run locally:**
```bash
bun run examples/haiku-validator-server.ts
```

**Claude Desktop configuration:**

Add to `~/.claude/config.json`:
```json
{
  "mcpServers": {
    "vat-haiku": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/vibe-agent-toolkit/packages/gateway-mcp/examples/haiku-validator-server.ts"]
    }
  }
}
```

**Usage in Claude Desktop:**
1. Restart Claude Desktop after updating config
2. Ask Claude: "Can you validate this haiku for me?"
3. Provide a haiku (3 lines)
4. Claude will call the `haiku-validator` tool

**Example conversation:**
```
User: Can you validate this haiku?
      Spring cherry blossoms
      Petals dance in gentle breeze
      New life awakens

Claude: [calls haiku-validator tool]

Tool result:
{
  "valid": true,
  "syllables": {
    "line1": 5,
    "line2": 7,
    "line3": 5
  },
  "errors": [],
  "hasKigo": true,
  "hasKireji": false
}

Claude: Your haiku is valid! It follows the traditional 5-7-5 syllable
        structure perfectly. It also contains a seasonal reference (kigo)
        with "Spring cherry blossoms". However, it doesn't have a cutting
        word (kireji) like an em dash or ellipsis that creates a pause
        or juxtaposition.
```

### Photo Analyzer Server

Exposes the photo-analyzer agent (One-Shot LLM Analyzer) via MCP stdio transport.

**Note:** Currently uses mock mode (analyzes filename patterns). Real vision API integration coming in Phase 2.

**Run locally:**
```bash
bun run examples/photo-analyzer-server.ts
```

**Claude Desktop configuration:**

Add to `~/.claude/config.json`:
```json
{
  "mcpServers": {
    "vat-photo": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/vibe-agent-toolkit/packages/gateway-mcp/examples/photo-analyzer-server.ts"]
    }
  }
}
```

**Usage in Claude Desktop:**
1. Restart Claude Desktop after updating config
2. Ask Claude: "Can you analyze this cat photo?"
3. Provide a filename (e.g., "orange-tabby-playing.jpg")
4. Claude will call the `photo-analyzer` tool

**Example conversation:**
```
User: Can you analyze this cat photo: "siamese-blue-eyes-portrait.jpg"?

Claude: [calls photo-analyzer tool]

Tool result:
{
  "breed": "Siamese",
  "colors": ["cream", "brown"],
  "confidence": 0.85,
  "features": ["blue eyes", "color-point pattern"],
  "analysis": "Classic Siamese with traditional color-point markings"
}

Claude: This appears to be a Siamese cat (85% confidence). The photo shows
        their distinctive color-point pattern with a cream base and brown
        points. The blue eyes are a classic Siamese feature that stands out
        in this portrait.
```

### Combined Multi-Agent Server

Demonstrates exposing multiple VAT agents through a single MCP server, showing agent composition and tool orchestration.

**Agents included:**
- `haiku-validator` - Pure Function Tool (validates haiku structure)
- `photo-analyzer` - One-Shot LLM Analyzer (analyzes cat photos)

**Run locally:**
```bash
bun run examples/combined-server.ts
```

**Claude Desktop configuration:**

Add to `~/.claude/config.json`:
```json
{
  "mcpServers": {
    "vat-agents": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/vibe-agent-toolkit/packages/gateway-mcp/examples/combined-server.ts"]
    }
  }
}
```

**Usage in Claude Desktop:**
1. Restart Claude Desktop after updating config
2. Both agents are available as tools
3. Claude can orchestrate multiple tools in a single conversation

**Example conversation:**
```
User: Write a haiku about a Siamese cat, validate it, then analyze a photo
      of the cat from "siamese-lounging.jpg"

Claude: Let me create a haiku first:

        Blue eyes pierce the dark
        Cream and chocolate contrasts
        Siamese serene

        [calls haiku-validator tool]

        Great! The haiku is valid (5-7-5 structure). Now let me analyze
        the photo.

        [calls photo-analyzer tool]

        The photo shows a Siamese cat in a relaxed lounging position.
        The analysis confirms the breed with 90% confidence, noting the
        distinctive color-point pattern and blue eyes I mentioned in the haiku!
```

## Phase 2 Examples (Coming Soon)

- Conversational breed advisor (Multi-turn conversation with state management)
