export * as ConfigSwarmV1 from "./swarm"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"

export const Model = Schema.Struct({
  providerID: Schema.String.annotate({ description: "Provider ID, eg opencode-go" }),
  modelID: Schema.String.annotate({ description: "Model ID, eg deepseek-v4-flash" }),
}).annotate({ identifier: "SwarmModel" })
export type Model = Schema.Schema.Type<typeof Model>

export const PoolEntry = Schema.Struct({
  providerID: Schema.String.annotate({ description: "Provider ID, eg opencode-go" }),
  modelID: Schema.String.annotate({ description: "Model ID, eg deepseek-v4-flash" }),
  concurrency: Schema.optional(PositiveInt).annotate({
    description: "Maximum simultaneous worker sessions on this provider/model. Defaults to 4.",
  }),
}).annotate({ identifier: "SwarmPoolEntry" })
export type PoolEntry = Schema.Schema.Type<typeof PoolEntry>

export const Roles = Schema.Struct({
  planner: Schema.optional(Schema.mutable(Schema.Array(Model))).annotate({
    description: "Ordered fallback list of models for the planning role (single call producing the task DAG)",
  }),
  worker: Schema.optional(Schema.mutable(Schema.Array(PoolEntry))).annotate({
    description: "Worker pool. Tasks are assigned round-robin across entries, capped by each entry's concurrency",
  }),
  integrator: Schema.optional(Schema.mutable(Schema.Array(Model))).annotate({
    description: "Ordered fallback list of models for resolving merge conflicts",
  }),
  fixer: Schema.optional(Schema.mutable(Schema.Array(Model))).annotate({
    description: "Ordered fallback list of models for repairing central verification failures",
  }),
  reviewer: Schema.optional(Schema.mutable(Schema.Array(Model))).annotate({
    description:
      "Ordered fallback list of models for the quality gate after verification passes: judges output against the goal (copy, design, completeness), not just tests",
  }),
  tester: Schema.optional(Schema.mutable(Schema.Array(Model))).annotate({
    description:
      "Ordered fallback list of models for QA tester agents (browser/vision testing of the merged output). Defaults to the worker pool.",
  }),
}).annotate({ identifier: "SwarmRoles" })

export const Info = Schema.Struct({
  roles: Schema.optional(Roles).annotate({ description: "Model assignment per swarm role" }),
  workerTimeoutMs: Schema.optional(PositiveInt).annotate({
    description: "Maximum time in ms a worker session may run before it is aborted and failed over",
  }),
  staggerMs: Schema.optional(NonNegativeInt).annotate({
    description: "Delay in ms between worker launches sharing a provider, so only the first pays a cold cache",
  }),
  testerPercent: Schema.optional(NonNegativeInt).annotate({
    description:
      "Percentage of sub-agents designated as QA testers, relative to build task count (20 means 1 tester per 5 build tasks). Testers browser-test the merged output before the run passes. Defaults to 20.",
  }),
}).annotate({ identifier: "SwarmConfig" })
export type Info = Schema.Schema.Type<typeof Info>
