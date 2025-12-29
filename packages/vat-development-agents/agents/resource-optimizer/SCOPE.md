# resource-optimizer: Agent Resource Analysis for Context Efficiency

## Purpose

The resource-optimizer agent analyzes agent resource files (markdown, text, JSON, YAML) to identify opportunities for improving context efficiency. Following Anthropic's principle of "smallest high-signal tokens," it evaluates whether resources contain redundant information, unclear descriptions, overly broad content, or poor structural organization that wastes valuable LLM context budget.

## Problem Statement

Agent resources often accumulate inefficiencies over time:

1. **Redundancy**: Multiple resources duplicate the same information
2. **Low Signal-to-Noise**: Verbose descriptions that could be more concise
3. **Overly Broad Scope**: Resources that try to cover too much ground
4. **Poor Structure**: Information buried in walls of text instead of scannable sections
5. **Outdated Content**: Examples or instructions that no longer apply

These inefficiencies waste precious context tokens, reducing agent effectiveness and increasing costs.

## Input/Output Interface

### Input Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "analysisScope": {
      "type": "object",
      "description": "Defines what resources to analyze",
      "properties": {
        "resourcePaths": {
          "type": "array",
          "description": "Specific resource files to analyze",
          "items": {
            "type": "string"
          }
        },
        "resourceDirectory": {
          "type": "string",
          "description": "Directory containing resources to analyze (recursive)"
        },
        "includePatterns": {
          "type": "array",
          "description": "Glob patterns for files to include (e.g., '**/*.md')",
          "items": {
            "type": "string"
          },
          "default": ["**/*.md", "**/*.txt", "**/*.json", "**/*.yaml", "**/*.yml"]
        },
        "excludePatterns": {
          "type": "array",
          "description": "Glob patterns for files to exclude (e.g., 'node_modules/**')",
          "items": {
            "type": "string"
          },
          "default": ["node_modules/**", ".git/**", "dist/**", "build/**"]
        }
      },
      "oneOf": [
        { "required": ["resourcePaths"] },
        { "required": ["resourceDirectory"] }
      ]
    },
    "analysisOptions": {
      "type": "object",
      "description": "Configuration for analysis behavior",
      "properties": {
        "checkRedundancy": {
          "type": "boolean",
          "description": "Check for duplicate content across resources",
          "default": true
        },
        "checkClarity": {
          "type": "boolean",
          "description": "Evaluate description clarity and conciseness",
          "default": true
        },
        "checkSpecificity": {
          "type": "boolean",
          "description": "Assess whether scope is appropriately narrow",
          "default": true
        },
        "checkStructure": {
          "type": "boolean",
          "description": "Evaluate information organization and scannability",
          "default": true
        },
        "minTokenSavings": {
          "type": "integer",
          "description": "Minimum estimated token savings to report an issue",
          "default": 50,
          "minimum": 0
        },
        "severityThreshold": {
          "type": "string",
          "description": "Minimum severity level to report",
          "enum": ["info", "minor", "moderate", "major", "critical"],
          "default": "minor"
        }
      }
    },
    "comparisonBaseline": {
      "type": "object",
      "description": "Optional baseline for comparison (e.g., previous version)",
      "properties": {
        "baselineDirectory": {
          "type": "string",
          "description": "Directory containing baseline resources"
        },
        "baselineCommit": {
          "type": "string",
          "description": "Git commit SHA to compare against"
        }
      }
    }
  },
  "required": ["analysisScope"]
}
```

### Output Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "summary": {
      "type": "object",
      "description": "High-level analysis summary",
      "properties": {
        "totalResources": {
          "type": "integer",
          "description": "Total number of resources analyzed"
        },
        "totalTokens": {
          "type": "integer",
          "description": "Total estimated tokens in analyzed resources"
        },
        "issuesFound": {
          "type": "integer",
          "description": "Total number of efficiency issues identified"
        },
        "potentialTokenSavings": {
          "type": "integer",
          "description": "Estimated tokens that could be saved by addressing issues"
        },
        "efficiencyScore": {
          "type": "number",
          "description": "Overall efficiency score (0-100, higher is better)",
          "minimum": 0,
          "maximum": 100
        }
      },
      "required": [
        "totalResources",
        "totalTokens",
        "issuesFound",
        "potentialTokenSavings",
        "efficiencyScore"
      ]
    },
    "resourceAnalysis": {
      "type": "array",
      "description": "Detailed analysis per resource",
      "items": {
        "type": "object",
        "properties": {
          "resourcePath": {
            "type": "string",
            "description": "Path to the analyzed resource"
          },
          "tokenCount": {
            "type": "integer",
            "description": "Estimated token count for this resource"
          },
          "issues": {
            "type": "array",
            "description": "Efficiency issues found in this resource",
            "items": {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "description": "Type of efficiency issue",
                  "enum": [
                    "redundancy",
                    "clarity",
                    "specificity",
                    "structure",
                    "outdated"
                  ]
                },
                "severity": {
                  "type": "string",
                  "description": "Severity of the issue",
                  "enum": ["info", "minor", "moderate", "major", "critical"]
                },
                "description": {
                  "type": "string",
                  "description": "Human-readable description of the issue"
                },
                "location": {
                  "type": "object",
                  "description": "Location of the issue within the resource",
                  "properties": {
                    "startLine": {
                      "type": "integer",
                      "description": "Starting line number (1-indexed)"
                    },
                    "endLine": {
                      "type": "integer",
                      "description": "Ending line number (1-indexed)"
                    },
                    "section": {
                      "type": "string",
                      "description": "Section heading or context"
                    }
                  }
                },
                "estimatedTokenWaste": {
                  "type": "integer",
                  "description": "Estimated tokens wasted by this issue"
                },
                "recommendation": {
                  "type": "string",
                  "description": "Specific recommendation for addressing the issue"
                },
                "examples": {
                  "type": "object",
                  "description": "Optional before/after examples",
                  "properties": {
                    "before": {
                      "type": "string",
                      "description": "Current inefficient content"
                    },
                    "after": {
                      "type": "string",
                      "description": "Suggested efficient content"
                    }
                  }
                },
                "relatedResources": {
                  "type": "array",
                  "description": "Other resources related to this issue (for redundancy)",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "type",
                "severity",
                "description",
                "estimatedTokenWaste",
                "recommendation"
              ]
            }
          },
          "efficiencyScore": {
            "type": "number",
            "description": "Efficiency score for this resource (0-100)",
            "minimum": 0,
            "maximum": 100
          }
        },
        "required": [
          "resourcePath",
          "tokenCount",
          "issues",
          "efficiencyScore"
        ]
      }
    },
    "crossResourceIssues": {
      "type": "array",
      "description": "Issues that span multiple resources",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "description": "Type of cross-resource issue",
            "enum": ["redundancy", "fragmentation", "inconsistency"]
          },
          "severity": {
            "type": "string",
            "enum": ["info", "minor", "moderate", "major", "critical"]
          },
          "description": {
            "type": "string",
            "description": "Description of the cross-resource issue"
          },
          "affectedResources": {
            "type": "array",
            "description": "Resources involved in this issue",
            "items": {
              "type": "string"
            }
          },
          "estimatedTokenWaste": {
            "type": "integer",
            "description": "Total estimated token waste across resources"
          },
          "recommendation": {
            "type": "string",
            "description": "Recommendation for resolution"
          }
        },
        "required": [
          "type",
          "severity",
          "description",
          "affectedResources",
          "estimatedTokenWaste",
          "recommendation"
        ]
      }
    },
    "recommendations": {
      "type": "object",
      "description": "Prioritized recommendations for improvement",
      "properties": {
        "highPriority": {
          "type": "array",
          "description": "Most impactful improvements to make",
          "items": {
            "type": "object",
            "properties": {
              "recommendation": {
                "type": "string"
              },
              "estimatedImpact": {
                "type": "string",
                "description": "High-level impact estimate"
              },
              "affectedResources": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": ["recommendation", "estimatedImpact"]
          }
        },
        "mediumPriority": {
          "type": "array",
          "description": "Moderate improvements worth considering",
          "items": {
            "type": "object",
            "properties": {
              "recommendation": {
                "type": "string"
              },
              "estimatedImpact": {
                "type": "string"
              }
            },
            "required": ["recommendation", "estimatedImpact"]
          }
        },
        "lowPriority": {
          "type": "array",
          "description": "Minor improvements (optional)",
          "items": {
            "type": "object",
            "properties": {
              "recommendation": {
                "type": "string"
              },
              "estimatedImpact": {
                "type": "string"
              }
            },
            "required": ["recommendation", "estimatedImpact"]
          }
        }
      },
      "required": ["highPriority"]
    }
  },
  "required": [
    "summary",
    "resourceAnalysis",
    "recommendations"
  ]
}
```

