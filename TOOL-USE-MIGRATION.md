# Coach Artie — Tool-Use Brain Transplant (scope)

**Goal:** Replace the XML-tag capability system + forced-depth text loop with **native
tool-calling + a clean agentic loop**, making Artie a Claude-Code-style agent: a tool-use brain,
his shell ("laptop"), skills, and prompts. Keep every feature. Stay **model-agnostic via OpenRouter**.

## Why now / why this
Today (confirmed in code): `openrouter.ts` does plain text generation — **no native tools**. Artie
emits `<capability name="x" action="y" .../>` XML into its text; `capability-parser` regex-extracts
it; `llm-loop-service` re-prompts in a loop gated by a forced-depth mechanism ("You MUST continue
exploring. Cannot provide final answer until step X"). That forced loop is the likely root of the
recent *barging-in + token-burn* problems. XML-in-text is brittle (audit: "LLM often generates
invalid tags"). The recent cleanup makes the fix easy: capabilities are now a clean registry array.

## Design principles
- **Model-agnostic:** tools defined once as JSON Schema (OpenAI format); OpenRouter translates per
  provider. `model` stays swappable (`OPENROUTER_MODELS`). Restrict the rotation pool to
  **tool-capable** models (frontier Anthropic/OpenAI/Gemini; not the small free ones).
- **No MCP.** Lean on the **shell (docker laptop)** + **skills (SKILL.md)** + **prompts**.
- **Few powerful tools, not 67.** Expose a lean CORE tool set; migrate the long tail to skills.
- **Shared mechanism, local policy** (the campaign's pattern continues).

## The shapes we're converting (grounded)
- `RegisteredCapability = { name, supportedActions[], handler, description?, requiredParams?, examples?, emoji? }`
- `CapabilityHandler = (params: any, content?: string, context?) => Promise<string>` — **already returns a
  string**, which is exactly a tool-result. The execution path barely changes.
- `shell` = `docker exec ${SANDBOX_CONTAINER_NAME:-coachartie-sandbox}` — the laptop, already sandboxed.
- `skillsCapability` + `skill-loader` already load OpenClaw `SKILL.md` (frontmatter name/description).
- `openrouter.generateFromMessageChain()` → `client.chat.completions.create({ model, messages, max_tokens })`
  — `tools` / `tool_choice` slot right in here.

## Phase A — Tool-use brain (mechanical, behavior-preserving where possible)
1. ✅ **`capabilityToTool(cap)`** — DONE: `services/capability/capability-to-tool.ts` (pure, additive,
   wired into nothing). Converts registry → OpenAI tool schema (`action` enum from `supportedActions`,
   `requiredParams` → required string props, optional `content`, names sanitized to `^[a-zA-Z0-9_-]{1,64}$`).
   Plus `registryToTools()` and `toolCallToInvocation()` (the inverse: tool_call → `{name, action, content, params}`).
   Validated 13/13 against the real `calculator` capability + edge cases (hyphens, invalid chars, no-action, round-trip).
   De-risks Phase A's core assumption — the registry converts cleanly. Limitation: params are all `string`
   for now (registry has no per-param types). NOT YET WIRED — the loop (step 3) consumes it.
2. **`openrouter`: tool support** — add `generateWithTools(messages, tools, opts)` passing
   `tools` + `tool_choice:'auto'`. Keep model rotation/selection; add a `toolCapable` filter to the pool.
3. ✅ **New agentic loop** — DONE: `services/llm/tool-loop.ts` (`runToolLoop`). Pure +
   dependency-injected (`generate` + `executeTool` passed in) → fully unit-testable, decoupled from
   OpenRouter. Natural stop when the model returns no tool calls; PARALLEL tool execution; a failed
   tool becomes an error tool-result (model recovers) not a crash; malformed-arg tolerant; `maxIterations`
   (default 8) safety cap forces a final no-tools answer. NO forced-depth/`minDepth`/`canStop` — that's
   the barging/token-burn cure. Validated 9/9 with mocks (natural stop, single/parallel tools, error
   recovery, bad JSON, max-iter). NOT YET WIRED — needs the two adapters below.

   Remaining glue for Phase A (touch the live path → do on a committed/fresh base):
   - **`openrouter.generateWithTools`** adapter — supplies `runToolLoop`'s `generate`. Reuse the existing
     model-rotation/cost-tracking (DON'T duplicate the 170 lines — extract a shared private helper or add
     a `tools` param to the existing path). Pass `tools` + `tool_choice:'auto'`; normalize `tool_calls` →
     `{id,name,arguments}`. Filter rotation pool to tool-capable models.
   - **`executeTool`** adapter — thin: `(inv) => capabilityRegistry.execute(inv.name, inv.action, inv.params, inv.content, ctx)`.
   - **Cutover** — point `process-message`/orchestrator at `runToolLoop`; retire `capability-parser`; shrink `context-alchemy` (steps 4–5).
4. **Retire `capability-parser`** (XML extraction) — tool calls arrive structured.
5. **Shrink `context-alchemy`** — delete the XML-format teaching blocks + the capability-manifest-as-XML
   from the system prompt; tools are self-describing. Big prompt-size win.
6. Tool-call dispatch → `capabilityRegistry.execute(name, action, params, content, context)` → string result.

## Phase B — Lean into laptop + skills (kills tool sprawl, keeps every feature)
7. **Curate ~10–15 CORE tools** for the tool list: `shell` (laptop), `edit`, `read/search`, `memory`,
   `image`, `vision`, `discord-ui`, `ask-question`, `skills` (list/run), + a few. Frontier models handle
   ~15 tools well; 67 would bloat tokens + confuse selection.
8. **Migrate long-tail capabilities → `SKILL.md`** (prompt + optional shell script in the sandbox).
   Artie lists skills and runs them via the shell/skill tool — the Claude Code model. Gradual,
   one capability at a time, every feature preserved.
9. **Tight modern system prompt** — small now that tools self-describe; focus on persona + judgment.

## Risks / decisions to make
- **Tool-capable model pool** — must curate; some OpenRouter models do tools poorly. (Config + a validation check.)
- **Streaming + tool use** — the streaming path (`generateFromMessageChainStreaming`) needs tool-call
  handling; do non-streaming tool loop first, add streaming after.
- **Core-tools vs all-67** — recommend lean core + skills migration (matches the shell/skills preference).
  This is the main design call to confirm before Phase B.
- **Parallel tool execution** — registry execute is already isolated per capability; safe to run concurrently.

## Sequencing
A (brain) first — dramatic + self-contained. Then frontier models + extended thinking land for real on
the new chassis. Then B (skills migration) as an ongoing grind, one capability at a time. No MCP.
