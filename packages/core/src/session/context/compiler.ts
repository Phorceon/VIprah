export * as ContextCompiler from "./compiler"

import { LLMRequest, SystemPart, type Message as LLMMessage, type Model, type ToolDefinition } from "@opencode-ai/llm"
import { Hash } from "../../util/hash"
import { Token } from "../../util/token"

/** The defaults used by both request budgeting and compaction. */
export const DEFAULT_RESERVE_TOKENS = 16_384
export const DEFAULT_RECENT_HISTORY_TOKENS = 20_000
export const DEFAULT_SUMMARY_OUTPUT_TOKENS = 4_096
export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 2_000
export const DEFAULT_CODING_AGENT_INSTRUCTIONS =
  "You are an expert coding assistant. Read the relevant files before making changes, use only the tools provided, and keep responses concise."
/**
 * Keep provider cache breakpoints on the invariant request prefix. Conversation
 * history is deliberately left unmarked so appending a new turn does not move
 * the breakpoint and invalidate the previous cache entry.
 */
export const DEFAULT_PROMPT_CACHE_POLICY = { tools: true, system: true } as const

export interface ContextPolicy {
  /** Absolute headroom kept for the provider response and compaction work. */
  readonly reserveTokens: number
  /** Approximate amount of recent history retained verbatim by compaction. */
  readonly recentHistoryTokens: number
  /** Maximum output budget used by a context summary request. */
  readonly summaryOutputTokens: number
  /** Maximum tool-result characters included in a summary. */
  readonly toolOutputMaxChars: number
}

export interface ContextPolicyOverrides {
  readonly reserveTokens?: number
  readonly recentHistoryTokens?: number
  readonly retainedHistoryTokens?: number
  readonly summaryOutputTokens?: number
  readonly summarizationTokens?: number
  readonly toolOutputMaxChars?: number
}

export const ContextPolicy = {
  defaults(overrides: ContextPolicyOverrides = {}): ContextPolicy {
    return {
      reserveTokens: nonNegative(overrides.reserveTokens ?? DEFAULT_RESERVE_TOKENS),
      recentHistoryTokens: nonNegative(
        overrides.recentHistoryTokens ?? overrides.retainedHistoryTokens ?? DEFAULT_RECENT_HISTORY_TOKENS,
      ),
      summaryOutputTokens: nonNegative(
        overrides.summaryOutputTokens ?? overrides.summarizationTokens ?? DEFAULT_SUMMARY_OUTPUT_TOKENS,
      ),
      toolOutputMaxChars: nonNegative(overrides.toolOutputMaxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS),
    }
  },
}

const tokenCache = new WeakMap<object, number>()
const sectionCache = new WeakMap<object, ContextSection[]>()
const systemCache = new WeakMap<object, SystemPart[]>()
const prefixCache = new WeakMap<
  object,
  WeakMap<object, { readonly serialized: string; readonly tokens: number; readonly hash: string }>
>()

export type ContextSectionInput =
  | string
  | {
      readonly key?: string
      readonly text: string
      /** Stable sections are emitted before volatile per-turn sections. */
      readonly stable?: boolean
      /** Explicit order is preferred when a caller has semantic ordering requirements. */
      readonly order?: number
    }

export interface ContextSection {
  readonly key: string
  readonly text: string
  readonly stable: boolean
  readonly order: number
}

export type CompactionState = "not-needed" | "needed" | "applied" | "blocked"

export interface ContextReport {
  readonly systemTokens: number
  readonly historyTokens: number
  readonly historyTokensBeforeSelection: number
  readonly omittedHistoryTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
  readonly estimatedTokens: number
  readonly providerInputTokens?: number
  readonly contextLimit?: number
  readonly reserveTokens: number
  readonly availableTokens?: number
  readonly cacheablePrefixTokens: number
  /** Alias for cacheablePrefixTokens kept for callers that use size terminology. */
  readonly cacheablePrefixSize: number
  readonly cacheablePrefixHash: string
  readonly compaction: {
    readonly state: CompactionState
    readonly required: boolean
  }
  readonly compactionState: CompactionState
  readonly overflowReason?: "context-window" | "reserve-budget" | "history-too-large"
}

export interface CompiledContext {
  /** Stable and volatile system sections in deterministic provider order. */
  readonly sections: ReadonlyArray<ContextSection>
  readonly systemSections: ReadonlyArray<ContextSection>
  readonly system: ReadonlyArray<SystemPart>
  /** Model-visible conversation after the caller's durable projection. */
  readonly messages: ReadonlyArray<LLMMessage>
  readonly projectedMessages: ReadonlyArray<LLMMessage>
  /** Active, permission-filtered definitions supplied by the caller. */
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly report: ContextReport
  readonly budget: ContextReport
}