## Key Behaviors

### 1. Identify Redundancy

**Goal**: Detect duplicate or overlapping information across resources.

**Detection Method**:
- Semantic similarity analysis (embeddings) to find conceptually similar content
- Exact text matching for boilerplate or copied sections
- Pattern matching for repeated examples or code snippets

**Analysis**:
- Calculate token overlap between resources
- Identify which resource is the authoritative source
- Determine if duplication is intentional (cross-reference) or wasteful

**Recommendation**:
- Consolidate duplicate content into a single resource
- Replace duplicates with references or links
- Remove redundant examples if one suffices

**Example**:
```
Issue: Redundancy (Major)
Resources: agent-a/README.md, agent-b/README.md
Token Waste: 400 tokens

Description: Both READMEs contain identical "Getting Started with VAT" section (200 tokens each)

Recommendation: Move common "Getting Started" to docs/getting-started.md,
reference from both agent READMEs.

Estimated Savings: 350 tokens (accounting for reference overhead)
```

### 2. Check Clarity

**Goal**: Evaluate whether descriptions are concise and high-signal.

**Detection Method**:
- Analyze description length vs. information density
- Identify verbose phrases that can be condensed
- Detect unnecessary hedging language ("basically", "essentially", "kind of")
- Flag overly complex sentence structures

