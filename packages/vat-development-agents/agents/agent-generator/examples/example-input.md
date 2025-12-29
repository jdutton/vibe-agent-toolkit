# Example Input: PR Review Agent

## User Input Scenario

User provides structured input:

```json
{
  "agentPurpose": "Review pull requests for security vulnerabilities and suggest fixes",
  "successCriteria": "Identifies 100% of critical security issues with less than 10% false positive rate",
  "typicalInputs": "GitHub PR URL or git diff content",
  "expectedOutputs": "Structured feedback with severity levels: { file, line, severity, message, suggestion }",
  "domainContext": "OWASP Top 10, secure coding standards for Python and JavaScript",
  "performanceRequirements": {
    "latency": "Under 30 seconds for typical PRs (<500 lines changed)",
    "accuracy": "Must catch all critical/high severity issues",
    "cost": "Medium priority - accuracy matters more than cost"
  },
  "additionalContext": "Similar to GitHub Advanced Security but focused on security only. Must work in CI/CD."
}
```

## Rendered Prompt

```markdown
I want to create a new agent. Here's what I'm thinking:

[User's free-form description would go here if provided]

**Purpose:** Review pull requests for security vulnerabilities and suggest fixes

**Success looks like:** Identifies 100% of critical security issues with less than 10% false positive rate

**Typical inputs:** GitHub PR URL or git diff content

**Expected outputs:** Structured feedback with severity levels: { file, line, severity, message, suggestion }

**Domain context:** OWASP Top 10, secure coding standards for Python and JavaScript

**Performance requirements:**
- Latency: Under 30 seconds for typical PRs (<500 lines changed)
- Accuracy: Must catch all critical/high severity issues
- Cost: Medium priority - accuracy matters more than cost

**Additional context:** Similar to GitHub Advanced Security but focused on security only. Must work in CI/CD.

Help me design this agent!
```

## Expected Agent Behavior

1. **GATHER**: Confirms understanding, asks clarifying questions
2. **ANALYZE**: Identifies as "code analysis agent", asks about:
   - What languages to support
   - Integration requirements
   - Severity classification approach
3. **DESIGN**: Proposes architecture:
   - LLM: Claude Sonnet 4.5 (code understanding + security knowledge)
   - Tools: file-reader, github-api (optional)
   - Prompts: Security expert system prompt, structured diff user template
   - Resources: OWASP checklist, language-specific security patterns
4. **GENERATE**: Creates complete agent package with validation
