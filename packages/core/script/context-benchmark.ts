import { Message, ToolDefinition } from "@opencode-ai/llm"
import { ContextCompiler } from "../src/session/context"

type Case = {
  readonly name: string
  readonly turns: number
  readonly charsPerTurn: number
}

const cases: ReadonlyArray<Case> = [
  { name: "short", turns: 4, charsPerTurn: 400 },
  { name: "medium", turns: 200, charsPerTurn: 800 },
  { name: "long", turns: 320, charsPerTurn: 800 },
]

const system = [
  { key: "coding-agent", text: ContextCompiler.DEFAULT_CODING_AGENT_INSTRUCTIONS, stable: true, order: 0 },
  { key: "instructions", text: "Follow repository instructions and preserve existing APIs.", stable: true, order: 1 },
  { key: "environment", text: "Working directory: /benchmark/project", stable: false, order: 2 },
]
const tools = [
  new ToolDefinition({
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }),
  new ToolDefinition({
    name: "write",
    description: "Write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
  }),
]

for (const item of cases) {
  const messages = Array.from({ length: item.turns }, (_, index) =>
    Message.user(`Turn ${index}: ${"context ".repeat(Math.ceil(item.charsPerTurn / 8))}`),
  )
  const upstream = cumulative(messages, (history) =>
    ContextCompiler.estimateRequest({ system, messages: history, tools }),
  )
  const viprah = cumulative(
    messages,
    (history) =>
      ContextCompiler.compile({
        system,
        messages: history,
        tools,
        policy: { recentHistoryTokens: 20_000 },
        retainHistory: true,
      }).report.totalTokens,
  )
  const compileP95 = p95(() => {
    for (const history of [messages.slice(0, Math.ceil(messages.length / 2)), messages])
      ContextCompiler.compile({ system, messages: history, tools, retainHistory: true })
  })
  const serializeP95 = p95(() => {
    for (const history of [messages.slice(0, Math.ceil(messages.length / 2)), messages])
      ContextCompiler.estimateRequest({ system, messages: history, tools })
  })
  const reduction = upstream === 0 ? 0 : ((upstream - viprah) / upstream) * 100
  console.log(
    JSON.stringify({
      name: item.name,
      upstreamInputTokens: upstream,
      viprahInputTokens: viprah,
      cumulativeReductionPercent: Number(reduction.toFixed(2)),
      compileP95Ms: Number(compileP95.toFixed(3)),
      serializationP95Ms: Number(serializeP95.toFixed(3)),
      compileVsSerializationPercent: Number(
        (((compileP95 - serializeP95) / Math.max(serializeP95, 0.001)) * 100).toFixed(2),
      ),
    }),
  )
}

const cacheRequests = 100
let cacheHits = 0
let history: Message[] = []
let previous: { readonly system: unknown; readonly tools: unknown; readonly messages: unknown } | undefined
for (let index = 0; index < cacheRequests; index++) {
  history = [...history, Message.user(`Turn ${index}: inspect the next relevant file.`)]
  const compiled = ContextCompiler.compile({
    system: [{ key: "instructions", text: "Use the repository instructions.", stable: true, order: 0 }],
    messages: history,
    tools: index % 2 === 0 ? [...tools].reverse() : tools,
    policy: { recentHistoryTokens: 100_000 },
    retainHistory: true,
  })
  if (previous) {
    const prefix = JSON.stringify({
      system: compiled.system,
      tools: compiled.tools,
      messages: compiled.messages.slice(0, -1),
    })
    const prior = JSON.stringify(previous)
    if (prefix === prior) cacheHits++
  }
  previous = { system: compiled.system, tools: compiled.tools, messages: compiled.messages }
}
const promptCacheHitRatePercent = (cacheHits / cacheRequests) * 100
if (promptCacheHitRatePercent < 99) throw new Error(`Prompt cache hit rate below 99%: ${promptCacheHitRatePercent}%`)
console.log(
  JSON.stringify({
    name: "prompt-cache",
    requests: cacheRequests,
    hits: cacheHits,
    promptCacheHitRatePercent: Number(promptCacheHitRatePercent.toFixed(2)),
  }),
)

const upstreamStartupP95Ms = startupP95(["-e", 'await import("@opencode-ai/llm")'])
const viprahStartupP95Ms = startupP95(["-e", 'await import("./src/session/context")'])
console.log(
  JSON.stringify({
    name: "startup",
    upstreamStartupP95Ms: Number(upstreamStartupP95Ms.toFixed(3)),
    viprahStartupP95Ms: Number(viprahStartupP95Ms.toFixed(3)),
    startupVsUpstreamPercent: Number(
      (((viprahStartupP95Ms - upstreamStartupP95Ms) / Math.max(upstreamStartupP95Ms, 0.001)) * 100).toFixed(2),
    ),
  }),
)

function cumulative(messages: ReadonlyArray<Message>, count: (history: ReadonlyArray<Message>) => number) {
  return messages.reduce((total, _message, index) => total + count(messages.slice(0, index + 1)), 0)
}

function p95(run: () => void) {
  for (let index = 0; index < 3; index++) run()
  const samples = Array.from({ length: 20 }, () => {
    const start = performance.now()
    run()
    return performance.now() - start
  }).toSorted((left, right) => left - right)
  return samples[Math.ceil(samples.length * 0.95) - 1] ?? 0
}

function startupP95(args: ReadonlyArray<string>) {
  for (let index = 0; index < 2; index++)
    Bun.spawnSync({ cmd: [process.execPath, ...args], stdout: "ignore", stderr: "ignore" })
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now()
    const result = Bun.spawnSync({ cmd: [process.execPath, ...args], stdout: "ignore", stderr: "ignore" })
    if (result.exitCode !== 0) throw new Error(`startup benchmark exited with ${result.exitCode}`)
    return performance.now() - start
  }).toSorted((left, right) => left - right)
  return samples[Math.ceil(samples.length * 0.95) - 1] ?? 0
}