**Analysis**:
- Compare description token count to ideal range for content type
- Measure readability scores (Flesch-Kincaid, etc.)
- Identify opportunities for bullet points vs. prose

**Recommendation**:
- Provide condensed alternative wording
- Suggest structural improvements (tables, lists)
- Highlight unnecessary qualifiers or filler words

**Example**:
```
Issue: Clarity (Moderate)
Resource: agent-generator/SCOPE.md
Location: Lines 45-60 (Purpose section)
Token Waste: 80 tokens

Before (150 tokens):
"The purpose of this agent is essentially to help developers who are working
on creating new agents for the vibe-agent-toolkit by providing them with a
way to basically generate all the necessary scaffolding and boilerplate files
that they would otherwise have to create manually, which can be time-consuming
and error-prone, especially when you're trying to ensure consistency across
multiple agents."

After (70 tokens):
"Generates scaffolding and boilerplate files for new vibe-agent-toolkit agents,
ensuring consistency and reducing manual setup time."

Recommendation: Replace verbose explanation with concise description.
Use active voice and remove hedging language.

Estimated Savings: 80 tokens
```

### 3. Assess Specificity

**Goal**: Determine if resources have appropriate scope (not too broad, not too narrow).

**Detection Method**:
- Analyze breadth of topics covered vs. resource type
- Identify tangential information that doesn't serve the core purpose
- Detect overly generic content that lacks actionable detail

**Analysis**:
- Compare resource focus to stated purpose
- Identify sections that could be split into separate resources
- Flag content that belongs in different documentation layers (README vs. detailed docs)

**Recommendation**:
- Suggest splitting broad resources into focused ones
- Identify content to move to more appropriate locations
- Recommend removing tangential information

**Example**:
```
Issue: Specificity (Major)
Resource: agent-generator/SCOPE.md
Location: Lines 200-350 (Implementation Details section)
Token Waste: 500 tokens

Description: SCOPE.md contains detailed implementation code examples and
debugging strategies. This level of detail belongs in implementation docs,
not scope definition.

Recommendation:
1. Move implementation details to agent-generator/DESIGN.md
2. Keep only high-level approach in SCOPE.md
3. Replace details with reference: "See DESIGN.md for implementation approach"

Estimated Savings: 450 tokens from SCOPE.md (net positive after accounting
for DESIGN.md additions)
```

