# CLI Package Development Guidelines

This document provides guidance specific to developing the vat CLI tool.

## Writing Useful CLI Help Documentation

**Golden Rule**: Help text should answer "What does this do?" and "How do I use it?" without requiring users to read external documentation.

### Principles for Effective CLI Help

#### 1. Be Descriptive, Not Terse

❌ **Bad**: "Validate resources"
✅ **Good**: "Validate markdown resources (link integrity, anchors)"

❌ **Bad**: "Scan directory"
✅ **Good**: "Discover markdown resources in directory and report statistics"

**Why**: Users need to understand what the command actually does before running it.

#### 2. Document What Happens

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

#### 3. Explain Output Format

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

#### 4. Document Exit Codes

Critical for scripting and CI/CD:

```typescript
Exit Codes:
  0 - All validations passed
  1 - Validation errors found (broken links, missing anchors)
  2 - System error (config invalid, directory not found, etc.)
```

**Why**: Scripts need to know when to fail builds, send alerts, etc.

#### 5. Show One Good Example

**Principle**: One example is good, two is too many. Help text is not a tutorial.

Show the **most common use case** that demonstrates the command clearly:

**Pattern**:
```typescript
Example:
  $ vat resources validate docs/        # Validate markdown in docs folder
```

If you need to show advanced usage, put it in verbose help (`--help --verbose`) or documentation.

**Why**: Users scan help text. Too many examples → information overload → users skip everything.

#### 6. Clarify Design Decisions

When something might surprise users, explain why:

```typescript
Validation Checks:
  - Internal file links (relative paths)
  - Anchor links within files (#heading)
  - Cross-file anchor links (file.md#heading)
  - External URLs are NOT validated (by design)
```

**Why**: Prevents user confusion and support requests.

#### 7. Keep It Concise

**Less is more**. Every line in help text should earn its place.

✅ **Do**: Essential information only
❌ **Don't**: Repeat information users already know
❌ **Don't**: Multiple examples when one suffices
❌ **Don't**: Verbose explanations of obvious things

Users who need more detail will use `--help --verbose` or read the docs.

### Commander.js Patterns

#### Basic Command with Enhanced Help

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

#### Command Group with Example

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

### Help Text Organization

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

### Testing Help Text

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

### Anti-Patterns to Avoid

❌ **Don't**: Use terse descriptions
"Validate resources" tells users nothing useful

❌ **Don't**: Assume users know the output format
They won't know if it's YAML, JSON, or plain text

❌ **Don't**: Hide exit codes
Scripts and CI systems need this information

❌ **Don't**: Skip examples
Examples are the fastest way for users to understand

❌ **Don't**: Leave design decisions unexplained
"Why doesn't it validate external URLs?" will be asked

❌ **Don't**: Forget about piping
UNIX users expect `--help | less` to work (stdout, not stderr)

### When to Use Verbose Help

Use `--help --verbose` for:
- Comprehensive reference documentation
- Configuration file schemas
- Advanced usage patterns
- Architecture explanations
- Links to external resources

Regular `--help` should be complete enough for 90% of use cases.

## Command Implementation Patterns

### Command File Structure

```typescript
// commands/mycommand.ts
export interface MyCommandOptions {
  debug?: boolean;
  // ... other options
}

export async function myCommand(
  pathArg: string | undefined,
  options: MyCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // 1. Validate inputs
    // 2. Process
    // 3. Output results (YAML to stdout)
    // 4. Exit with appropriate code

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MyCommand');
  }
}
```

### Output Conventions

**Structured output (YAML)** → stdout
**Human-readable errors** → stderr
**Exit codes**: 0 = success, 1 = expected failure, 2 = unexpected error

This enables:
```bash
vat command | jq .status           # Parse YAML
vat command 2>&1 | less            # View all output
vat command > results.yaml         # Save results
vat command && echo "Success"      # Use in scripts
```

### Error Handling

Use the `handleCommandError` helper for consistent error handling:

```typescript
try {
  // Command implementation
} catch (error) {
  handleCommandError(error, logger, startTime, 'CommandName');
  // handleCommandError calls process.exit() internally
}
```

This ensures:
- Consistent error format
- Duration logging
- Proper exit codes (1 for expected errors, 2 for unexpected)

## Testing CLI Commands

### System Tests

Create system tests in `test/system/` for end-to-end CLI testing:

```typescript
describe('MyCommand (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-mycommand-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle basic usage', () => {
    const { result, parsed } = executeCommandAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should handle errors correctly', () => {
    // Test error scenarios with exit code 1 or 2
  });
});
```

### Help Text Tests

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

## Documentation Maintenance

### CLI Help Documentation

The CLI help documentation lives in `packages/cli/docs/*.md`:
- `docs/index.md` - Root level verbose help (`vat --help --verbose`)
- `docs/resources.md` - Resources command verbose help (`vat resources --help --verbose`)

These markdown files are the single source of truth and are:
- Loaded at runtime by the CLI via `help-loader.ts`
- Included in the published npm package (in the `files` array)
- Browsable on GitHub and npm

**This ensures documentation never drifts from actual CLI behavior** - there is only one source.

### When to Update Help Text

Update help text when:
- ✅ Adding new commands or options
- ✅ Changing command behavior
- ✅ Adding new output fields
- ✅ Changing exit code meanings
- ✅ Users report confusion (help wasn't clear)

Don't wait to update help - do it in the same PR as the feature.

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

**Remember**: If you have to explain something in a GitHub issue or Slack, that explanation should be in the help text.
