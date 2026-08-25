# VIprah upstream sync

VIprah is bootstrapped from OpenCode and keeps the upstream histories pinned
locally for review and future synchronization:

| Upstream | Remote                                      | Pinned ref                                          |
| -------- | ------------------------------------------- | --------------------------------------------------- |
| OpenCode | `https://github.com/anomalyco/opencode.git` | `dev` / `e00890c67261a435cee6409366a68999a93393fd`  |
| Pi       | `https://github.com/earendil-works/pi.git`  | `main` / `c49906ec77788625aacbdc53ebca6fbe65bd20f5` |

The OpenCode TUI, provider integrations, permissions, MCP, plugins, agents,
and durable runner remain authoritative. Pi-inspired work in this repository
is limited to context assembly, selective history loading, token budgeting,
and compaction behavior; Pi's runtime and TUI are not imported.

New V2 sessions enter the compiler-backed context path. Existing OpenCode V1
sessions stay on their legacy path; VIprah does not translate or delete them.

The context implementation is an independent adaptation of Pi's prompt and
compaction behavior. VIprah is unaffiliated with OpenCode and Pi, and neither
project endorses or maintains VIprah.

The deterministic faux-provider benchmark is available with
`bun --cwd packages/core run bench:context`; it makes no live provider calls
and reports cumulative input-token savings plus compilation, serialization,
isolated module-startup p95, and the append-only prompt-cache prefix hit rate.
The V2 runner explicitly keeps cache breakpoints on stable system/tool content
and uses a session-stable provider cache key; provider usage still remains the
source of truth for external cache reads.

## Updating the pins

Fetch each remote, review the upstream diff, and update the table and refs in
the same change. Do not replace the pinned behavior with an unreviewed full
runtime import.