### 4. Evaluate Structure

**Goal**: Ensure information is organized for maximum scannability and retrieval.

**Detection Method**:
- Analyze heading hierarchy and nesting depth
- Identify "walls of text" (long paragraphs without breaks)
- Detect missing structural elements (tables of contents, summaries)
- Flag poor use of formatting (lists vs. prose, code blocks vs. inline)

**Analysis**:
- Measure section lengths and recommend chunking
- Evaluate heading clarity and hierarchy
- Identify opportunities for tables, diagrams, or other visual aids

**Recommendation**:
- Suggest restructuring for better scannability
- Recommend adding navigational aids (TOC, anchors)
- Propose format changes (prose → lists, inline → code blocks)

**Example**:
```
Issue: Structure (Moderate)
Resource: agent-generator/DESIGN.md
Location: Lines 100-250 (Configuration section)
Token Waste: 200 tokens

Description: Configuration options explained in prose paragraphs.
Information is hard to scan and compare.

Before (prose):
"The agent generator accepts several configuration options. The first option
is the agent name, which should follow kebab-case convention. The second
option is..."

After (table):
| Option | Format | Description | Example |
|--------|--------|-------------|---------|
| agentName | kebab-case | Agent identifier | task-analyzer |
| targetDir | path | Output directory | ./docs/agents |

Recommendation: Convert prose descriptions to structured table for faster
scanning and comparison.

Estimated Savings: 150 tokens (more concise) + improved retrieval accuracy
```

## Example Analysis

### Input: Analyze agent-generator resources

```json
{
  "analysisScope": {
    "resourceDirectory": "docs/agents/vat-development-agents/agent-generator"
  },
  "analysisOptions": {
    "checkRedundancy": true,
    "checkClarity": true,
    "checkSpecificity": true,
    "checkStructure": true,
    "minTokenSavings": 50,
    "severityThreshold": "minor"
  }
}
```

### Output: Analysis Report

