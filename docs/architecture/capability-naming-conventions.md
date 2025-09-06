# Capability Naming Conventions

## Architecture Decision Record: Capability Naming Standardization

**Date:** 2025-09-04  
**Status:** Approved  
**Architecture Review:** SARAH (Systems Architect)

### Context

The Coach Artie 2 system had an architectural inconsistency where the web search capability was referenced by different names across the codebase:
- **Registry**: `'web'` (correct implementation)
- **Documentation**: `'web-search'` (incorrect legacy reference)  
- **Prompts**: Mixed usage of both formats

This created confusion for LLM instruction generation and made the system appear broken when it was actually functioning correctly.

### Decision: Standardized Capability Naming

**Core Principle**: Capability names should be **concise, descriptive nouns** that represent the domain, not the action.

### Naming Standards

#### ✅ CORRECT Format:
```typescript
{
  name: 'web',              // Domain/capability name
  supportedActions: ['search', 'fetch'],  // Specific actions
  // Usage: <capability name="web" action="search" query="..." />
}
```

#### ❌ INCORRECT Format:
```typescript
{
  name: 'web-search',       // Conflates domain + action
  supportedActions: ['search'],  
  // Creates naming confusion and limits extensibility
}
```

### Capability Naming Rules

1. **Domain-Based Names**: Use the domain/service area (e.g., `web`, `memory`, `github`)
2. **No Action Suffixes**: Avoid `-search`, `-create`, `-update` in capability names
3. **Lowercase with Hyphens**: Use `kebab-case` for multi-word capabilities (e.g., `discord-ui`)
4. **Action Specificity**: Actions should be verbs (`search`, `fetch`, `remember`, `recall`)
5. **Extensibility**: Names should allow future actions without renaming

### Current Capability Registry

| Capability Name | Actions | Domain |
|----------------|---------|--------|
| `web` | `search`, `fetch` | Web operations |
| `memory` | `remember`, `recall`, `search` | Memory storage |
| `calculator` | `calculate` | Mathematical operations |
| `discord-ui` | `buttons`, `embed` | Discord interface |
| `github` | `create_issue`, `comment`, `search` | GitHub operations |
| `variable-store` | `set`, `get`, `delete`, `list` | Variable storage |

### XML Usage Patterns

#### Standard Capability XML:
```xml
<capability name="web" action="search" query="AI news" />
<capability name="memory" action="remember" content="User loves pizza" />
<capability name="github" action="create_issue" title="Bug report" />
```

#### Legacy Tag Support (Maintained for Backward Compatibility):
```xml
<!-- Still works through XML parser translation -->
<web-search>AI news</web-search>
<remember>User loves pizza</remember>
<calculate>2 + 2</calculate>
```

### Migration Strategy

1. **Registry**: ✅ Already correct - no changes needed
2. **XML Parser**: ✅ Maintains backward compatibility for legacy tags
3. **Documentation**: ✅ Updated to reflect correct naming
4. **Prompts**: ✅ Updated to use standard capability XML format
5. **Context Sources**: ✅ Updated capability lists

### Technical Debt Resolution

**RESOLVED:**
- Documentation now correctly states registry has `'web'` capability
- Legacy prompts updated to use consistent `<capability>` XML format
- Context alchemy capability manifest corrected

**PRESERVED:**
- XML parser translation layer for backward compatibility
- Legacy tag support for existing implementations

### Future Considerations

1. **New Capabilities**: Must follow domain-based naming convention
2. **Legacy Support**: XML parser should maintain translation indefinitely
3. **Documentation**: All examples should use standard capability XML format
4. **Testing**: Capability tests should verify both standard and legacy formats

---

*This decision ensures consistent capability naming while maintaining backward compatibility and system reliability.*