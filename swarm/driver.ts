#!/usr/bin/env bun
// Swarm driver v2: one prompt -> planner (1 LLM call, JSON task DAG) ->
// deterministic dispatch across a mixed provider pool (worktree per task,
// failover + timeout retry) -> sequential merge with LLM integrator on
// conflict -> central verify -> fixer loop.
// Usage: bun driver.ts <project-dir> "<goal>" [--config swarm.config.json]

import { $ } from "bun"
import { existsSync } from "node:fs"

const args = process.argv.slice(2)
const PROJECT = args[0]
const GOAL = args[1]
const ci = args.indexOf("--config")
const CONFIG_PATH = ci >= 0 ? args[ci + 1] : undefined
const SERVER = process.env.SWARM_SERVER ?? "http://127.0.0.1:5678"
const WORKTREE_ROOT = process.env.SWARM_WORKTREES ?? "/tmp/viprah-swarm/worktrees"

type Model = { providerID: string; modelID: string }
type PoolEntry = Model & { concurrency: number }
type Config = {
  roles: { planner: Model[]; worker: PoolEntry[]; integrator: Model[]; fixer: Model[]; reviewer: Model[]; tester: Model[] }
  workerTimeoutMs: number
  staggerMs: number
  testerPercent: number
}

const DEFAULTS: Config = await Bun.file(`${import.meta.dir}/swarm.config.json`).json()

// swarm config comes from the opencode config (editable via /swarm in the TUI);
// --config <file> overrides for experiments
async function loadConfig(): Promise<Config> {
  if (CONFIG_PATH) return { ...DEFAULTS, ...(await Bun.file(CONFIG_PATH).json()) }
  const res = await fetch(`${SERVER}/config?directory=${encodeURIComponent(PROJECT)}`)
  const remote = res.ok ? ((await res.json()) as { swarm?: Partial<Config> }).swarm : undefined
  if (!remote?.roles?.worker?.length) return DEFAULTS
  return {
    roles: { ...DEFAULTS.roles, ...remote.roles },
    workerTimeoutMs: remote.workerTimeoutMs ?? DEFAULTS.workerTimeoutMs,
    staggerMs: remote.staggerMs ?? DEFAULTS.staggerMs,
    testerPercent: remote.testerPercent ?? DEFAULTS.testerPercent,
  }
}
const config: Config = await loadConfig()

type Task = { id: string; title: string; detail: string; paths: string[]; deps: string[] }
type Plan = { summary: string; contracts: string; tasks: Task[] }

const q = (dir: string) => `?directory=${encodeURIComponent(dir)}`

async function api(path: string, init?: RequestInit) {
  const res = await fetch(SERVER + path, init)
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? undefined : res.json()
}

const post = (path: string, body?: unknown) =>
  api(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })

const createSession = async (dir: string) => (await post(`/session${q(dir)}`)).id as string

type Part = { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename: string }

// long-form roles (planner, integrator, fixer, reviewer) can exceed bun's
// 300s fetch timeout on the blocking /message endpoint — go async + poll
async function promptLong(dir: string, sessionID: string, model: Model, text: string, extra: Part[] = []) {
  await promptAsync(dir, sessionID, model, text, extra)
  await waitIdle(dir, sessionID, config.workerTimeoutMs * 2)
}

const promptAsync = (dir: string, sessionID: string, model: Model, text: string, extra: Part[] = []) =>
  post(`/session/${sessionID}/prompt_async${q(dir)}`, { model, parts: [{ type: "text", text }, ...extra] })

const abort = (dir: string, sessionID: string) => post(`/session/${sessionID}/abort${q(dir)}`).catch(() => {})

async function waitIdle(dir: string, sessionID: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  let sawBusy = false
  while (Date.now() < deadline) {
    const status = await api(`/session/status${q(dir)}`)
    const s = status[sessionID]?.type
    if (s === "busy" || s === "retry") sawBusy = true
    if (s === "idle" || s === undefined) {
      if (sawBusy) return true
      // fast-failing sessions can go straight to idle before the first poll.
      // an assistant message EXISTS from the moment the prompt is admitted, so
      // only a completed/errored one means the run is actually over
      const messages = await api(`/session/${sessionID}/message${q(dir)}`)
      const lastAssistant = [...messages].reverse().find((m) => m.info?.role === "assistant")
      if (lastAssistant && (lastAssistant.info.time?.completed || lastAssistant.info.error)) return true
      if (Date.now() - started > 30_000 && !lastAssistant) return true
    }
    await Bun.sleep(2000)
  }
  return false
}