```json
{
  "summary": {
    "totalResources": 4,
    "totalTokens": 12500,
    "issuesFound": 8,
    "potentialTokenSavings": 1800,
    "efficiencyScore": 78.5
  },
  "resourceAnalysis": [
    {
      "resourcePath": "docs/agents/vat-development-agents/agent-generator/SCOPE.md",
      "tokenCount": 5000,
      "issues": [
        {
          "type": "clarity",
          "severity": "moderate",
          "description": "Purpose section uses verbose, hedging language",
          "location": {
            "startLine": 45,
            "endLine": 60,
            "section": "Purpose"
          },
          "estimatedTokenWaste": 80,
          "recommendation": "Replace verbose explanation with concise active-voice description. Remove hedging words ('essentially', 'basically').",
          "examples": {
            "before": "The purpose of this agent is essentially to help developers who are working on creating new agents...",
            "after": "Generates scaffolding and boilerplate files for new vibe-agent-toolkit agents, ensuring consistency and reducing manual setup time."
          }
        },
        {
          "type": "specificity",
          "severity": "major",
          "description": "SCOPE.md contains implementation details that belong in DESIGN.md",
          "location": {
            "startLine": 200,
            "endLine": 350,
            "section": "Implementation Details"
          },
          "estimatedTokenWaste": 500,
          "recommendation": "Move implementation details to DESIGN.md. Keep only high-level approach in SCOPE.md with reference to DESIGN.md."
        }
      ],
      "efficiencyScore": 72.0
    },
    {
      "resourcePath": "docs/agents/vat-development-agents/agent-generator/DESIGN.md",
      "tokenCount": 4500,
      "issues": [
        {
          "type": "structure",
          "severity": "moderate",
          "description": "Configuration options described in prose instead of table",
          "location": {
            "startLine": 100,
            "endLine": 250,
            "section": "Configuration"
          },
          "estimatedTokenWaste": 200,
          "recommendation": "Convert configuration prose to structured table with columns: Option, Format, Description, Example."
        }
      ],
      "efficiencyScore": 81.5
    },
    {
      "resourcePath": "docs/agents/vat-development-agents/agent-generator/IMPLEMENTATION_PLAN.md",
      "tokenCount": 2000,
      "issues": [
        {
          "type": "structure",
          "severity": "minor",
          "description": "Long paragraphs in Task Breakdown section reduce scannability",
          "location": {
            "startLine": 50,
            "endLine": 150,
            "section": "Task Breakdown"
          },
          "estimatedTokenWaste": 100,
          "recommendation": "Break long task descriptions into bullet points. Add sub-headings for task phases."
        }
      ],
      "efficiencyScore": 85.0
    },
    {
      "resourcePath": "docs/agents/vat-development-agents/agent-generator/README.md",
      "tokenCount": 1000,
      "issues": [
        {
          "type": "redundancy",
          "severity": "minor",
          "description": "Installation instructions duplicate main repo README",
          "location": {
            "startLine": 10,
            "endLine": 25,
            "section": "Installation"
          },
          "estimatedTokenWaste": 80,
          "recommendation": "Replace installation section with: 'See main repo README for installation instructions.'",
          "relatedResources": [
            "README.md"
          ]
        }
      ],
      "efficiencyScore": 88.0
    }
  ],
  "crossResourceIssues": [
    {
      "type": "redundancy",
      "severity": "moderate",
      "description": "Agent naming conventions explained in both SCOPE.md and DESIGN.md",
      "affectedResources": [
        "docs/agents/vat-development-agents/agent-generator/SCOPE.md",
        "docs/agents/vat-development-agents/agent-generator/DESIGN.md"
      ],
      "estimatedTokenWaste": 150,
      "recommendation": "Define naming conventions once in DESIGN.md. Reference from SCOPE.md: 'Agent names follow conventions defined in DESIGN.md#naming-conventions'."
    }
  ],
  "recommendations": {
    "highPriority": [
      {
        "recommendation": "Move implementation details from SCOPE.md to DESIGN.md",
        "estimatedImpact": "Save 500 tokens, improve document focus",
        "affectedResources": [
          "docs/agents/vat-development-agents/agent-generator/SCOPE.md",
          "docs/agents/vat-development-agents/agent-generator/DESIGN.md"
        ]
      },
      {
        "recommendation": "Convert configuration prose to structured table in DESIGN.md",
        "estimatedImpact": "Save 150 tokens, improve scannability by 40%",
        "affectedResources": [
          "docs/agents/vat-development-agents/agent-generator/DESIGN.md"
        ]
      }
    ],
    "mediumPriority": [
      {
        "recommendation": "Consolidate naming conventions into single authoritative section",
        "estimatedImpact": "Save 150 tokens, reduce maintenance burden"
      },
      {
        "recommendation": "Condense verbose purpose descriptions across resources",
        "estimatedImpact": "Save 200 tokens total, improve clarity"
      }
    ],
    "lowPriority": [
      {
        "recommendation": "Break long task descriptions into bullet points",
        "estimatedImpact": "Save 100 tokens, improve scannability by 25%"
      },
      {
        "recommendation": "Replace duplicated installation instructions with references",
        "estimatedImpact": "Save 80 tokens, improve consistency"
      }
    ]
  }
}
```

### Interpretation

**Overall Efficiency**: 78.5/100 (Good, with room for improvement)

**Key Findings**:
1. **Major Issue**: SCOPE.md contains 500 tokens of implementation details that belong in DESIGN.md
2. **Structural Issues**: Configuration and task information would be more efficient in structured formats
3. **Minor Redundancy**: Some content duplicated across resources (naming conventions, installation)

**Estimated Impact**:
- Addressing high-priority issues: 650 tokens saved (5.2% reduction)
- Addressing all issues: 1,800 tokens saved (14.4% reduction)
- Improved scannability and retrieval accuracy

**Recommendation**: Focus on high-priority issues first. Moving implementation details and restructuring configuration will provide the most significant efficiency gains.

## Implementation Approach