export interface CompileInput {
  readonly model?: Model
  readonly contextLimit?: number
  readonly outputTokens?: number
  readonly policy?: ContextPolicyOverrides | ContextPolicy
  readonly system?: ReadonlyArray<ContextSectionInput>
  readonly messages?: ReadonlyArray<LLMMessage>
  readonly projectedMessages?: ReadonlyArray<LLMMessage>
  readonly tools?: ReadonlyArray<ToolDefinition>
  readonly activeToolNames?: ReadonlyArray<string> | ReadonlySet<string>
  readonly codingInstructions?: string
  readonly includeCodingInstructions?: boolean
  /** Keep only complete recent groups when the durable projection is larger than policy. */
  readonly retainHistory?: boolean
  readonly providerUsage?: {
    readonly inputTokens?: number
  }
  readonly compactionState?: CompactionState
}

/**
 * Compile all model-visible request components through one deterministic seam.
 *
 * The compiler never summarizes history. When recent-history retention is
 * enabled, it performs an explicit complete-group projection and reports what
 * was omitted; durable asynchronous summarization remains SessionCompaction's
 * responsibility.
 */
export function compile(input: CompileInput): CompiledContext {
  const policy = normalizePolicy(input.policy)
  const systemInput = input.system ?? []
  const hasCodingInstructions = input.includeCodingInstructions || input.codingInstructions !== undefined
  const cachedSections = !hasCodingInstructions && systemInput.length > 0 ? sectionCache.get(systemInput) : undefined
  const sections =
    cachedSections ??
    normalizeSections([
      ...(hasCodingInstructions
        ? [
            {
              key: "coding-agent",
              text: input.codingInstructions ?? DEFAULT_CODING_AGENT_INSTRUCTIONS,
              order: -1,
            },
          ]
        : []),
      ...systemInput,
    ])
  if (!cachedSections && !hasCodingInstructions && systemInput.length > 0) sectionCache.set(systemInput, sections)
  const cachedSystem = systemCache.get(sections)
  const system = cachedSystem ?? sections.map((section) => SystemPart.make(section.text))
  if (!cachedSystem) systemCache.set(sections, system)
  const allMessages = input.projectedMessages ?? input.messages ?? []
  const historyTokensBeforeSelection = estimate(allMessages)
  const selected =
    input.retainHistory === false || historyTokensBeforeSelection <= policy.recentHistoryTokens
      ? { messages: allMessages, tokens: historyTokensBeforeSelection }
      : selectRecentMessages(allMessages, policy.recentHistoryTokens)
  const messages = selected.messages
  const activeToolNames = input.activeToolNames === undefined ? undefined : new Set(input.activeToolNames)
  const materializedTools =
    activeToolNames === undefined
      ? (input.tools ?? [])
      : (input.tools ?? []).filter((tool) => activeToolNames.has(tool.name))
  const tools = sortTools(materializedTools)
  const systemTokens = estimate(system)
  const historyTokens = selected.tokens
  const toolTokens = estimate(tools)
  const estimatedTokens = systemTokens + historyTokens + toolTokens
  const providerInputTokens = input.providerUsage?.inputTokens
  const totalTokens = Math.max(estimatedTokens, providerInputTokens ?? 0)
  const contextLimit = input.contextLimit ?? input.model?.route.defaults.limits?.context
  const reserveTokens = Math.max(
    policy.reserveTokens,
    input.outputTokens ?? input.model?.route.defaults.limits?.output ?? 0,
  )
  const availableTokens = contextLimit === undefined ? undefined : Math.max(0, contextLimit - reserveTokens)
  const required = availableTokens !== undefined && totalTokens > availableTokens
  const compactionState = input.compactionState ?? (required ? "needed" : "not-needed")
  const overflowReason = required
    ? totalTokens > (contextLimit ?? 0)
      ? "context-window"
      : historyTokens > (availableTokens ?? 0)
        ? "history-too-large"
        : "reserve-budget"
    : undefined
  const prefix = cachedPrefix(sections, system, tools)
  const report: ContextReport = {
    systemTokens,
    historyTokens,
    historyTokensBeforeSelection,
    omittedHistoryTokens: Math.max(0, historyTokensBeforeSelection - historyTokens),
    toolTokens,
    totalTokens,
    estimatedTokens,
    providerInputTokens,
    contextLimit,
    reserveTokens,
    availableTokens,
    cacheablePrefixTokens: prefix.tokens,
    cacheablePrefixSize: prefix.tokens,
    cacheablePrefixHash: prefix.hash,
    compaction: { state: compactionState, required },
    compactionState,
    overflowReason,
  }

  return {
    sections,
    systemSections: sections,
    system,
    messages,
    projectedMessages: messages,
    tools,
    report,
    budget: report,
  }
}

