# VIprah

A fork of [OpenCode](https://github.com/anomalyco/opencode) with custom
agent-orchestration work on top:

- **Swarm orchestration** — one goal becomes a planned task DAG executed by a
  parallel model pool, with worktree isolation, per-wave merges, a fixer loop,
  a vision-capable reviewer, and browser-driving QA testers. Configure and
  launch it from the TUI with `/swarm`; the driver lives in `swarm/`.
- **Session context compiler** — stable, cacheable prompt prefixes and
  centralized token budgets (`packages/core/src/session/context/`).
- **MCP toggle persistence**, prompt-cache-key plumbing, and assorted run-CLI
  fixes.

## Developing

This is a Bun monorepo. Run the TUI from source:

```sh
bun --cwd packages/opencode run --silent dev
```

**Agents: read [`AGENTS.md`](AGENTS.md) first** — it has the repo orientation
map and coding conventions. Other docs: `UPSTREAM.md` (upstream sync),
`VIPRAH_WORK_LOG.md` (chronological work log).

OpenCode is the upstream project; see `UPSTREAM.md` for pinned refs and
`THIRD_PARTY_NOTICES.md` for attributions. License: see `LICENSE`.