### Architecture

```
resource-optimizer/
├── src/
│   ├── analyzers/
│   │   ├── redundancy-analyzer.ts    # Detect duplicate content
│   │   ├── clarity-analyzer.ts       # Evaluate conciseness
│   │   ├── specificity-analyzer.ts   # Assess scope appropriateness
│   │   └── structure-analyzer.ts     # Evaluate organization
│   ├── utils/
│   │   ├── token-estimator.ts        # Estimate token counts
│   │   ├── content-parser.ts         # Parse markdown/text/JSON/YAML
│   │   └── similarity-calculator.ts  # Semantic similarity
│   ├── reporters/
│   │   └── analysis-reporter.ts      # Format output report
│   └── index.ts                      # Main orchestration
└── test/
    ├── analyzers/
    ├── utils/
    └── integration/
```

### LLM Selection

**Primary LLM**: Claude 3.5 Sonnet (claude-3-5-sonnet-20241022)

**Rationale**:
- Strong semantic understanding for redundancy detection
- Excellent at identifying clarity issues in writing
- Good at evaluating information architecture
- Balanced cost vs. capability for analysis tasks

**Alternative for Cost Optimization**:
- Claude 3.5 Haiku for initial token counting and structural analysis
- Sonnet for semantic analysis (redundancy, clarity assessment)

### Workflow

1. **Load Resources**
   - Discover files based on input scope
   - Parse content (markdown, JSON, YAML, text)
   - Estimate token counts

2. **Run Analyzers** (parallel where possible)
   - Redundancy: Compare content across resources using embeddings
   - Clarity: Analyze descriptions, identify verbose patterns
   - Specificity: Evaluate scope vs. purpose
   - Structure: Assess organization and formatting

3. **Calculate Efficiency Scores**
   - Per-resource score based on issues found
   - Overall score weighted by resource size
   - Token waste estimates

4. **Generate Recommendations**
   - Prioritize by impact (token savings × severity)
   - Group related issues
   - Provide before/after examples

5. **Output Report**
   - JSON format for programmatic use
   - Optional markdown report for human review

## Success Criteria

### Quantitative

- **Accuracy**: 85%+ precision on identifying real efficiency issues (validated by human review)
- **Coverage**: Detect 90%+ of token waste exceeding `minTokenSavings` threshold
- **Performance**: Analyze 100KB of resources in < 30 seconds
- **Consistency**: Same resources analyzed twice produce identical results

### Qualitative

- **Actionability**: Recommendations are specific enough to implement without additional analysis
- **False Positive Rate**: < 15% of reported issues are deemed not worth fixing by users
- **User Satisfaction**: Developers find the analysis valuable and act on recommendations

## Testing Strategy

### Unit Tests

Test each analyzer in isolation:

**Redundancy Analyzer**:
```typescript
describe('RedundancyAnalyzer', () => {
  it('should detect exact text duplication across resources', () => {
    const resource1 = { path: 'a.md', content: 'Installation: Run npm install' };
    const resource2 = { path: 'b.md', content: 'Installation: Run npm install' };

    const issues = analyzer.analyze([resource1, resource2]);

    expect(issues).toContainEqual(
      expect.objectContaining({
        type: 'redundancy',
        affectedResources: ['a.md', 'b.md'],
        estimatedTokenWaste: expect.any(Number),
      })
    );
  });

  it('should detect semantic similarity with different wording', () => {
    const resource1 = { path: 'a.md', content: 'Install dependencies using npm' };
    const resource2 = { path: 'b.md', content: 'Use npm to install required packages' };

    const issues = analyzer.analyze([resource1, resource2]);

    expect(issues.some(i => i.type === 'redundancy')).toBe(true);
  });

  it('should ignore intentional cross-references', () => {
    const resource1 = { path: 'a.md', content: 'See b.md for details' };
    const resource2 = { path: 'b.md', content: 'Detailed explanation here...' };

    const issues = analyzer.analyze([resource1, resource2]);

    expect(issues).not.toContainEqual(
      expect.objectContaining({ relatedResources: expect.arrayContaining(['a.md', 'b.md']) })
    );
  });
});
```

