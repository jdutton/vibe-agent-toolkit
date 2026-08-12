---
paths:
  - "packages/cli/src/commands/**/*.ts"
  - "packages/cli/docs/*.md"
---

# You are writing or editing `--help` text — it is the user's manual, write it like one

**Golden Rule**: Help text should answer "What does this do?" and "How do I use it?" without
requiring users to read external documentation.

## Principles for Effective CLI Help

### 1. Be Descriptive, Not Terse

❌ **Bad**: "Validate resources"
✅ **Good**: "Validate markdown resources (link integrity, anchors)"

❌ **Bad**: "Scan directory"
✅ **Good**: "Discover markdown resources in directory and report statistics"

**Why**: Users need to understand what the command actually does before running it.

### 2. Document What Happens

Every command should explain:
- **Input**: What does it operate on? (files, directories, config)
- **Processing**: What does it check/do?
- **Output**: What does it produce? (format, destination)
- **Side effects**: Does it modify anything?

**Example**:
```typescript
.addHelpText('after', `
Description:
  Validates all markdown files for broken links, missing anchors, and
  invalid references. Outputs YAML summary to stdout and test-format
  errors to stderr.

  Default path: current directory
  Respects: vibe-agent-toolkit.config.yaml include/exclude patterns
`)
```

### 3. Explain Output Format

Users need to know:
- What format is the output? (YAML, JSON, plain text)
- Where does it go? (stdout, stderr, file)
- What fields/structure to expect?

**Example**:
```typescript
Output:
  - status: success/error
  - filesScanned: number of markdown files found
  - linksFound: total links discovered
  - duration: scan time in milliseconds

Output Format:
  YAML summary → stdout (for programmatic parsing)
  Error details → stderr (file:line:column: message)
```

### 4. Document Exit Codes

Critical for scripting and CI/CD:

```typescript
Exit Codes:
  0 - All validations passed
  1 - Validation errors found (broken links, missing anchors)
  2 - System error (config invalid, directory not found, etc.)
```

**Why**: Scripts need to know when to fail builds, send alerts, etc.

### 5. Show One Good Example

**Principle**: One example is good, two is too many. Help text is not a tutorial.

Show the **most common use case** that demonstrates the command clearly:

**Pattern**:
```typescript
Example:
  $ vat resources validate docs/        # Validate markdown in docs folder
```

If you need to show advanced usage, put it in verbose help (`--help --verbose`) or documentation.

**Why**: Users scan help text. Too many examples → information overload → users skip everything.

### 6. Clarify Design Decisions

When something might surprise users, explain why:

```typescript
Validation Checks:
  - Internal file links (relative paths)
  - Anchor links within files (#heading)
  - Cross-file anchor links (file.md#heading)
  - External URLs (only with --check-external-urls flag — off by default, slow operation)
```

**Why**: Prevents user confusion and support requests.

### 7. Keep It Concise

**Less is more**. Every line in help text should earn its place.

✅ **Do**: Essential information only
❌ **Don't**: Repeat information users already know
❌ **Don't**: Multiple examples when one suffices
❌ **Don't**: Verbose explanations of obvious things

Users who need more detail will use `--help --verbose` or read the docs.

## Commander.js Patterns

### Basic Command with Enhanced Help

```typescript
program
  .command('mycommand [arg]')
  .description('Short one-line description for command list')
  .option('-d, --debug', 'Enable debug logging')
  .action(myCommandHandler)
  .addHelpText('after', `
Description:
  Detailed explanation of what this command does and what users
  should expect. Keep it under 3 sentences.

Output:
  - field1: description of field
  - field2: description of field

Example:
  $ vat mycommand docs/         # Most common use case
`);
```

### Command Group with Example

```typescript
const group = new Command('groupname');

group
  .description('Brief description of command group')
  .helpCommand(false)  // Remove redundant help command
  .addHelpText('after', `
Example:
  $ vat groupname subcommand docs/    # Most common workflow

Configuration:
  Create config.yaml in project root. See --help --verbose for details.
`);
```

## Help Text Organization

Use this structure for `.addHelpText('after', ...)`:

```
Description:
  [2-3 sentences max - what it does, input, output]

[Optional command-specific section]:
  Validation Checks: / Output Fields: / etc.
  - Brief bullets only if essential

Exit Codes: (only for commands with multiple exit codes)
  0 - Success
  1 - Validation/expected failures
  2 - System/unexpected errors

Example:  (singular - one example only)
  $ command common-case         # The most typical usage
```

**Remember**: Brevity beats completeness. When in doubt, remove text.

## Testing Help Text

Always test help output:

```bash
# Test all help variations
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js resources --help
node packages/cli/dist/bin.js resources scan --help
node packages/cli/dist/bin.js resources validate --help

# Test piping (help should go to stdout)
node packages/cli/dist/bin.js --help | less
node packages/cli/dist/bin.js --help | grep validate
```

Add tests to verify help text contains key information:

```typescript
it('should show comprehensive help', () => {
  const result = spawnSync('node', [binPath, 'mycommand', '--help'], {
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Description:');
  expect(result.stdout).toContain('Examples:');
  expect(result.stdout).toContain('Exit Codes:');
});
```

## When to Use Verbose Help

Use `--help --verbose` for:
- Comprehensive reference documentation
- Configuration file schemas
- Advanced usage patterns
- Architecture explanations
- Links to external resources

Regular `--help` should be complete enough for 90% of use cases.

## When to Update Help Text

Update help text when:
- ✅ Adding new commands or options
- ✅ Changing command behavior
- ✅ Adding new output fields
- ✅ Changing exit code meanings
- ✅ Users report confusion (help wasn't clear)

Don't wait to update help - do it in the same PR as the feature.

**Remember**: If you have to explain something in a GitHub issue or Slack, that explanation
should be in the help text.

## Summary Checklist

When adding a new CLI command, ensure:

- [ ] Short description (for command list)
- [ ] Detailed description (what it does)
- [ ] Default behavior explained
- [ ] Output format documented
- [ ] Exit codes documented (if not 0-only)
- [ ] At least 3 examples (basic, intermediate, advanced)
- [ ] Configuration usage explained (if applicable)
- [ ] Design decisions clarified (if surprising)
- [ ] Help text goes to stdout (not stderr)
- [ ] System tests cover the command
- [ ] CLI reference docs regenerated
