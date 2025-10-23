# Open Issues - Coach Artie 2

## GitHub Issues Created

✅ Successfully enabled GitHub issues and created tracking for incomplete features.

## Incomplete Features Found During Code Review

### 1. Vector Embeddings Not Connected to Supabase

**GitHub Issue:** [#1](https://github.com/ejfox/coachartie2/issues/1)
**File:** `packages/capabilities/src/services/vector-embeddings.ts:95,123`
**Status:** ⚠️ Not Implemented
**Impact:** Vector similarity search always returns empty results
**Details:**

- `searchSimilar()` method has TODO comment, returns empty array
- `storeEmbedding()` method cannot persist embeddings to database
- Supabase connection code is commented out

### 2. Semantic Search Memory Lookup

**GitHub Issue:** [#3](https://github.com/ejfox/coachartie2/issues/3)
**File:** `packages/capabilities/src/capabilities/semantic-search.ts:51`
**Status:** ⚠️ Not Implemented
**Impact:** Cannot search similar memories based on memory ID
**Details:**

- TODO comment indicates feature was planned but not built

### 3. ~~LinkedIn OAuth Token Persistence~~ ✅ FIXED & TESTED

**GitHub Issue:** [#2](https://github.com/ejfox/coachartie2/issues/2) - CLOSED
**File:** `packages/capabilities/src/capabilities/linkedin.ts:87`
**Status:** ✅ Fixed & Tested
**Resolution:**

- Created `oauth_tokens` database table with UPSERT support
- Implemented `OAuthManager` service for secure token storage
- Updated LinkedIn capability to use database persistence
- Tested INSERT, SELECT, and UPSERT operations successfully
- Tokens now persist across service restarts

### 4. ~~Context Alchemy Final Response Prompt~~ ✅ FIXED & TESTED

**GitHub Issue:** [#4](https://github.com/ejfox/coachartie2/issues/4) - CLOSED
**File:** `packages/capabilities/src/services/capability-orchestrator.ts:1855`
**Status:** ✅ Fixed & Tested
**Resolution:**

- Created new `generateCapabilitySynthesisPrompt()` method in Context Alchemy
- Refactored orchestrator to use the new method
- Tested with single capability: "25 × 4 = 100" ✅
- Tested with multiple capabilities: calculate + remember ✅
- Successfully deployed and verified working in production

## Recently Fixed Issues (Verified Working)

### ✅ Discord Message Fragmentation

- Clean capability tags function properly removes XML/markdown
- No chain-of-thought leakage

### ✅ Discord Verbosity

- Removed duplicate "Working on it..." messages
- Smart duplicate prevention for streaming

### ✅ SMS Service Health

- Fixed port mismatch (27461→47326)
- Health check handles missing Twilio credentials gracefully

### ✅ Capability Orchestrator Import

- Fixed missing capability-suggester module regression