**Clarity Analyzer**:
```typescript
describe('ClarityAnalyzer', () => {
  it('should flag verbose descriptions', () => {
    const resource = {
      path: 'scope.md',
      content: 'This agent essentially helps developers by basically providing them with...',
    };

    const issues = analyzer.analyze([resource]);

    expect(issues).toContainEqual(
      expect.objectContaining({
        type: 'clarity',
        severity: expect.any(String),
        recommendation: expect.stringContaining('remove hedging'),
      })
    );
  });

  it('should provide concise alternatives', () => {
    const resource = {
      path: 'doc.md',
      content: 'The system works by processing the input data through a series of transformations...',
    };

    const issues = analyzer.analyze([resource]);

    expect(issues[0]?.examples).toHaveProperty('before');
    expect(issues[0]?.examples).toHaveProperty('after');
    expect(issues[0]?.examples?.after.length).toBeLessThan(issues[0]?.examples?.before.length);
  });
});
```

**Specificity Analyzer**:
```typescript
describe('SpecificityAnalyzer', () => {
  it('should flag overly broad scope in focused documents', () => {
    const resource = {
      path: 'agent-a/SCOPE.md',
      content: `
        # Agent A Scope
        ## Purpose
        Specific purpose for Agent A
        ## Implementation Details
        [500 tokens of implementation code examples]
        ## Debugging Strategies
        [300 tokens of debugging tips]
      `,
    };

    const issues = analyzer.analyze([resource]);

    expect(issues).toContainEqual(
      expect.objectContaining({
        type: 'specificity',
        severity: 'major',
        recommendation: expect.stringContaining('move to DESIGN.md'),
      })
    );
  });
});
```

**Structure Analyzer**:
```typescript
describe('StructureAnalyzer', () => {
  it('should detect walls of text', () => {
    const resource = {
      path: 'doc.md',
      content: 'A'.repeat(2000), // Long paragraph
    };

    const issues = analyzer.analyze([resource]);

    expect(issues).toContainEqual(
      expect.objectContaining({
        type: 'structure',
        recommendation: expect.stringContaining('break into sections'),
      })
    );
  });

  it('should suggest tables for prose-based configuration', () => {
    const resource = {
      path: 'config.md',
      content: `
        The first option is name, which is a string. The second option is age, which is a number.
      `,
    };

    const issues = analyzer.analyze([resource]);

    expect(issues).toContainEqual(
      expect.objectContaining({
        type: 'structure',
        recommendation: expect.stringContaining('table'),
      })
    );
  });
});
```

### Integration Tests

Test end-to-end analysis workflows:

```typescript
describe('ResourceOptimizer Integration', () => {
  it('should analyze multiple resources and generate comprehensive report', async () => {
    const input = {
      analysisScope: {
        resourceDirectory: './test/fixtures/sample-agent',
      },
      analysisOptions: {
        checkRedundancy: true,
        checkClarity: true,
        checkSpecificity: true,
        checkStructure: true,
        minTokenSavings: 50,
      },
    };

    const output = await resourceOptimizer.analyze(input);

    expect(output.summary).toMatchObject({
      totalResources: expect.any(Number),
      totalTokens: expect.any(Number),
      issuesFound: expect.any(Number),
      potentialTokenSavings: expect.any(Number),
      efficiencyScore: expect.any(Number),
    });

    expect(output.resourceAnalysis).toBeInstanceOf(Array);
    expect(output.recommendations).toHaveProperty('highPriority');
    expect(output.recommendations.highPriority).toBeInstanceOf(Array);
  });

  it('should prioritize issues by estimated impact', async () => {
    // Setup: Create resources with issues of varying severity/token waste
    const output = await resourceOptimizer.analyze(testInput);

    const highPriorityImpact = estimateImpact(output.recommendations.highPriority);
    const mediumPriorityImpact = estimateImpact(output.recommendations.mediumPriority);

    expect(highPriorityImpact).toBeGreaterThan(mediumPriorityImpact);
  });
});
```

### Validation Tests

Validate against real-world scenarios:

