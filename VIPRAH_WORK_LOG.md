# VIprah work log

Last updated: 2026-08-22

## Current status

The source-tree implementation is working through the real OpenCode TUI path. I exercised it with a disposable local faux provider, a real stdio MCP server, a project skill, and an OpenCode plugin that records hook activity. The TUI completed multi-turn requests, loaded the skill, called the MCP tool and resource, and returned the expected final response.

The main remaining caveat is release-binary validation: this machine has Bun 1.3.12 while the repository requires Bun 1.3.14 or newer, and a temporary compiled-binary smoke test was killed by exit 137 under high existing machine memory pressure. The source TUI path and TypeScript checks are green; the release build should be rerun with the required Bun version on a machine with more available memory.

## What was implemented

### Context assembly

- Added the canonical `ContextCompiler` under `packages/core/src/session/context/`.
- Added policy, compiled-context, and context-report types in `packages/core/src/session/context.ts`.
- Added defaults matching the requested Pi-style policy:
  - 16,384 reserved tokens;
  - 20,000 tokens of recent history;
  - structured summary output capped at 4,096 tokens;
  - tool-result summaries capped at 2,000 characters.
- Kept system sections deterministic and ordered stable-first, volatile-last so the cacheable system prefix does not change when only conversation history changes.
- Included only active and permission-allowed tools.
- Added project instructions, skill metadata with lazy full-file loading, MCP/reference guidance, working-directory and environment context, and existing OpenCode agent/user/provider-specific instructions.
- Added context reports for system/history/tool counts, cacheable-prefix size, compaction state, and overflow reasons.

### Runner and request integration

- Integrated the compiler into the V2 runner in `packages/core/src/session/runner/llm.ts`.
- Routed the remaining legacy request path through the same compiler so V1 and V2 do not construct materially different prompts.
- Preserved OpenCode’s provider turns, retries, step limits, permissions, tool materialization, `SystemContextEpoch`, and `toLLMMessages` behavior.
- Kept the existing TUI, provider model, MCP lifecycle, plugin system, agents, and durable session runner authoritative.

### Compaction and overflow handling

- Added the requested reserve/recent-history compaction policy.
- Prefer provider usage when it is available and use conservative estimates otherwise.
- Cut history only at valid conversational boundaries and preserve tool-call/tool-result pairs.
- Added structured summaries covering goals, constraints, progress, decisions, next steps, and critical context.
- Compact once on overflow, rebuild the request, and prevent retry loops.
- New sessions use the new context format. Existing OpenCode sessions are not silently migrated or deleted; they are handled explicitly by the new-session boundary.

### Prompt-cache behavior

- Added/fixed cache-key propagation for the OpenAI-compatible request path and native provider cache policy.
- Stable system content is placed before changing history and environment data.
- The live faux provider recorded one stable prompt-cache key and one stable prefix hash while only the conversation changed.
- The real warm-session measurements were:
  - earlier long UX run: 104 warm requests, 103 hits: **99.04%**;
  - post-GC stress session: 104 warm requests, 104 hits: **100.00%** after the initial miss.

These are application-side cache-key/prefix observations using a deterministic local provider. Actual provider-side cache billing still depends on the selected provider, model, and its cache implementation, so a universal 99% guarantee cannot be made for every external provider.

### Memory safeguards

- Capped retained prompt/UI history at 200 entries in the runtime path.
- Avoided copying the entire resumed session into the live prompt state; resumed history is sliced to the bounded window.
- Added an idle-turn memory check that requests Bun GC only when RSS is above 256 MiB. It is a no-op for runtimes without Bun GC and does not force GC on every turn.
- The cap and idle collection are intended to prevent unbounded session-history retention without making normal turns pay a forced-GC cost.

### Upstream and attribution

- Added `UPSTREAM.md` with the pinned OpenCode and Pi upstream references.
- Added `THIRD_PARTY_NOTICES.md` with MIT notices and an unaffiliated-project attribution.
- No runtime Codex/ChatGPT/Luna model orchestration was added.