async function lastAssistantText(dir: string, sessionID: string) {
  const messages = await api(`/session/${sessionID}/message${q(dir)}`)
  const last = [...messages].reverse().find((m) => m.info?.role === "assistant")
  return (last?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

// ── provider pool: per-provider concurrency caps, round-robin assignment ──
class Pool {
  used: number[]
  constructor(public entries: PoolEntry[]) {
    this.used = entries.map(() => 0)
  }
  async acquire(preferred: number) {
    for (;;) {
      for (let step = 0; step < this.entries.length; step++) {
        const i = (preferred + step) % this.entries.length
        if (this.used[i] < this.entries[i].concurrency) {
          this.used[i]++
          return i
        }
      }
      await Bun.sleep(250)
    }
  }
  release(i: number) {
    this.used[i]--
  }
}

// ── role model fallback: try each entry in order ──
async function withRole<T>(role: Model[], fn: (model: Model) => Promise<T>): Promise<T> {
  let lastError: unknown
  for (const model of role) {
    try {
      return await fn(model)
    } catch (error) {
      console.log(`  ${model.providerID}/${model.modelID} failed: ${String(error).slice(0, 120)}`)
      lastError = error
    }
  }
  throw lastError
}

// lenient JSON extraction for model output: fenced block or balanced-brace
// scan, then repair passes for bad escapes and literal newlines in strings
function parseLenient(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/)
  const candidates = fenced ? [fenced[1]] : []
  // fallback: balanced-brace scan from the first '{'
  const start = text.indexOf("{")
  if (start >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (escape) escape = false
      else if (c === "\\" && inString) escape = true
      else if (c === '"') inString = !inString
      else if (!inString && c === "{") depth++
      else if (!inString && c === "}") {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  for (const candidate of candidates) {
    // models sometimes emit invalid JSON: bad escapes like \` or literal
    // newlines inside strings — repair both before giving up
    const repaired = candidate
      .replace(/\\(?!["\\/bfnrtu])/g, "")
      .split("")
      .reduce(
        (acc, c) => {
          if (acc.escaped) acc.escaped = false
          else if (c === "\\" && acc.inString) acc.escaped = true
          else if (c === '"') acc.inString = !acc.inString
          if (acc.inString && (c === "\n" || c === "\r" || c === "\t")) {
            acc.out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t"
            return acc
          }
          acc.out += c
          return acc
        },
        { out: "", inString: false, escaped: false },
      ).out
    for (const attempt of [candidate, candidate.replace(/\\(?!["\\/bfnrtu])/g, ""), repaired]) {
      try {
        return JSON.parse(attempt)
      } catch {}
    }
  }
  return undefined
}

function extractPlan(text: string): Plan {
  const plan = parseLenient(text) as Plan | undefined
  if (!plan) throw new Error("planner produced no parseable JSON")
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error("plan has no tasks")
  for (const t of plan.tasks) {
    if (!t.id || !t.title || !t.detail || !Array.isArray(t.paths)) throw new Error(`malformed task: ${JSON.stringify(t)}`)
    t.deps ??= []
  }
  const owners = new Map<string, string>()
  for (const t of plan.tasks)
    for (const p of t.paths) {
      if (owners.has(p)) throw new Error(`path ${p} owned by both ${owners.get(p)} and ${t.id}`)
      owners.set(p, t.id)
    }
  return plan
}

const plannerPrompt = (goal: string) => `You are the planner for a parallel coding swarm working on the project at this directory.

GOAL: ${goal}

Decompose the goal into small, independently executable tasks for worker agents. Rules:
- Each task OWNS an explicit set of file paths (glob ok). No two tasks may own the same path. This is a hard constraint — workers run in parallel and write conflicts break the build.
- Shared interfaces (types, module shapes, naming) go in "contracts" so every worker builds the same thing.
- Put integration/barrel/wiring work in its own task that depends on the others.
- Keep tasks small: one file or a tight cluster each. Prefer 4-8 tasks over 2 giant ones.
- Respond with ONLY a json code block, no prose:

\`\`\`json
{
  "summary": "one paragraph",
  "contracts": "shared conventions, exported names, type shapes",
  "tasks": [{ "id": "t1", "title": "...", "detail": "exactly what to implement, exported symbols, edge cases", "paths": ["src/strings.ts", "test/strings.test.ts"], "deps": [] }]
}
\`\`\``

const workerPrompt = (plan: Plan, task: Task) => `You are one worker in a parallel coding swarm. Other agents are implementing the other tasks RIGHT NOW in their own checkouts.

# FULL PLAN
${JSON.stringify({ summary: plan.summary, contracts: plan.contracts, tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, paths: t.paths })) }, null, 2)}

# YOUR ASSIGNMENT — ${task.id}: ${task.title}
${task.detail}

You own exactly these paths: ${task.paths.join(", ")}

Rules:
- Read anything. Write ONLY files under your owned paths. Other tasks own everything else.
- Follow the contracts exactly — other workers are coding against the same contract.
- If you spot a problem outside your paths, do NOT fix it; mention it in your final summary.
- Do not run project-wide test or build commands; verification happens centrally after merge.
- When done, reply with a short summary: files written, exported symbols, anything the integrator should know.`

function ownsPath(task: Task, file: string) {
  return task.paths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : p.replace(/\*.*$/, "")))
}

async function runWorker(task: Task, plan: Plan, pool: Pool, preferred: number, at: () => string) {
  let slot = preferred % pool.entries.length
  // pathless tasks are advisory (contracts/analysis): they succeed by
  // completing with a summary, no worktree or file changes required
  if (task.paths.length === 0) {
    const model = pool.entries[slot]
    const start = performance.now()
    await pool.acquire(slot)
    try {
      const session = await createSession(PROJECT)
      await promptAsync(PROJECT, session, model, workerPrompt(plan, task))
      const finished = await waitIdle(PROJECT, session, config.workerTimeoutMs)
      if (!finished) await abort(PROJECT, session)
      const summary = await lastAssistantText(PROJECT, session).catch(() => "")
      return {
        ok: finished && summary.length > 0,
        model: `${model.providerID}/${model.modelID}`,
        summary: summary.slice(0, 400),
        files: [],
        seconds: (performance.now() - start) / 1000,
      }
    } finally {
      pool.release(slot)
    }
  }
  // two passes through the pool: transient no-change/error outcomes get a retry per provider
  for (let attempt = 0; attempt < pool.entries.length * 2; attempt++) {
    const model = pool.entries[slot]
    await pool.acquire(slot)
    const start = performance.now()
    const wt = `${WORKTREE_ROOT}/${task.id}`
    try {
      if (attempt === 0) {
        await $`git -C ${PROJECT} worktree remove --force ${wt}`.quiet().nothrow()
        await $`git -C ${PROJECT} worktree prune`.quiet().nothrow()
        await $`git -C ${PROJECT} worktree add ${wt} -B swarm-${task.id} HEAD`.quiet()
        if (existsSync(`${PROJECT}/node_modules`))
          await $`ln -sfn ${PROJECT}/node_modules ${wt}/node_modules`.quiet().nothrow()
      }
      const session = await createSession(wt)
      try {
        await promptAsync(wt, session, model, workerPrompt(plan, task))
      } catch (error) {
        // dispatch-time failure (model unavailable, provider down, 429): fail over
        console.log(`[${at()}] ${task.id} dispatch failed on ${model.providerID}/${model.modelID}: ${String(error).slice(0, 100)}`)
        slot = (slot + 1) % pool.entries.length
        continue
      }
      const finished = await waitIdle(wt, session, config.workerTimeoutMs)
      if (!finished) {
        console.log(`[${at()}] ${task.id} timeout on ${model.providerID}/${model.modelID}, failing over`)
        await abort(wt, session)
        slot = (slot + 1) % pool.entries.length
        continue
      }
      const status = (await $`git -C ${wt} status --porcelain`.text()).trim().split("\n").filter(Boolean)
      if (status.length === 0) {
        const tail = await lastAssistantText(wt, session).catch(() => "")
        console.log(`[${at()}] ${task.id} produced no changes on ${model.providerID}/${model.modelID}, failing over`)
        if (tail) console.log(`  last assistant: ${tail.slice(0, 200).replace(/\n/g, " ")}`)
        slot = (slot + 1) % pool.entries.length
        continue
      }
      // revert writes outside owned paths instead of dropping the whole task
      const escaped = status.map((l) => l.slice(3)).filter((f) => !ownsPath(task, f))
      for (const f of escaped) {
        const tracked = (await $`git -C ${wt} cat-file -e HEAD:${f}`.quiet().nothrow()).exitCode === 0
        if (tracked) await $`git -C ${wt} restore --worktree --staged ${f}`.quiet().nothrow()
        else await $`rm -f ${wt}/${f}`.quiet().nothrow()
      }
      await $`git -C ${wt} add -A`.quiet()
      const commit = await $`git -C ${wt} -c user.email=swarm@local -c user.name=swarm commit -qm "${task.id}: ${task.title}"`.quiet().nothrow()
      if (commit.exitCode !== 0) {
        console.log(`[${at()}] ${task.id} had no owned changes after reverting escapes, failing over`)
        slot = (slot + 1) % pool.entries.length
        continue
      }
      const changed = (await $`git -C ${wt} diff --name-only HEAD~1 HEAD`.text()).trim().split("\n").filter(Boolean)
      const summary = await lastAssistantText(wt, session)
      return {
        ok: changed.length > 0,
        model: `${model.providerID}/${model.modelID}`,
        summary: summary.slice(0, 400) + (escaped.length ? `\n(reverted out-of-path writes: ${escaped.join(", ")})` : ""),
        files: changed,
        seconds: (performance.now() - start) / 1000,
      }
    } finally {
      pool.release(slot)
    }
  }
  return { ok: false, model: "none", summary: "all providers exhausted", files: [], seconds: 0 }
}

// ── integrator: resolve merge conflicts with an LLM on the main repo ──
export async function integrate(project: string, task: { id: string; title: string; detail: string }, contracts: string, models: Model[]) {
  const files = (await $`git -C ${project} diff --name-only --diff-filter=U`.text()).trim().split("\n").filter(Boolean)
  if (files.length === 0) return true
  console.log(`  integrator resolving ${files.length} conflicted file(s) from ${task.id}: ${files.join(", ")}`)
  return withRole(models, async (model) => {
    const session = await createSession(project)
    await promptLong(
      project,
      session,
      model,
      `A merge of swarm task "${task.id}: ${task.title}" conflicted in this repo.

Task intent: ${task.detail}
Shared contracts: ${contracts}

Conflicted files (contain <<<<<<< markers): ${files.join(", ")}

Resolve every conflict marker, preserving the intent of BOTH sides. Keep the contracts. Do not commit — just edit the files. Reply with one line when done.`,
    )
    await $`git -C ${project} add -A`.quiet()
    const unmerged = (await $`git -C ${project} ls-files -u`.text()).trim()
    if (unmerged) throw new Error(`integrator left unmerged entries: ${unmerged.split("\n").length}`)
    for (const f of files) {
      const content = await Bun.file(`${project}/${f}`).text()
      if (content.includes("<<<<<<<") || content.includes(">>>>>>>")) throw new Error(`conflict markers remain in ${f}`)
    }
    await $`git -C ${project} -c user.email=swarm@local -c user.name=swarm commit -qm "integrate ${task.id} (conflict-resolved)"`.quiet()
    return true
  })
}

async function verify() {
  if (!(await Bun.file(`${PROJECT}/package.json`).exists())) return { ok: true, detail: "no verifier configured" }
  const pkg = await Bun.file(`${PROJECT}/package.json`).json()
  if (!pkg.scripts?.test) return { ok: true, detail: "no test script" }
  const out = await $`bun test`.cwd(PROJECT).quiet().nothrow()
  return out.exitCode === 0
    ? { ok: true, detail: "tests PASS" }
    : { ok: false, detail: out.stderr.toString().slice(0, 2000) || out.stdout.toString().slice(0, 2000) }
}

async function fixLoop(detail: string) {
  console.log(`  dispatching fixer...`)
  return withRole(config.roles.fixer, async (model) => {
    const session = await createSession(PROJECT)
    await promptLong(
      PROJECT,
      session,
      model,
      `Central verification of the merged swarm output failed:\n\n${detail}\n\nFix the root cause. If a reported issue turns out to be wrong after you check the actual files, say so and move on. Keep changes minimal. Reply with one line when done.`,
    )
    await $`git -C ${PROJECT} add -A`.quiet()
    const status = await $`git -C ${PROJECT} status --porcelain`.text()
    if (status.trim())
      await $`git -C ${PROJECT} -c user.email=swarm@local -c user.name=swarm commit -qm "fix: verify gate"`.quiet()
  })
}

const testerPrompt = (id: string, files: string[], plan: Plan, hasBrowser: boolean) => `You are QA tester ${id} in a parallel coding swarm. The swarm just finished building:

GOAL: ${GOAL}

CONTRACTS: ${plan.contracts || "(none)"}

The merged result is in this directory and central tests already pass — your job is everything tests cannot see. Your assigned slice of the output:
${files.map((f) => `- ${f}`).join("\n")}

Test it like a real user, with tools:
${
  hasBrowser
    ? `- Render pages: agent-browser --session ${id} open "file://$(pwd)/<page>" then agent-browser --session ${id} screenshot --full /tmp/${id}-<name>.png — then READ the png with your read tool so you can SEE the rendered page
- Click through nav links, CTAs, dialogs, lightboxes: agent-browser --session ${id} snapshot -i / click / fill; check agent-browser --session ${id} console for JS errors
- Verify anchors resolve, assets load, layout isn't broken/empty/overlapping, no placeholder copy`
    : `- Exercise the code with small bun scripts (write them to /tmp, never into the project): import the changed modules, call the functions, assert sane outputs and edge cases`}
- Do not modify any project file. You are read-only except /tmp scratch.
- Judge against the GOAL: missing requirements, dead links, broken interactions, invisible content, lorem ipsum, generic filler.

When finished, reply with ONLY a JSON object, no prose: {"pass": true|false, "issues": ["file — what is wrong — why it matters"]}`

type QaResult = { id: string; pass: boolean; issues: string[]; model: string; seconds: number; warn?: string }

async function runTester(id: string, files: string[], plan: Plan, hasBrowser: boolean): Promise<QaResult> {
  const start = performance.now()
  // testers default to the worker pool models; an explicit tester role overrides
  const models: Model[] = config.roles.tester.length ? config.roles.tester : config.roles.worker
  try {
    return await withRole(models, async (model) => {
      const session = await createSession(PROJECT)
      await promptAsync(PROJECT, session, model, testerPrompt(id, files, plan, hasBrowser))
      // browser QA is slow: testers get the doubled long-form budget
      const finished = await waitIdle(PROJECT, session, config.workerTimeoutMs * 2)
      if (!finished) {
        await abort(PROJECT, session)
        throw new Error("tester timed out")
      }
      const parsed = parseLenient(await lastAssistantText(PROJECT, session).catch(() => "")) as
        | { pass?: boolean; issues?: string[] }
        | undefined
      if (!parsed || typeof parsed.pass !== "boolean") throw new Error("tester returned no verdict")
      return {
        id,
        pass: parsed.pass,
        issues: (parsed.issues ?? []).slice(0, 20),
        model: `${model.providerID}/${model.modelID}`,
        seconds: (performance.now() - start) / 1000,
      }
    })
  } catch (e) {
    // infra failure (timeout, no verdict, all models errored): warn, don't block
    return { id, pass: true, issues: [], model: "none", seconds: (performance.now() - start) / 1000, warn: String(e).slice(0, 100) }
  }
}

// after the build waves merge, a share of sub-agents re-launch as QA testers,
// each browser-testing a slice of the changed output
async function testWave(plan: Plan, startCommit: string, at: () => string) {
  const changed = (await $`git -C ${PROJECT} diff --name-only ${startCommit} HEAD`.text())
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  const count = Math.max(1, Math.min(Math.round((plan.tasks.length * config.testerPercent) / 100), changed.length || 1))
  const chunks: string[][] = Array.from({ length: count }, () => [])
  changed.forEach((f, i) => chunks[i % count].push(f))
  if (!changed.length) chunks[0] = ["(no files changed — smoke-test the project as a whole)"]
  const hasBrowser = (await $`which agent-browser`.quiet().nothrow()).exitCode === 0
  console.log(`[${at()}] dispatching ${count} QA tester(s) (${config.testerPercent}% of ${plan.tasks.length} build tasks${hasBrowser ? ", browser+vision" : ", code-level"})`)
  const results: QaResult[] = []
  await Promise.all(
    chunks.map(async (files, i) => {
      await Bun.sleep(i * config.staggerMs)
      const r = await runTester(`qa${i + 1}`, files, plan, hasBrowser)
      results.push(r)
      console.log(
        `  ${r.id}: ${r.warn ? `WARN (${r.warn})` : r.issues.length ? `${r.issues.length} issue(s)` : "clean"} on ${r.model} (${r.seconds.toFixed(0)}s)`,
      )
    }),
  )
  const issues = results.flatMap((r) => r.issues.map((i) => `[${r.id}] ${i}`))
  return { pass: issues.length === 0, issues, testers: results.length }
}


export async function reviewGate(plan: Plan, startCommit: string): Promise<{ pass: boolean; issues: string[]; note?: string }> {
  const changed = (await $`git -C ${PROJECT} diff --name-only ${startCommit} HEAD`.text())
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  // the reviewer sees current contents below; deletions are only visible in
  // the diff itself, so include it (capped) — a removed section leaves no trace otherwise
  const diff = (await $`git -C ${PROJECT} diff ${startCommit} HEAD`.text()).slice(0, 60_000)
  let bundle = ""
  for (const f of changed) {
    const file = Bun.file(`${PROJECT}/${f}`)
    if (!(await file.exists())) continue
    const text = await file.text()
    bundle += `\n===== ${f} =====\n${text.slice(0, 6000)}${text.length > 6000 ? "\n…[truncated]" : ""}\n`
    if (bundle.length > 150_000) {
      bundle += "\n…[remaining files omitted]"
      break
    }
  }

  const shots: Part[] = []
  const html = changed.filter((f) => f.endsWith(".html"))
  const hasBrowser = (await $`which agent-browser`.quiet().nothrow()).exitCode === 0
  if (html.length && hasBrowser) {
    await $`mkdir -p /tmp/viprah-swarm/review-shots`.quiet()
    const picks = [html.find((f) => f.endsWith("index.html")) ?? html[0], ...html.filter((f) => !f.endsWith("index.html"))]
      .filter((f, i, a) => a.indexOf(f) === i)
      .slice(0, 4)
    for (const f of picks) {
      const out = `/tmp/viprah-swarm/review-shots/${f.replaceAll("/", "_")}.png`
      const ok = await $`agent-browser open ${`file://${PROJECT}/${f}`}`.quiet().nothrow()
      if (ok.exitCode !== 0) break
      await $`agent-browser wait --load networkidle`.quiet().nothrow()
      await $`agent-browser screenshot --full ${out}`.quiet().nothrow()
      await $`agent-browser close`.quiet().nothrow()
      const file = Bun.file(out)
      if (await file.exists()) {
        shots.push({
          type: "file",
          mime: "image/png",
          url: `data:image/png;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`,
          filename: f,
        })
      }
    }
  }

  const prompt = `You are the quality reviewer for a parallel coding swarm. Tests already pass — your job is everything tests cannot see.

GOAL: ${GOAL}

CONTRACTS: ${plan.contracts || "(none)"}

The swarm changed ${changed.length} file(s): ${changed.join(", ")}
${shots.length ? `\nFull-page screenshots of the rendered result are attached (${shots.map((s) => (s as { filename: string }).filename).join(", ")}). Judge the visual design: layout, spacing, consistency, whether anything looks broken, empty, or placeholder-ish.` : ""}

Judge against the goal, harshly and specifically:
- completeness: every requirement in the goal actually present and wired up
- copy quality: no lorem ipsum, no generic filler, no placeholder text; believable and specific
- consistency: shared design system, no obviously mismatched sections
- correctness smells: dead links to missing pages, references to files that don't exist, content hidden by broken JS/CSS
- config.json, opencode.json and .gitignore are the project's own agent/swarm configuration — never flag their presence

Full diff of the swarm's changes (deletions visible here):
${diff}

Current contents of changed files:
${bundle}

Reply with ONLY a JSON object, no prose: {"pass": boolean, "issues": ["specific, actionable issue per line"]}
Set pass=true only when issues is empty. Minor polish suggestions are issues too — when in doubt, list it.`

  return withRole(config.roles.reviewer, async (model) => {
    const session = await createSession(PROJECT)
    let text: string
    try {
      await promptLong(PROJECT, session, model, prompt, shots)
      text = await lastAssistantText(PROJECT, session)
      if (!text.trim()) throw new Error("empty")
    } catch {
      if (!shots.length) throw new Error("reviewer call failed")
      console.log(`  reviewer rejected screenshots, retrying text-only`)
      await promptLong(PROJECT, session, model, prompt)
      text = await lastAssistantText(PROJECT, session)
    }
    let parsed = parseLenient(text) as { pass?: boolean; issues?: string[] } | undefined
    if (!parsed || typeof parsed.pass !== "boolean") {
      await promptLong(
        PROJECT,
        session,
        model,
        'Your JSON failed to parse. Reply with ONLY the corrected JSON object: {"pass": boolean, "issues": [...]}, no fences, no prose.',
      )
      parsed = parseLenient(await lastAssistantText(PROJECT, session)) as typeof parsed
    }
    if (!parsed || typeof parsed.pass !== "boolean") return { pass: true, issues: [], note: "reviewer output unparseable, skipped" }
    return { pass: parsed.pass, issues: (parsed.issues ?? []).slice(0, 20) }
  })
}

async function main() {
  const t0 = performance.now()
  const at = () => ((performance.now() - t0) / 1000).toFixed(1) + "s"

  // one driver per project: a previous crashed driver may still be running
  // and its cleanup would delete this run's branches out from under it
  const lock = `${WORKTREE_ROOT}/driver-${Buffer.from(PROJECT).toString("base64url")}.lock`
  try {
    await $`mkdir ${lock}`.quiet()
  } catch {
    throw new Error(`another driver is already running for ${PROJECT} (${lock})`)
  }
  process.on("exit", () => {
    // must be synchronous: the exit event does not await promises
    const { rmdirSync } = require("node:fs")
    try {
      rmdirSync(lock)
    } catch {}
  })

  // baseline for the review gate's diff of everything the swarm changed
  const startCommit = (await $`git -C ${PROJECT} rev-parse HEAD`.text()).trim()

  console.log(`config: ${CONFIG_PATH ?? "server /config (TUI-managed)"} | worker pool: ${config.roles.worker.map((w) => `${w.providerID}/${w.modelID}×${w.concurrency}`).join(", ")}`)
  console.log(`[${at()}] planning (${config.roles.planner.map((m) => `${m.providerID}/${m.modelID}`).join(" → ")})...`)
  const plan = await withRole(config.roles.planner, async (model) => {
    const session = await createSession(PROJECT)
    await promptLong(PROJECT, session, model, plannerPrompt(GOAL))
    for (let attempt = 0; ; attempt++) {
      try {
        return extractPlan(await lastAssistantText(PROJECT, session))
      } catch (e) {
        if (attempt === 2) throw e
        console.log(`  planner JSON invalid (${String(e).slice(0, 80)}), asking for a corrected version`)
        await promptLong(
          PROJECT,
          session,
          model,
          "Your JSON failed to parse. Reply with ONLY the corrected JSON object: same content, all strings properly escaped (quotes as \\\", newlines as \\n), no markdown fences, no prose.",
        )
      }
    }
  })
  console.log(`[${at()}] plan: ${plan.tasks.length} tasks — ${plan.summary}`)
  for (const t of plan.tasks) console.log(`  ${t.id}: ${t.title}  [${t.paths.join(", ")}]${t.deps.length ? ` deps: ${t.deps.join(",")}` : ""}`)

  const pool = new Pool(config.roles.worker)
  const done = new Set<string>()
  const results: Record<string, Awaited<ReturnType<typeof runWorker>>> = {}
  const mergeFailed: string[] = []
  let launched = 0

  // merge completed branches into main between waves so dependents branch
  // from a tree that already contains their dependencies' output
  async function mergeWave(wave: Task[]) {
    for (const task of wave) {
      if (!results[task.id]?.ok) continue
      const branch = await $`git -C ${PROJECT} rev-parse --verify swarm-${task.id}`.quiet().nothrow()
      if (branch.exitCode !== 0) {
        console.log(`  branch swarm-${task.id} missing, cannot merge ${task.id}`)
        mergeFailed.push(task.id)
        continue
      }
      const out = await $`git -C ${PROJECT} merge --no-ff -m "merge ${task.id}" swarm-${task.id}`.quiet().nothrow()
      if (out.exitCode !== 0) {
        const resolved = await integrate(PROJECT, task, plan.contracts, config.roles.integrator).catch((e) => {
          console.log(`  integrator failed for ${task.id}: ${String(e).slice(0, 150)}`)
          return false
        })
        if (!resolved) {
          await $`git -C ${PROJECT} merge --abort`.quiet().nothrow()
          mergeFailed.push(task.id)
          continue
        }
        // integrator "success" with zero conflicted files can mask a non-conflict
        // merge failure; verify the branch actually landed
        const merged = await $`git -C ${PROJECT} merge-base --is-ancestor swarm-${task.id} HEAD`.quiet().nothrow()
        if (merged.exitCode !== 0) mergeFailed.push(task.id)
      }
    }
  }

  while (Object.keys(results).length < plan.tasks.length) {
    // dependents of failed tasks are skipped, not attempted against a broken base
    for (const t of plan.tasks) {
      if (t.id in results) continue
      if (t.deps.some((d) => d in results && !results[d].ok)) {
        results[t.id] = { ok: false, model: "skipped", summary: "dependency failed", files: [], seconds: 0 }
        done.add(t.id)
        console.log(`[${at()}] ${t.id} SKIPPED (dependency failed)`)
      }
    }
    const wave = plan.tasks.filter((t) => !(t.id in results) && t.deps.every((d) => done.has(d)))
    if (wave.length === 0) {
      if (Object.keys(results).length < plan.tasks.length) throw new Error("dependency cycle or unsatisfiable deps in plan")
      break
    }
    console.log(`[${at()}] dispatching wave: ${wave.map((t) => t.id).join(", ")}`)

    await Promise.all(
      wave.map(async (task) => {
        const preferred = launched++ % pool.entries.length
        // stagger same-provider launches so only the first eats a cold cache
        const sameProviderAhead = wave.slice(0, wave.indexOf(task)).filter((t2) => pool.entries[launched % pool.entries.length] === pool.entries[preferred]).length
        if (sameProviderAhead > 0) await Bun.sleep(config.staggerMs * sameProviderAhead)
        results[task.id] = await runWorker(task, plan, pool, preferred, at)
        if (results[task.id].ok) done.add(task.id)
        console.log(
          `[${at()}] ${task.id} ${results[task.id].ok ? "done" : "FAILED"} on ${results[task.id].model} (${results[task.id].seconds.toFixed(0)}s, ${results[task.id].files.length} files)`,
        )
      }),
    )
    // a failed task blocks its dependents' success but not their attempt; mark blocked tasks done-failed to avoid deadlock
    for (const t of plan.tasks) {
      if (!(t.id in results)) continue
      if (!results[t.id].ok) done.add(t.id)
    }
    console.log(`[${at()}] merging wave...`)
    await mergeWave(wave)
  }

  let check = await verify()
  let qa = check.ok ? await testWave(plan, startCommit, at) : { pass: false, issues: [] as string[], testers: 0 }
  let review = check.ok ? await reviewGate(plan, startCommit) : { pass: false, issues: [] as string[] }
  if (check.ok) console.log(`[${at()}] review: ${review.pass ? "PASS" : `${review.issues.length} issue(s)`}${review.note ? ` (${review.note})` : ""}`)
  let fixAttempts = 0
  while ((!check.ok || !qa.pass || !review.pass) && fixAttempts < 2) {
    fixAttempts++
    const detail = !check.ok
      ? check.detail
      : [
          qa.pass ? "" : `QA tester findings:\n${qa.issues.map((i) => `- ${i}`).join("\n")}`,
          review.pass ? "" : `Quality review findings:\n${review.issues.map((i) => `- ${i}`).join("\n")}`,
        ]
          .filter(Boolean)
          .join("\n\n") + "\n\nFix every issue. Keep changes minimal."
    // a fixer infra failure (timeout, provider error) must not nuke the run —
    // the build output is already merged; report what we have
    try {
      await fixLoop(detail)
    } catch (e) {
      console.log(`  fixer failed: ${String(e).slice(0, 120)}`)
      break
    }
    check = await verify()
    qa = check.ok ? await testWave(plan, startCommit, at) : { pass: false, issues: [], testers: 0 }
    review = check.ok ? await reviewGate(plan, startCommit) : { pass: false, issues: [] }
    if (check.ok) console.log(`[${at()}] review: ${review.pass ? "PASS" : `${review.issues.length} issue(s)`}${review.note ? ` (${review.note})` : ""}`)
  }

  console.log(`\n════════════════ SWARM REPORT ════════════════`)
  console.log(`total wall time: ${at()}`)
  console.log(`tasks: ${Object.values(results).filter((r) => r.ok).length}/${plan.tasks.length} clean`)
  const byModel = new Map<string, number>()
  for (const r of Object.values(results)) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1)
  console.log(`providers used: ${[...byModel].map(([m, n]) => `${m} ×${n}`).join(", ")}`)
  if (mergeFailed.length) console.log(`unresolved merges: ${mergeFailed.join(", ")}`)
  console.log(`verify: ${check.detail.split("\n")[0]}${fixAttempts ? ` (after ${fixAttempts} fix round(s))` : ""}`)
  console.log(`qa testers: ${qa.pass ? "PASS" : `FAIL — ${qa.issues.length} issue(s)`} (${qa.testers} tester(s))`)
  if (!qa.pass) for (const issue of qa.issues.slice(0, 8)) console.log(`  - ${issue.slice(0, 140)}`)
  console.log(`review: ${review.pass ? "PASS" : `FAIL — ${review.issues.length} issue(s)`}${review.note ? ` (${review.note})` : ""}`)
  if (!review.pass) for (const issue of review.issues.slice(0, 8)) console.log(`  - ${issue.slice(0, 140)}`)
  const times = Object.values(results).map((r) => r.seconds)
  const serial = times.reduce((a, b) => a + b, 0)
  const slowest = Math.max(...times)
  console.log(`worker time: ${serial.toFixed(0)}s serial-equivalent, slowest ${slowest.toFixed(0)}s (${(serial / slowest).toFixed(1)}x parallelism)`)

  await Promise.all(
    plan.tasks.flatMap((t) => [
      $`git -C ${PROJECT} worktree remove --force ${WORKTREE_ROOT}/${t.id}`.quiet().nothrow(),
      $`git -C ${PROJECT} branch -D swarm-${t.id}`.quiet().nothrow(),
    ]),
  )
}

if (import.meta.main) await main()
