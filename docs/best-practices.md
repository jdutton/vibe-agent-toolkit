# Enterprise Software Development Best Practices

Apply these industry-standard practices regardless of what this monorepo is used for.

## Core Principles

Follow these established patterns:
- **SOLID Principles**: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion
- **DRY**: Don't Repeat Yourself - extract to shared packages in monorepo context
- **TDD**: Test-Driven Development - Red-Green-Refactor cycle
- **Clean Code**: Robert C. Martin's principles
- **KISS**: Keep It Simple, Stupid
- **YAGNI**: You Aren't Gonna Need It

## Monorepo-Specific DRY Application

When you see duplication across packages:
1. Extract to shared utilities package (utils, or create new shared-* package)
2. Use constants objects for configuration
3. Share TypeScript types via dedicated types in schemas
4. Extract reusable build logic to helper functions

Wait for 3+ instances before extracting (avoid premature abstraction).

## Error Handling Patterns

Use these approaches:
- **Typed Errors**: Custom error classes (ValidationError, NotFoundError, etc.)
- **Result Types**: `Result<T, E>` for expected failures (see functional programming patterns)
- **Fail Fast**: Validate inputs early, throw immediately on invalid state
- **Zod Validation**: Use Zod's `.safeParse()` for runtime validation with typed errors

## Code Quality Standards

### TypeScript

- No `any` in production code (use `unknown` if truly dynamic)
- Explicit return types on all functions
- Use type guards for narrowing
- Prefer Zod schemas over manual type guards for runtime validation

### Testing

- TDD for business logic
- Test error paths (don't just test happy path)
- Use descriptive test names: `should [behavior] when [condition]`

### Documentation

- JSDoc for public APIs with @param, @returns, @example
- Inline comments explain WHY, not WHAT
- README per package: purpose, installation, quick start, API
- Document Zod schemas with `.describe()` for auto-generated JSON Schema descriptions

## Code Review Checklist

- [ ] No `console.log` in production (use proper logging)
- [ ] No hardcoded secrets
- [ ] No `@ts-ignore` without explanation
- [ ] No `any` without justification
- [ ] Tests exist and cover edge cases
- [ ] Cross-platform compatible (paths, line endings)
- [ ] DRY: no duplication that should be extracted
- [ ] Zod schemas have `.describe()` for documentation
- [ ] CLI commands have clear help text

## Technical Debt Management

### Duplication Management - ZERO TOLERANCE

- **Goal**: Maintain 0 duplicates in `.github/.jscpd-baseline.json`
- **Policy**: See CLAUDE.md "CRITICAL: Code Duplication Policy" section
- **For AI assistants**: NEVER update baseline without explicit user permission
- **Workflow**: When duplication is detected → refactor to eliminate → re-run check
- **Rationale**: Baseline exists to track progress towards zero, not to accept new duplication

Tools available:
- `bun run duplication-check` - Verify no new duplication (run this)
- `bun run duplication-update-baseline` - Update baseline (REQUIRES USER PERMISSION)

### TODO Format

```typescript
// TODO(username, YYYY-MM-DD): Reason and context
```

## Monorepo-Specific Patterns

- **Package Boundaries**: Each package independently useful, avoid circular deps
- **Shared Code**: Use utils package, version carefully (breaking changes affect all consumers)
- **Build Order**: Respect dependency graph, use TypeScript project references
- **Testing**: Test packages in isolation + integration between packages