## Direct UX test performed

This was tested through the actual OpenCode source TUI, not only unit or backend tests.

The disposable harness was placed at `/tmp/viprah-ux-test-run3` and used:

- a local OpenAI-compatible SSE faux provider;
- a real stdio MCP server exposing an `echo` tool and `ux://status` resource;
- a project skill at `.opencode/skills/ux-skill/SKILL.md`;
- an OpenCode plugin recording system transforms, chat parameters, chat headers, and tool before/after hooks;
- an in-memory test database and isolated config so no user sessions or external provider calls were touched.

The visible TUI flow completed as:

```text
Skill "ux-skill"
ux_echo [value=from-real-tui]
read_mcp_resource [server=ux, uri=ux://status]
UX_MCP_SKILL_HOOK_PASS
```

The follow-up request after memory collection also returned `UX_MCP_SKILL_HOOK_PASS`. A rapid 100-turn stress sequence completed through turn 100 and continued returning the expected result.

The captured logs showed:

- skill loading followed by the expected skill marker;
- MCP `echo` tool execution;
- MCP `ux://status` resource reading;
- plugin system transformation, chat-parameter, and chat-header hooks;
- plugin tool-before and tool-after hooks;
- the cache key and stable prefix hash on every provider request;
- no provider, MCP, plugin, TUI, retry, panic, or exception errors in the checked run.

The faux provider was deliberately local and deterministic. This made the UX and request assembly observable without spending money or depending on external provider availability.

## Memory observations

The stress test intentionally sent 100 requests much faster than a human could type, so its transient high-water mark is not representative of ordinary pacing.

- During the burst, the TUI RSS rose transiently to roughly 753 MiB; the TUI, MCP server, and faux provider together peaked around 801 MiB.
- After rendering and queue activity settled, the TUI RSS returned to roughly 182–196 MiB; the MCP server and provider remained around 21–25 MiB each.
- There was no evidence of monotonic retained session growth after the burst.
- macOS `footprint` reported a higher native renderer/Bun allocation high-water mark than `ps` RSS, including swapped/native graphics allocations. This is a renderer/allocator caveat, not evidence that the bounded history is retaining all turn data.
- A renderer-thread variant and Bun `--smol` experiment did not improve the footprint and were not kept.

The practical result is bounded steady-state application memory for normal use, with a known transient OpenTUI/Bun high-water mark under an intentionally abusive rapid burst. A hard peak-memory ceiling has not been established.

## Verification completed

Source and focused behavior checks completed:

```text
bun run --cwd packages/opencode typecheck
PASS

bun test test/cli/run/runtime.queue.test.ts test/cli/run/runtime.test.ts test/cli/run/prompt.shared.test.ts --max-concurrency=1
23 pass, 0 fail, 76 expect

bun test test/session/system.test.ts test/plugin/trigger.test.ts test/mcp/lifecycle.test.ts --max-concurrency=1
29 pass, 0 fail, 78 expect

git diff --check
PASS
```

The context/compiler, session, cache-policy, compaction, overflow, provider, and benchmark checks were also exercised during implementation. The important acceptance signal for this request is the real TUI run above, including its captured provider, MCP, skill, hook, cache, and memory evidence.

## Known follow-up work

1. Install/use Bun 1.3.14+ and rerun the production single-binary build and `--version` smoke test.
2. Repeat the UX flow against any real provider the project intends to support, while keeping the faux-provider run for deterministic regression coverage.
3. Continue measuring provider-specific cache billing headers/usage where available; the current harness proves stable request prefixes and cache-key behavior, not a provider-independent billing guarantee.
4. Investigate OpenTUI/Bun native memory high-water behavior separately if a strict peak-RAM budget is required.
5. Keep OpenCode Bench as an optional later evaluation, not a merge gate for this milestone.

Disposable test evidence remains under `/tmp/viprah-ux-test-run3`; it is outside the repository and can be removed after review.
