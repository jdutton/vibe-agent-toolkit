# Agent Specification Compatibility

## Overview

This document analyzes compatibility between VAT (Vibe Agent Toolkit) agent specifications and other industry standards. Our goal is to ensure VAT agents can interoperate with the broader agentic ecosystem while maintaining our opinionated features (resources, RAG, composition).

## Philosophy

**VAT is opinionated but compatible:**
- We provide richer abstractions (resources, templates, RAG, multi-agent composition)
- We can export to simpler formats (with binding/flattening)
- We can import from simpler formats (with VAT defaults)
- Future conversion will likely be **agentic** (AI-assisted), not purely deterministic tooling

## Oracle Open Agent Spec

**Status**: Industry standard, Oracle-backed, framework-agnostic
**Repository**: https://github.com/oracle/agent-spec
**Documentation**: https://oracle.github.io/agent-spec/

### Compatibility Matrix

| VAT Feature | Open Agent Spec | Export Strategy | Import Strategy | Notes |
|-------------|-----------------|-----------------|-----------------|-------|
| **Agent name** | ✅ `name` | Direct map | Direct map | Exact match |
| **System prompt** | ✅ `system_prompt` | Resolve resource → inline string | Inline string (recommend extracting to resource) | VAT uses resources, OAS uses inline |
| **LLM config** | ✅ `llm_config` | Bind one LLM from alternatives | Single LLM only | Must choose primary |
| **Input schema** | ✅ `inputs` (Property[]) | Convert JSON Schema → Property | Convert Property → JSON Schema | Schema format differs |
| **Output schema** | ✅ `outputs` (Property[]) | Convert JSON Schema → Property | Convert Property → JSON Schema | Schema format differs |
| **Tools** | ⚠️ Different format | Map VAT tools → OAS tools | Map OAS tools → VAT tools | Tool structures differ |
| **LLM alternatives** | ❌ Not supported | Bind to primary, document others | Not applicable | OAS has single LLM |
| **Resources** | ❌ Not supported | Resolve/inline, skip registry | Not applicable | VAT-specific concept |
| **RAG** | ❌ Not supported | Skip or document separately | Not applicable | VAT-specific concept |
| **Multi-agent composition** | ❌ Not supported | Flatten or skip | Not applicable | VAT-specific concept |
| **Memory config** | ❌ Not supported | Skip | Not applicable | VAT-specific concept |

### Export Process (VAT → Open Agent Spec)

**Bindings required** (choices we must make):
1. **LLM Selection**: Pick one LLM from alternatives
2. **Resource Resolution**: Inline prompt content from resource files
3. **Tool Mapping**: Convert VAT tool format to OAS tool format
4. **Composition Flattening**: Export only primary agent, skip sub-agents

**Output**: Open Agent Spec YAML/JSON with metadata documenting:
- Which LLM was selected
- Which resources were inlined
- What VAT features were skipped

**Note**: Export is lossy - round-tripping back to VAT will lose:
- LLM alternatives
- Resource registry structure
- RAG configuration
- Multi-agent composition
- Memory configuration

### Import Process (Open Agent Spec → VAT)

**Challenges**:
1. No resource concept → Prompts are inline strings
2. No alternatives → Single LLM only
3. No VAT-specific features → Must add defaults

**Strategy**: Create minimal VAT agent with:
- OAS data mapped to VAT structure
- Inline prompts (recommend manual extraction to resources)
- Single LLM (recommend adding alternatives manually)
- No RAG, memory, or composition (add later if needed)

**Output**: Valid VAT agent with warnings about missing features

### Future: Agentic Conversion

**Why AI-assisted conversion matters**:
- Deterministic tooling is insufficient for semantic conversions
- Prompts may need adaptation (inline → resource structure)
- Tool mappings may require understanding intent
- Multi-agent patterns may need decomposition/composition

**Potential approach**:
1. Use deterministic converter for structural mapping
2. Use AI agent to:
   - Extract prompts into well-structured resources
   - Identify opportunities for RAG (knowledge bases in prompts)
   - Suggest LLM alternatives based on capabilities
   - Detect multi-agent patterns and propose composition
3. Generate VAT agent with recommendations, not just mechanical conversion

## Other Standards

### AAIF AGENTS.md

**Status**: Simple, repo-level configuration for coding agents
**Repository**: https://github.com/agentsmd/agents.md

**Compatibility**: AGENTS.md is project-level guidance (like README), not agent definition format. Not directly comparable to VAT agent.yaml.

**Potential use**: VAT projects could include AGENTS.md for coding agents working on the VAT project itself.

### LangChain Agent Configuration

**Status**: Code-based (not declarative)
**Documentation**: https://docs.langchain.com/oss/python/langchain/agents

**Compatibility**: LangChain uses imperative code, not declarative YAML. Our `adapter-langchain` package generates LangChain code from VAT agent.yaml.

**Export strategy** (VAT → LangChain):
- Generate Python/TypeScript code using LangChain SDK
- Map VAT concepts to LangChain: tools → LangChain tools, memory → LangChain memory, etc.
- Part of adapter package, not schema conversion

### CrewAI Agent Format

**Status**: Code-based with YAML config support
**Documentation**: https://docs.crewai.com/

**Compatibility**: CrewAI has YAML-ish config for agents/tasks/crews. Our `adapter-crewai` package generates CrewAI definitions from VAT agent.yaml.

**Export strategy** (VAT → CrewAI):
- Generate CrewAI agent/task/crew definitions
- Map VAT composition → CrewAI crews
- Part of adapter package, not schema conversion

## Recommendations

### For VAT Design

1. **Keep VAT opinionated** - Don't dumb down to lowest common denominator
2. **Design for export** - Ensure VAT features can degrade gracefully
3. **Document limitations** - Be clear about what's lost in conversion
4. **Plan for AI-assisted conversion** - Deterministic tooling is insufficient

### For Implementation (Future)

1. **Phase 1**: Document compatibility (this document) ✅
2. **Phase 2**: Build adapters (framework-specific code generation)
3. **Phase 3**: Build structural converters (deterministic mapping)
4. **Phase 4**: Build agentic converters (AI-assisted semantic conversion)

### For Users

When exporting VAT agents to other formats:
- **Expect lossy conversion** - VAT features may not map
- **Review generated output** - Automated conversion needs validation
- **Use adapters over converters** - Framework adapters (LangChain, CrewAI) are better than generic converters
- **Consider AI assistance** - For complex conversions, use AI to understand intent

## Testing Strategy (Future)

When we implement conversion tooling:

1. **Unit tests**: Structural mapping (VAT → OAS fields)
2. **Integration tests**: Export → validate OAS schema conformance
3. **Roundtrip tests**: Export → import → compare (document losses)
4. **Compatibility tests**: Load exported OAS in PyAgentSpec, verify execution
5. **Semantic tests**: AI-validated equivalence (does it do the same thing?)

---

**Maintained by**: vibe-agent-toolkit core team
**Last updated**: 2025-12-28
**Status**: Design document - no implementation yet
