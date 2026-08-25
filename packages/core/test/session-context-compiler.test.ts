import { expect, test } from "bun:test"
import { LLM, Message, Model, ToolDefinition } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ContextCompiler } from "@opencode-ai/core/session/context"

const tool = new ToolDefinition({
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
})
const writeTool = new ToolDefinition({
  name: "write",
  description: "Write a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
})

test("context policy uses Pi-style reserve, recent-history, and summary defaults", () => {
  expect(ContextCompiler.ContextPolicy.defaults()).toEqual({
    reserveTokens: 16_384,
    recentHistoryTokens: 20_000,
    summaryOutputTokens: 4_096,
    toolOutputMaxChars: 2_000,
  })
})

test("stable system prefix hash ignores conversation history changes", () => {
  const base = {
    system: [
      { key: "volatile", text: "today is Monday", stable: false, order: 3 },
      { key: "instructions", text: "Use the repository instructions.", stable: true, order: 1 },
      { key: "agent", text: "You are a coding agent.", stable: true, order: 0 },
    ],
    tools: [tool],
  }
  const first = ContextCompiler.compile({ ...base, messages: [Message.user("first request")] })
  const second = ContextCompiler.compile({ ...base, messages: [Message.user("a different request")] })

  expect(first.system.map((part) => part.text)).toEqual([
    "You are a coding agent.",
    "Use the repository instructions.",
    "today is Monday",
  ])
  expect(first.report.cacheablePrefixHash).toBe(second.report.cacheablePrefixHash)
  expect(first.report.cacheablePrefixTokens).toBe(second.report.cacheablePrefixTokens)
})

test("keeps the prompt-cache prefix reusable across append-only turns", () => {
  const system = [{ key: "instructions", text: "Use the repository instructions.", stable: true, order: 0 }]
  let history = [] as ReturnType<typeof Message.user>[]
  let previous: ReturnType<typeof ContextCompiler.compile> | undefined
  let hits = 0

  for (let index = 0; index < 100; index++) {
    history = [...history, Message.user(`Turn ${index}: inspect the next relevant file.`)]
    const compiled = ContextCompiler.compile({
      system,
      messages: history,
      tools: index % 2 === 0 ? [writeTool, tool] : [tool, writeTool],
      policy: { recentHistoryTokens: 100_000 },
      retainHistory: true,
    })

    if (previous) {
      const currentPrefix = JSON.stringify({
        system: compiled.system,
        tools: compiled.tools,
        messages: compiled.messages.slice(0, -1),
      })
      const previousRequest = JSON.stringify({
        system: previous.system,
        tools: previous.tools,
        messages: previous.messages,
      })
      if (currentPrefix === previousRequest) hits++
      expect(compiled.report.cacheablePrefixHash).toBe(previous.report.cacheablePrefixHash)
    }
    previous = compiled
  }

  expect(hits).toBeGreaterThanOrEqual(99)
})

test("uses a stable cache policy that does not move with conversation history", () => {
  expect(ContextCompiler.DEFAULT_PROMPT_CACHE_POLICY).toEqual({ tools: true, system: true })
  expect(ContextCompiler.DEFAULT_PROMPT_CACHE_POLICY).not.toHaveProperty("messages")
})

test("provider input usage is a conservative budget floor", () => {
  const compiled = ContextCompiler.compile({
    contextLimit: 100,
    policy: { reserveTokens: 10 },
    messages: [Message.user("small")],
    tools: [],
    providerUsage: { inputTokens: 95 },
  })

  expect(compiled.report.totalTokens).toBe(95)
  expect(compiled.report.compaction.required).toBe(true)
  expect(compiled.report.overflowReason).toBe("reserve-budget")
})

test("recent retention keeps assistant tool calls with their results", () => {
  const messages = [
    Message.user("old"),
    Message.assistant([{ type: "tool-call", id: "call-1", name: "read", input: { path: "a" } }]),
    Message.tool({ id: "call-1", name: "read", result: "old result" }),
    Message.user("new"),
  ]

  const retained = ContextCompiler.retainRecentMessages(messages, 40)
  expect(retained.at(-1)?.content).toEqual([{ type: "text", text: "new" }])
  expect(retained.some((message) => message.role === "tool")).toBe(false)

  const full = ContextCompiler.retainRecentMessages(messages, 10_000)
  expect(full.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])

  const oversized = [Message.user("x".repeat(1_000))]
  expect(ContextCompiler.retainRecentMessages(oversized, 0)).toEqual(oversized)
})

test("legacy system sections use the same deterministic empty-section handling", () => {
  expect(ContextCompiler.compileSystem(["", "first", { text: "second", stable: false }])).toEqual(["first", "second"])
})

test("compiler adds concise coding guidance and only exposes active tools", () => {
  const compiled = ContextCompiler.compile({
    includeCodingInstructions: true,
    system: [{ key: "instructions", text: "Project instructions", stable: true }],
    tools: [tool, writeTool],
    activeToolNames: new Set(["read"]),
    messages: [Message.user("inspect the project")],
  })

  expect(compiled.system[0]?.text).toBe(ContextCompiler.DEFAULT_CODING_AGENT_INSTRUCTIONS)
  expect(compiled.tools.map((item) => item.name)).toEqual(["read"])
})

test("canonical request compilation preserves provider and generation fields", () => {
  const request = LLM.request({
    id: "req_context",
    model: Model.make({ id: "model", provider: "provider", route: OpenAIChat.route }),
    system: "agent instructions",
    prompt: "old history",
    tools: [tool],
    generation: { maxTokens: 200 },
    http: { headers: { "x-request": "preserve" } },
  })
  const result = ContextCompiler.compileRequest(request, { retainHistory: false, includeCodingInstructions: true })

  expect(result.request.id).toBe(request.id)
  expect(result.request.model).toBe(request.model)
  expect(result.request.generation).toEqual(request.generation)
  expect(result.request.http).toEqual(request.http)
  expect(result.request.system[0]?.text).toBe(ContextCompiler.DEFAULT_CODING_AGENT_INSTRUCTIONS)
  expect(result.request.messages).toEqual(request.messages)
  expect(result.request.tools).toEqual(request.tools)
})