```typescript
describe('ResourceOptimizer Validation', () => {
  it('should analyze agent-generator resources', async () => {
    const input = {
      analysisScope: {
        resourceDirectory: 'docs/agents/vat-development-agents/agent-generator',
      },
    };

    const output = await resourceOptimizer.analyze(input);

    // Validate that analysis completes successfully
    expect(output.summary.totalResources).toBeGreaterThan(0);
    expect(output.resourceAnalysis.length).toBe(output.summary.totalResources);
  });

  it('should detect known efficiency issues in test corpus', async () => {
    // Test against a corpus with intentionally inefficient resources
    const output = await resourceOptimizer.analyze(knownIssuesCorpus);

    // Verify that known issues are detected
    expect(output.summary.issuesFound).toBeGreaterThanOrEqual(expectedIssueCount);
  });
});
```

## Phase 2 Considerations

### Enhancements for Future Phases

1. **Auto-Fix Capabilities**
   - Implement automatic refactoring for simple issues (clarity, structure)
   - Generate git diffs for proposed changes
   - Interactive mode for reviewing and applying fixes

2. **Baseline Tracking**
   - Store efficiency scores over time
   - Detect regressions in context efficiency
   - Integrate with CI/CD to block PRs that worsen efficiency

3. **Custom Rules**
   - Allow users to define project-specific efficiency rules
   - Support custom analyzers via plugin system
   - Configuration for severity thresholds and token budgets

4. **Visual Reports**
   - Generate HTML/markdown reports with charts
   - Heatmaps showing efficiency across resources
   - Before/after comparisons with syntax highlighting

5. **Integration with Agent Generator**
   - Automatically analyze generated resources
   - Provide efficiency feedback during agent creation
   - Enforce efficiency thresholds for new agents

6. **Advanced Analysis**
   - Detect outdated examples or references
   - Identify opportunities for consolidation across agent sets
   - Analyze query patterns to optimize for common retrieval scenarios

### Integration Points

**With vat-resources**:
- Use existing resource parsing and validation
- Share token estimation utilities
- Leverage resource metadata for context

**With agent-generator**:
- Analyze generated resources for efficiency
- Provide feedback during agent creation
- Template resources with efficiency best practices baked in

**With CLI**:
- `vibe-agent optimize <path>` command
- `--fix` flag for automatic corrections
- `--watch` mode for continuous monitoring

## Open Questions

1. **Token Estimation Accuracy**: How closely should token estimates match actual LLM tokenization? (Target: ±5%)

2. **Semantic Similarity Threshold**: What similarity score indicates redundancy vs. legitimate overlap? (Propose: 0.85+ for exact, 0.70-0.84 for semantic)

3. **Efficiency Score Formula**: How should we weight different issue types in the overall score?
   ```
   Proposed:
   score = 100 - (
     (redundancy_waste * 1.5) +  // Redundancy most costly
     (clarity_waste * 1.0) +
     (specificity_waste * 1.2) +
     (structure_waste * 0.8)     // Structure less critical than content
   ) / total_tokens * 100
   ```

4. **Human-in-the-Loop**: Should the agent require human confirmation before flagging issues? Or trust the analysis and allow humans to dismiss false positives?

5. **Minimum Resource Size**: Should very small resources (< 100 tokens) be skipped? May not be worth analyzing.

6. **Cross-Agent Analysis**: Should the tool analyze resources across multiple agents to detect global redundancy patterns?

## Decision: Defer to Phase 2+

**Rationale**:

While resource-optimizer would be valuable, it's not critical for the initial agent-generator workflow. The agent-generator can function effectively without automatic efficiency analysis, and manual review by developers is sufficient for Phase 1.

**Phase 2 Priorities**:
1. Get agent-generator working end-to-end
2. Validate with real agent creation scenarios
3. Gather feedback on resource efficiency pain points
4. Use findings to refine resource-optimizer scope

**Revisit Trigger**:
- After creating 5+ agents with agent-generator
- If manual efficiency reviews become a bottleneck
- When users request automated efficiency analysis

Resource-optimizer remains a valuable future enhancement with a well-defined scope ready for implementation.
