# Context Alchemy Logging Guide

## Overview

Context Alchemy now has comprehensive logging to help debug and understand how context is assembled and how it affects responses.

## Enable Debug Mode

Add to your `.env` file:

```bash
CONTEXT_ALCHEMY_DEBUG=true  # Enable detailed logging
```

## What Gets Logged

### 1. Session Start

```
╔═══════════════════════════════════════════════════════════════════╗
║              🧪 CONTEXT ALCHEMY ASSEMBLY START 🧪               ║
╚═══════════════════════════════════════════════════════════════════╝
📥 User: ejfox | Message length: 56 chars
⚙️  Mode: FULL INTELLIGENCE
```

### 2. Token Budget Calculation

```
┌─ TOKEN BUDGET CALCULATION ──────────────────────────────────────┐
│ Total Window:     4000 tokens
│ User Message:     14 tokens (56 chars)
│ System Prompt:    75 tokens
│ Reserved Reply:   500 tokens
│ ─────────────────────────────────────────────────────────────────
│ 💰 Available:     3411 tokens for context enrichment
└──────────────────────────────────────────────────────────────────┘
```

### 3. Memory Search (3-Layer Parallel)

```
┌─ MEMORY SEARCH (3-Layer Entourage) ─────────────────────────────┐
│ 🧠 Running 3-LAYER PARALLEL SEARCH:
│ Priority Mode: speed | Max Tokens: 800
│ Token Split: Keyword=400, Semantic=240, Temporal=160
│ ⚡ Parallel search completed in 127ms
│ ┌─ LAYER RESULTS ──────────────────────────────────────────────┐
│ │ 🔍 Keyword:  5 memories, 85.0% confidence
│ │ 🧠 Semantic: 3 memories, 72.0% confidence (OpenAI)
│ │ 📅 Temporal: 2 memories, 60.0% confidence
│ └──────────────────────────────────────────────────────────────┘
│ 🎲 FUSION PATTERN: "interleaved" (randomly selected for variety)
│ 🎯 FUSION COMPLETE: 10 total memories
│ Confidence: 78.5% | Categories: keyword, semantic, temporal
└──────────────────────────────────────────────────────────────────┘
```

### 4. Context Selection

```
┌─ CONTEXT SELECTION (Priority & Budget) ─────────────────────────┐
│ ✅ SELECTED: temporal_context       (50 tokens, pri: 100)
│ ✅ SELECTED: goal_context           (100 tokens, pri: 90)
│ ✅ SELECTED: memory_context         (800 tokens, pri: 70)
│ ✅ SELECTED: capability_context     (50 tokens, pri: 30)
│ ─────────────────────────────────────────────────────────────────
│ Token usage: 1000/3411 (29% of budget)
└──────────────────────────────────────────────────────────────────┘
```

### 5. Message Chain Assembly

```
┌─ MESSAGE CHAIN ASSEMBLY ─────────────────────────────────────────┐
│ 🎲 Memory context role: assistant (random selection for variety)
└──────────────────────────────────────────────────────────────────┘

┌─ FINAL MESSAGE CHAIN ────────────────────────────────────────────┐
│ [0] system   : Friday Sept 27, 2025 2:46 PM PST You are Coach...
│ [1] assistant: Context: You ran 3 miles on Wednesday. You said...
│ [2] system   : [Conscience: User wants to build healthy habits]
│ [3] user     : Help me achieve my fitness goals
└──────────────────────────────────────────────────────────────────┘
```

### 6. Context Sources Summary

```
┌─ CONTEXT SOURCES INCLUDED ───────────────────────────────────────┐
│ temporal     | Pri:100 |  ~50 tokens | temporal_context
│ goals        | Pri: 90 | ~100 tokens | goal_context
│ memory       | Pri: 70 | ~800 tokens | memory_context
│ capabilities | Pri: 30 |  ~50 tokens | capability_context
└──────────────────────────────────────────────────────────────────┘
```

### 7. Session Complete

```
╔═══════════════════════════════════════════════════════════════════╗
║ ✅ CONTEXT ASSEMBLY COMPLETE: 4 messages, 4 sources              ║
╚═══════════════════════════════════════════════════════════════════╝
```

## Understanding the Logs

### Fusion Patterns

The system randomly selects from 5 fusion patterns to create variety:

- **layered**: Keywords first, then semantic, then temporal
- **interleaved**: Mix all three naturally
- **comparative**: Present as different perspectives
- **synthesized**: Combine into unified narrative
- **temporal_flow**: Organize by time context

### Memory Layers

- **🔍 Keyword**: Direct text matches
- **🧠 Semantic**: Vector similarity (OpenAI when available, TF-IDF fallback)
- **📅 Temporal**: Time-based relevance

### Token Management

- Shows exactly how many tokens are used vs available
- Helps identify when context is being cut off due to token limits
- Shows which sources get included/excluded based on priority

## Debugging Tips

1. **Check if memories are being found**:
   Look for the "LAYER RESULTS" section to see if each layer is finding memories.

2. **Verify OpenAI is working**:
   Look for "(OpenAI)" vs "(TF-IDF)" in the semantic layer results.

3. **Monitor token usage**:
   If important context is missing, check if you're hitting token limits.

4. **Track fusion patterns**:
   If responses seem repetitive, check if the same fusion pattern keeps getting selected.

5. **Analyze confidence scores**:
   Low confidence might indicate poor memory matches for the query.

## Performance Metrics

The logs show timing information:

- Parallel search time (all 3 layers)
- Total context assembly time
- Individual operation timings

This helps identify performance bottlenecks.

## Disable Logging

To turn off detailed logging:

```bash
CONTEXT_ALCHEMY_DEBUG=false  # or remove the line entirely
```

Regular minimal logging will still show basic operations.
