# User Profile System - Infinite Extensibility

## Philosophy

**The system should handle services that haven't been invented yet.**

When a new social network launches tomorrow, Artie should be able to link it immediately without code changes.

## Architecture

```
Redis Hash: user_profile:{userId}
├─ email: validated@example.com        ← Known service (validated)
├─ github: ejfox                        ← Known service
├─ bluesky: ejfox.bsky.social          ← Unknown service (just works)
├─ mastodon: @ejfox@mastodon.social    ← Unknown service (just works)
├─ threads: @ejfox                      ← Unknown service (just works)
├─ nostr: npub1...                      ← Future service (just works)
├─ farcaster: ejfox.eth                 ← Future service (just works)
└─ {any_future_service}: {any_value}    ← Infinitely extensible
```

## Usage Patterns

### Known Services (with validation)
```xml
<capability name="user-profile" action="link-email" value="user@example.com" />
<capability name="user-profile" action="link-phone" value="+1234567890" />
```
- Email: regex validation
- Phone: international format validation
- Specific error messages

### Unknown Services (generic link)
```xml
<capability name="user-profile" action="link" attribute="bluesky" value="ejfox.bsky.social" />
<capability name="user-profile" action="link" attribute="mastodon" value="@ejfox@mastodon.social" />
<capability name="user-profile" action="link" attribute="threads" value="@ejfox" />
<capability name="user-profile" action="link" attribute="discord" value="ejfox#1234" />
<capability name="user-profile" action="link" attribute="signal" value="+1234567890" />
<capability name="user-profile" action="link" attribute="telegram" value="@ejfox" />
```
- No validation (trust the LLM)
- Service name sanitized: lowercase, alphanumeric + underscore/dash
- Works for ANY service, present or future

## Conversational Examples

```
User: "I'm on Bluesky at ejfox.bsky.social"
Artie: <capability name="user-profile" action="link" attribute="bluesky" value="ejfox.bsky.social" />
Artie: "✅ bluesky linked: ejfox.bsky.social"

User: "Find me on Mastodon: @ejfox@mastodon.social"
Artie: <capability name="user-profile" action="link" attribute="mastodon" value="@ejfox@mastodon.social" />
Artie: "✅ mastodon linked: @ejfox@mastodon.social"

User: "My Threads handle is @ejfox"
Artie: <capability name="user-profile" action="link" attribute="threads" value="@ejfox" />
Artie: "✅ threads linked: @ejfox"
```

## Future Services - Zero Code Changes

When a new service launches (e.g., "SuperSocial" in 2026):

```
User: "I'm on SuperSocial as ejfox2026"
Artie: <capability name="user-profile" action="link" attribute="supersocial" value="ejfox2026" />
Artie: "✅ supersocial linked: ejfox2026"
```

**No deployment needed. No code changes. It just works.**

## Design Principles

1. **Completeness**: Handle all known services
2. **Extensibility**: Handle all unknown services
3. **Future-proof**: Handle services not invented yet
4. **Validation where possible**: Known services get validation
5. **Trust where necessary**: Unknown services stored as-is

## Implementation

### Specific Actions (validated)
- `link-email`: Email regex validation
- `link-phone`: International phone format
- `link-github`, `link-reddit`, etc.: Basic validation

### Generic Action (extensible)
- `link`: Accepts ANY attribute name
- Sanitizes service name (lowercase, safe chars)
- No validation (trust LLM judgment)
- Stores in same unified Redis Hash

### Storage
All stored identically in Redis Hash:
```
user_profile:{userId}
  → {service_name}: {value}
```

No schema changes needed for new services.
No migrations needed for new services.
Just works.

## Comparison to Traditional Systems

**Traditional (rigid):**
```sql
CREATE TABLE user_profiles (
  id INTEGER,
  email VARCHAR(255),
  github VARCHAR(255),
  twitter VARCHAR(255)
  -- Need migration for every new service!
);
```

**Ours (flexible):**
```
Redis Hash - any key-value pair
No schema
No migrations
Infinite services
```

## LLM Instructions

The LLM learns via capability examples:

```xml
<!-- Known services (specific validation) -->
<capability name="user-profile" action="link-email" value="user@example.com" />
<capability name="user-profile" action="link-github" value="ejfox" />

<!-- Unknown services (generic link) -->
<capability name="user-profile" action="link" attribute="anyservice" value="anyvalue" />
```

The LLM can pattern-match and handle ANY service the user mentions.

## Benefits

1. **Completeness**: All current services work
2. **Extensibility**: All future services work
3. **Simplicity**: One storage system
4. **Flexibility**: LLM decides when to link
5. **Future-proof**: No code changes for new services
6. **User-friendly**: Natural conversation, no commands
7. **Developer-friendly**: Zero maintenance for new services