function cachedPrefix(
  sections: ReadonlyArray<ContextSection>,
  system: ReadonlyArray<SystemPart>,
  tools: ReadonlyArray<ToolDefinition>,
) {
  const byTools = prefixCache.get(sections)
  const cached = byTools?.get(tools)
  if (cached) return cached
  const value = {
    serialized: stableSerialize({
      system: system.filter((_part, index) => sections[index]?.stable),
      tools,
    }),
    tokens: 0,
    hash: "",
  }
  const result = {
    serialized: value.serialized,
    tokens: Token.estimate(value.serialized),
    hash: Hash.sha256(value.serialized),
  }
  const cache = byTools ?? new WeakMap<object, typeof result>()
  if (!byTools) prefixCache.set(sections, cache)
  cache.set(tools, result)
  return result
}

/** Compile a canonical request while preserving all non-context request fields. */
export function compileRequest(
  request: LLMRequest,
  input: Omit<CompileInput, "model" | "system" | "messages" | "tools"> = {},
) {
  const compiled = compile({
    ...input,
    model: request.model,
    system: request.system.map((part) => ({ text: part.text })),
    messages: request.messages,
    tools: request.tools,
  })
  return { compiled, request: LLMRequest.update(request, compiledInput(compiled)) }
}

/**
 * Normalize string system sections for the legacy AI-SDK request path. It uses
 * the same ordering and empty-section rules as the V2 compiler without forcing
 * legacy ModelMessage/Tool shapes into the canonical LLM schema.
 */
export function compileSystem(sections: ReadonlyArray<ContextSectionInput>): string[] {
  return normalizeSections(sections).map((section) => section.text)
}

/** Estimate a provider request using the same conservative serialization as compile. */
export function estimateRequest(input: {
  readonly system: unknown
  readonly messages: unknown
  readonly tools: unknown
  readonly providerInputTokens?: number
}): number {
  return Math.max(
    estimate({ system: input.system, messages: input.messages, tools: input.tools }),
    input.providerInputTokens ?? 0,
  )
}

/**
 * Select complete recent conversational groups without splitting tool calls
 * from their results. If the newest group alone exceeds the budget it remains
 * intact and the caller can compact or report overflow rather than corrupting
 * the provider transcript.
 */
export function retainRecentMessages(messages: ReadonlyArray<LLMMessage>, budget: number): LLMMessage[] {
  return selectRecentMessages(messages, budget).messages
}

function selectRecentMessages(
  messages: ReadonlyArray<LLMMessage>,
  budget: number,
): { readonly messages: LLMMessage[]; readonly tokens: number } {
  if (messages.length === 0) return { messages: [], tokens: 0 }
  let total = 0
  let first = messages.length
  let groupSize = 0
  let retained = false
  const sizes = messages.map(estimate)
  for (let index = messages.length - 1; index >= 0; index--) {
    groupSize += sizes[index] ?? 0
    if (index !== 0 && messages[index]?.role !== "user") continue
    if (retained && total + groupSize > budget) break
    total += groupSize
    first = index
    groupSize = 0
    retained = true
  }
  return { messages: messages.slice(first), tokens: total }
}

function normalizePolicy(input: CompileInput["policy"]): ContextPolicy {
  if (!input) return ContextPolicy.defaults()
  return ContextPolicy.defaults(input)
}

function normalizeSections(input: ReadonlyArray<ContextSectionInput>): ContextSection[] {
  return input
    .flatMap((section, index) => {
      const value = typeof section === "string" ? { text: section } : section
      if (value.text.length === 0) return []
      return [
        {
          key: value.key ?? `section-${index}`,
          text: value.text,
          stable: value.stable ?? true,
          order: value.order ?? index,
        },
      ]
    })
    .toSorted((left, right) => {
      if (left.stable !== right.stable) return left.stable ? -1 : 1
      return left.order - right.order || left.key.localeCompare(right.key)
    })
}

function sortTools(tools: ReadonlyArray<ToolDefinition>): ReadonlyArray<ToolDefinition> {
  if (tools.length < 2) return tools
  const sorted = tools.toSorted((left, right) => left.name.localeCompare(right.name))
  return tools.every((tool, index) => tool === sorted[index]) ? tools : sorted
}

function compiledInput(compiled: CompiledContext): Partial<LLMRequest.Input> {
  return {
    system: compiled.system,
    messages: compiled.messages,
    tools: compiled.tools,
  }
}

function estimate(value: unknown): number {
  if (value !== null && typeof value === "object") {
    const cached = tokenCache.get(value)
    if (cached !== undefined) return cached
    const result = Token.estimate(JSON.stringify(value) ?? "")
    tokenCache.set(value, result)
    return result
  }
  return Token.estimate(JSON.stringify(value) ?? "")
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(",")}}`
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
