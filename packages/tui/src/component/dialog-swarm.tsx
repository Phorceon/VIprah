import { createMemo } from "solid-js"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { pipe, entries, map, sortBy } from "remeda"

type Model = { providerID: string; modelID: string }
type PoolEntry = Model & { concurrency?: number }
type Roles = {
  planner?: Model[]
  worker?: PoolEntry[]
  integrator?: Model[]
  fixer?: Model[]
  reviewer?: Model[]
  tester?: Model[]
}
type Swarm = { roles?: Roles; workerTimeoutMs?: number; staggerMs?: number; testerPercent?: number }

const SIMPLE_ROLES = ["planner", "integrator", "fixer", "reviewer", "tester"] as const

function label(model: Model | undefined) {
  return model ? `${model.providerID}/${model.modelID}` : "not set"
}

export function DialogSwarm() {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  const swarm = createMemo<Swarm>(() => (sync.data.config as { swarm?: Swarm }).swarm ?? {})

  async function save(next: Swarm) {
    const result = await sdk.client.config.update({ config: { swarm: next } }).catch((error) => ({ error }))
    if ("error" in result && result.error) {
      toast.show({ message: "Failed to save swarm config", variant: "error" })
      return
    }
    // update the local store immediately: the server disposes and reloads the
    // instance after a config update, so a refetch here can race the reload
    sync.set("config", { ...sync.data.config, swarm: next })
    toast.show({ message: "Swarm config saved", variant: "success" })
    dialog.replace(() => <DialogSwarm />)
  }

  function pickModel(onPick: (model: Model) => void) {
    dialog.replace(() => (
      <DialogSelect
        title="Select model"
        flat={true}
        options={pipe(
          sync.data.provider,
          sortBy(
            (provider) => provider.id !== "opencode",
            (provider) => provider.name,
          ),
          (providers) =>
            providers.flatMap((provider) =>
              pipe(
                provider.models,
                entries(),
                map(([modelID, info]) => ({
                  value: { providerID: provider.id, modelID },
                  // modelID in the title so the dialog filter matches the
                  // provider/model spelling users know from config files
                  title: modelID,
                  description: info.name && info.name !== modelID ? `${provider.name} · ${info.name}` : provider.name,
                  category: provider.name,
                })),
              ),
            ),
        )}
        onSelect={(option) => onPick(option.value)}
      />
    ))
  }

  function withRole(role: (typeof SIMPLE_ROLES)[number], fn: (list: Model[]) => Model[]) {
    const roles = swarm().roles ?? {}
    return save({ ...swarm(), roles: { ...roles, [role]: fn(roles[role] ?? []) } })
  }

  function withWorker(fn: (pool: PoolEntry[]) => PoolEntry[]) {
    const roles = swarm().roles ?? {}
    return save({ ...swarm(), roles: { ...roles, worker: fn(roles.worker ?? []) } })
  }

  async function pickConcurrency(current: number | undefined, onPick: (concurrency: number) => void) {
    const value = await DialogPrompt.show(dialog, "Max concurrent workers", {
      value: String(current ?? 4),
      placeholder: "4",
    })
    const parsed = Number.parseInt(value ?? "", 10)
    if (!Number.isFinite(parsed) || parsed < 1) return
    onPick(parsed)
  }

  async function pickNumber(title: string, current: number | undefined, onPick: (value: number) => void) {
    const value = await DialogPrompt.show(dialog, title, {
      value: current === undefined ? "" : String(current),
    })
    const parsed = Number.parseInt(value ?? "", 10)
    if (!Number.isFinite(parsed) || parsed < 0) return
    onPick(parsed)
  }

  // the driver is a standalone script so a run survives the TUI exiting.
  // the TUI's own server is in-process (opencode.internal) and unreachable
  // from outside, so the run spins up a dedicated server on a scratch port —
  // it inherits this process's env, so provider config and the dialog-saved
  // project config both apply — and kills it when the driver exits
  const ROOT = path.join(import.meta.dir, "..", "..", "..", "..")
  const DRIVER = path.join(ROOT, "swarm", "driver.ts")

  async function runSwarm() {
    const goal = await DialogPrompt.show(dialog, "Swarm goal", { placeholder: "Build a website for…" })
    if (!goal?.trim() || !sdk.directory) return
    const dir = path.join(os.tmpdir(), "opencode-swarm")
    mkdirSync(dir, { recursive: true })
    const log = path.join(dir, `run-${Date.now()}.log`)
    const port = 20000 + Math.floor(Math.random() * 20000)
    const script = [
      `bun --cwd="$1" run --silent dev serve --port "$2" --hostname 127.0.0.1 > "$3.server.log" 2>&1 &`,
      `srv=$!`,
      `for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$2/global/health" > /dev/null 2>&1 && break; sleep 1; done`,
      `SWARM_SERVER="http://127.0.0.1:$2" bun "$4" "$5" "$6" > "$3" 2>&1`,
      `kill $srv 2>/dev/null`,
    ].join("\n")
    const proc = Bun.spawn(
      ["sh", "-c", script, "sh", path.join(ROOT, "packages", "opencode"), String(port), log, DRIVER, sdk.directory, goal.trim()],
      { env: { ...process.env }, detached: true, stdio: ["ignore", "ignore", "ignore"] },
    )
    proc.unref()
    toast.show({ message: `Swarm launching (takes ~15s to boot) — log: ${log}`, variant: "info" })
  }

  const options = createMemo<DialogSelectOption<unknown>[]>(() => {
    const current = swarm()
    const roles = current.roles ?? {}
    const pool = roles.worker ?? []

    const roleRows = SIMPLE_ROLES.map((role) => ({
      value: { kind: "role", role } as const,
      title: role,
      description: (roles[role] ?? []).map(label).join("  →  ") || "not set",
      category: "Roles (fallback chain)",
    }))

    const poolRows = pool.map((entry, index) => ({
      value: { kind: "pool", index } as const,
      title: `${entry.providerID}/${entry.modelID}`,
      description: `concurrency ${entry.concurrency ?? 4}`,
      category: "Worker pool (round-robin)",
    }))

    return [
      ...roleRows,
      ...poolRows,
      { value: { kind: "pool-add" } as const, title: "Add pool entry", category: "Worker pool (round-robin)" },
      {
        value: { kind: "timeout" } as const,
        title: "Worker timeout",
        description: `${Math.round((current.workerTimeoutMs ?? 480000) / 1000)}s`,
        category: "Tuning",
      },
      {
        value: { kind: "stagger" } as const,
        title: "Launch stagger",
        description: `${current.staggerMs ?? 1500}ms`,
        category: "Tuning",
      },
      {
        value: { kind: "testers" } as const,
        title: "Tester share",
        description: `${current.testerPercent ?? 20}% of sub-agents`,
        category: "Tuning",
      },
      {
        value: { kind: "run" } as const,
        title: "Run swarm…",
        description: "launch a swarm run on this project with a goal",
        category: "Run",
      },
    ]
  })

  function onSelect(option: DialogSelectOption<unknown>) {
    const value = option.value as
      | { kind: "role"; role: (typeof SIMPLE_ROLES)[number] }
      | { kind: "pool"; index: number }
      | { kind: "pool-add" }
      | { kind: "timeout" }
      | { kind: "stagger" }
      | { kind: "testers" }
      | { kind: "run" }

    if (value.kind === "run") {
      runSwarm()
      return
    }
    if (value.kind === "role") {
      pickModel((model) => withRole(value.role, (list) => [model, ...list.slice(1)]))
      return
    }
    if (value.kind === "pool") {
      pickModel((model) => withWorker((pool) => pool.map((e, i) => (i === value.index ? { ...e, ...model } : e))))
      return
    }
    if (value.kind === "pool-add") {
      pickModel((model) =>
        pickConcurrency(4, (concurrency) => withWorker((pool) => [...pool, { ...model, concurrency }])),
      )
      return
    }
    if (value.kind === "timeout") {
      pickNumber("Worker timeout (ms)", swarm().workerTimeoutMs ?? 480000, (workerTimeoutMs) =>
        save({ ...swarm(), workerTimeoutMs }),
      )
      return
    }
    if (value.kind === "stagger") {
      pickNumber("Launch stagger (ms)", swarm().staggerMs ?? 1500, (staggerMs) => save({ ...swarm(), staggerMs }))
      return
    }
    pickNumber("Tester share (%)", swarm().testerPercent ?? 20, (testerPercent) => save({ ...swarm(), testerPercent }))
  }

  const actions = [
    {
      command: "dialog.swarm.role.fallback",
      title: "Add fallback model",
      onTrigger: (option: DialogSelectOption<unknown>) => {
        const value = option.value as { kind: string; role?: (typeof SIMPLE_ROLES)[number] }
        if (value.kind !== "role" || !value.role) return
        pickModel((model) => withRole(value.role!, (list) => [...list, model]))
      },
    },
    {
      command: "dialog.swarm.role.pop",
      title: "Remove last fallback",
      onTrigger: (option: DialogSelectOption<unknown>) => {
        const value = option.value as { kind: string; role?: (typeof SIMPLE_ROLES)[number] }
        if (value.kind !== "role" || !value.role) return
        withRole(value.role, (list) => list.slice(0, -1))
      },
    },
    {
      command: "dialog.swarm.pool.concurrency",
      title: "Set concurrency",
      onTrigger: (option: DialogSelectOption<unknown>) => {
        const value = option.value as { kind: string; index?: number }
        if (value.kind !== "pool" || value.index === undefined) return
        const index = value.index
        const entry = (swarm().roles?.worker ?? [])[index]
        pickConcurrency(entry?.concurrency, (concurrency) =>
          withWorker((pool) => pool.map((e, i) => (i === index ? { ...e, concurrency } : e))),
        )
      },
    },
    {
      command: "dialog.swarm.pool.remove",
      title: "Remove pool entry",
      onTrigger: (option: DialogSelectOption<unknown>) => {
        const value = option.value as { kind: string; index?: number }
        if (value.kind !== "pool" || value.index === undefined) return
        const index = value.index
        withWorker((pool) => pool.filter((_, i) => i !== index))
      },
    },
  ]

  return (
    <DialogSelect
      title="Swarm"
      options={options()}
      actions={actions}
      onSelect={onSelect}
      skipFilter={false}
    />
  )
}
