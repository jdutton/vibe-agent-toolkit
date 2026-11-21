---
name: mcp-tools
description: Pins what the text detectors report for this fixture. It exists only for tests.
allowed-tools: [mcp__demo__fm_only_tool]
---
# MCP tools

[vocab](references/with-vocab.md) [fmonly](references/frontmatter-only.md) [open](references/unterminated-fence.md) [trim](references/trimmed-fence.md) [lead](references/leading-blank.md)

Qualified spellings, each on its own line:
Claude Code form: `mcp__demo__list_items`
Claude Code form: `mcp__demo__get_item`
API form: `ToolHub:fetch_rows`
API lowercase server seeds nothing: `toolhub:fetch_other_rows`
camelCase tool: `mcp__demo__createIssue`
Hyphenated tool: `mcp__demo-srv__resolve-id`
Hyphenated plugin server: `mcp__plugin_demo-plug_srv__query-docs`
Single word seeds nothing: `mcp__demo__find`
Trailing separator: `mcp__demo__do_thing_`
Double underscore in tool: `mcp__zap__mail__send_it`
Node builtin seeds nothing: `node:child_process`
Scope string seeds nothing: whiteboard:read:list_whiteboards

Bare spellings, each on its own line:
Bare span: call `list_items` first.
Bare span with spaces: call ` get_item ` next.
Same twice on a line: `list_items` then `list_items` again.
Two different tools on a line: `list_items` and `get_item`.
Prose only: list_items is discussed without backticks.
Bare API: `fetch_rows`
Bare lowercase server: `fetch_other_rows`
Bare camelCase: `createIssue`
Bare hyphenated: `resolve-id`
Bare hyphenated plugin: `query-docs`
Bare single word: `find`
Bare trailing separator: `do_thing`
Bare after double underscore: `mail__send_it`
Bare builtin: `child_process`
Bare scope tool: `list_whiteboards`
Frontmatter only name: `fm_only_tool`
Not exactly a name: `list_items()` and `list_items_extra`

Gloss line: `list_items` is `mcp__demo__list_items` here.
Qualify A, name B bare: `mcp__demo__get_item` then `list_items`.
Qualify B, name A bare: `get_item` then `mcp__demo__list_items`.

Fence:
```text
`list_items` inside a fence is still a span on that line
```
