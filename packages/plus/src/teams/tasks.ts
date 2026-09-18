import { join } from "node:path"
import { toolError } from "./schema.js"
import type { Check, Deliverable, TaskState } from "./schema.js"
import { atomicJson, lock, readJson } from "./store.js"

export interface TaskHistoryEntry {
  at: string
  from: TaskState
  to: TaskState
  by: string
}

export interface TaskRecord {
  title: string
  state: TaskState
  dependsOn: string[]
  role: string
  effort: "small" | "medium" | "large"
  deliverable: Deliverable
  paths: string[]
  checks: Check[]
  run?: string
  attempts: number
  mergeEntry?: string
  history: TaskHistoryEntry[]
}

export interface TaskGraph {
  plan: string
  planPath?: string
  createdAt: string
  tasks: Record<string, TaskRecord>
}

export interface TaskInput {
  id: string
  title: string
  dependsOn: string[]
  role: string
  effort: "small" | "medium" | "large"
  deliverable: Deliverable
  paths: string[]
  checks: Check[]
}

export interface AdhocInput {
  title: string
  role: string
  effort: "small" | "medium" | "large"
  paths: string[]
  checks: Check[]
  deliverable?: Deliverable
}

export type TaskWithId = TaskRecord & { id: string }

function taskFile(root: string, planRun: string): string {
  return join(root, "tasks", `${planRun}.json`)
}

function lockKey(planRun: string): string {
  return `tasks:${planRun}`
}

function now(): string {
  return new Date().toISOString()
}

// Linear order for the main chain (02 §3). `blocked` is entry-only,
// `rework` is a side state, `cancelled` is terminal-from-anywhere.
const TASK_ORDER: Record<string, number> = {
  blocked: 0,
  open: 1,
  claimed: 2,
  working: 3,
  reported: 4,
  queued_merge: 5,
  merged: 6,
  done: 7,
}

const LINEAR: TaskState[] = ["open", "claimed", "working", "reported", "queued_merge", "merged", "done"]

export function isTaskTerminal(state: TaskState): boolean {
  return state === "done" || state === "cancelled"
}

export function legalTargets(from: TaskState): TaskState[] {
  if (isTaskTerminal(from)) return []
  if (from === "blocked") return ["open", "cancelled"]
  if (from === "rework") return ["queued_merge", "open", "done", "cancelled"]
  // Linear states: every later linear state + rework + cancelled,
  // plus claimed → open (release the claim).
  const out: TaskState[] = []
  const fromOrder = TASK_ORDER[from] ?? -1
  for (const s of LINEAR) {
    if ((TASK_ORDER[s] ?? -1) > fromOrder) out.push(s)
  }
  out.push("rework", "cancelled")
  if (from === "claimed") out.push("open")
  return [...new Set(out)]
}

export function canTaskTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return false
  if (isTaskTerminal(from)) return false
  if (to === "blocked") return false
  if (to === "cancelled") return true
  if (from === "blocked") return to === "open"
  if (from === "rework") return to === "queued_merge" || to === "open" || to === "done"
  if (to === "rework")
    return from === "open" || from === "claimed" || from === "working" || from === "reported" || from === "queued_merge" || from === "merged"
  // Claimed → open is the explicit release edge (backward by order).
  if (from === "claimed" && to === "open") return true
  const fo = TASK_ORDER[from]
  const toOrder = TASK_ORDER[to]
  if (fo === undefined || toOrder === undefined) return false
  return toOrder > fo
}

function findCycle(ids: string[], edges: Map<string, string[]>): string[] | undefined {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]))
  const stack: string[] = []

  const visit = (node: string): string[] | undefined => {
    color.set(node, GRAY)
    stack.push(node)
    for (const dep of edges.get(node) ?? []) {
      const c = color.get(dep)
      if (c === GRAY) {
        const start = stack.indexOf(dep)
        return [...stack.slice(start), dep]
      }
      if (c === WHITE) {
        const found = visit(dep)
        if (found) return found
      }
    }
    stack.pop()
    color.set(node, BLACK)
    return undefined
  }

  for (const id of ids) {
    if (color.get(id) === WHITE) {
      const found = visit(id)
      if (found) return found
    }
  }
  return undefined
}

export async function create(root: string, planRun: string, tasks: TaskInput[], opts?: { planPath?: string }): Promise<TaskGraph> {
  return lock(root, "state", lockKey(planRun), async () => {
    const ids = tasks.map((t) => t.id)
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) throw toolError("E_DEPS", `Duplicate task ${id} in plan ${planRun}.`, ids)
      seen.add(id)
    }
    const idSet = new Set(ids)
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        if (!idSet.has(dep)) throw toolError("E_DEPS", `${t.id} depends on ${dep} (unknown).`, ids)
        if (dep === t.id) throw toolError("E_DEPS", `cycle ${t.id}→${t.id}`, ids)
      }
    }
    const edges = new Map<string, string[]>(tasks.map((t) => [t.id, [...t.dependsOn]]))
    const cycle = findCycle(ids, edges)
    if (cycle) throw toolError("E_DEPS", `cycle ${cycle.join("→")}`, ids)
    const records: Record<string, TaskRecord> = {}
    for (const t of tasks) {
      records[t.id] = {
        title: t.title,
        state: t.dependsOn.length === 0 ? "open" : "blocked",
        dependsOn: [...t.dependsOn],
        role: t.role,
        effort: t.effort,
        deliverable: t.deliverable,
        paths: [...t.paths],
        checks: [...t.checks],
        attempts: 0,
        history: [],
      }
    }
    const graph: TaskGraph = {
      plan: planRun,
      ...(opts?.planPath !== undefined ? { planPath: opts.planPath } : {}),
      createdAt: now(),
      tasks: records,
    }
    await atomicJson(taskFile(root, planRun), graph)
    return graph
  })
}

function readGraph(root: string, planRun: string): Promise<TaskGraph | undefined> {
  return readJson<TaskGraph>(taskFile(root, planRun))
}

function missingGraph(planRun: string): never {
  throw toolError("E_TASK_TRANSITION", `Task graph ${planRun} not found.`, [])
}

export async function load(root: string, planRun: string): Promise<TaskGraph> {
  const graph = await readGraph(root, planRun)
  if (!graph) missingGraph(planRun)
  return graph as TaskGraph
}

const ADHOC = "adhoc"

export async function adhoc(root: string): Promise<TaskGraph> {
  return lock(root, "state", lockKey(ADHOC), async () => {
    const existing = await readGraph(root, ADHOC)
    if (existing) return existing
    const graph: TaskGraph = { plan: ADHOC, createdAt: now(), tasks: {} }
    await atomicJson(taskFile(root, ADHOC), graph)
    return graph
  })
}

function nextPlainId(tasks: Record<string, TaskRecord>): string {
  let max = 0
  for (const key of Object.keys(tasks)) {
    const m = /^T([0-9]+)$/.exec(key)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `T${max + 1}`
}

export async function addAdhoc(root: string, input: AdhocInput): Promise<string> {
  return lock(root, "state", lockKey(ADHOC), async () => {
    const existing = await readGraph(root, ADHOC)
    const graph: TaskGraph = existing ?? { plan: ADHOC, createdAt: now(), tasks: {} }
    const id = nextPlainId(graph.tasks)
    graph.tasks[id] = {
      title: input.title,
      state: "open",
      dependsOn: [],
      role: input.role,
      effort: input.effort,
      deliverable: input.deliverable ?? { kind: "commit" },
      paths: [...input.paths],
      checks: [...input.checks],
      attempts: 0,
      history: [],
    }
    await atomicJson(taskFile(root, ADHOC), graph)
    return id
  })
}

export async function claim(root: string, planRun: string, taskID: string, runID: string): Promise<TaskRecord> {
  return lock(root, "state", lockKey(planRun), async () => {
    const graph = await readGraph(root, planRun)
    if (!graph) missingGraph(planRun)
    const g = graph as TaskGraph
    const task = g.tasks[taskID]
    if (!task) throw toolError("E_TASK_TRANSITION", `Task ${taskID} not found in plan ${planRun}.`, Object.keys(g.tasks))
    if (task.state === "blocked") {
      const unmet = task.dependsOn.filter((d) => g.tasks[d]?.state !== "done")
      throw toolError("E_TASK_BLOCKED", `Task ${taskID} is blocked by ${unmet.join(",")} (not done).`, unmet)
    }
    if (task.state !== "open") {
      const holder = task.run ?? task.state
      throw toolError("E_TASK_CLAIMED", `Task ${taskID} is claimed by run ${holder}; supersede it or pick another task.`, holder)
    }
    const at = now()
    const next: TaskRecord = {
      ...task,
      state: "claimed",
      run: runID,
      history: [...task.history, { at, from: task.state, to: "claimed" as TaskState, by: runID }],
    }
    g.tasks[taskID] = next
    await atomicJson(taskFile(root, planRun), g)
    return next
  })
}

export async function setState(
  root: string,
  planRun: string,
  taskID: string,
  state: TaskState,
  by: string,
): Promise<TaskRecord> {
  return lock(root, "state", lockKey(planRun), async () => {
    const graph = await readGraph(root, planRun)
    if (!graph) missingGraph(planRun)
    const g = graph as TaskGraph
    const task = g.tasks[taskID]
    if (!task) throw toolError("E_TASK_TRANSITION", `Task ${taskID} not found in plan ${planRun}.`, Object.keys(g.tasks))
    if (!canTaskTransition(task.state, state)) {
      const legal = legalTargets(task.state)
      throw toolError(
        "E_TASK_TRANSITION",
        `Task ${taskID} cannot go ${task.state} → ${state} (by ${by}). Legal targets from ${task.state}: [${legal.join(", ")}].`,
        legal,
      )
    }
    const at = now()
    const next: TaskRecord = {
      ...task,
      state,
      history: [...task.history, { at, from: task.state, to: state, by }],
    }
    g.tasks[taskID] = next
    await atomicJson(taskFile(root, planRun), g)
    return next
  })
}

export async function unblock(root: string, planRun: string): Promise<string[]> {
  return lock(root, "state", lockKey(planRun), async () => {
    const graph = await readGraph(root, planRun)
    if (!graph) missingGraph(planRun)
    const g = graph as TaskGraph
    const opened: string[] = []
    const at = now()
    for (const [id, task] of Object.entries(g.tasks)) {
      if (task.state !== "blocked") continue
      const ready = task.dependsOn.every((d) => g.tasks[d]?.state === "done")
      if (ready) {
        g.tasks[id] = {
          ...task,
          state: "open",
          history: [...task.history, { at, from: task.state, to: "open" as TaskState, by: "unblock" }],
        }
        opened.push(id)
      }
    }
    if (opened.length > 0) await atomicJson(taskFile(root, planRun), g)
    return opened
  })
}

function reworkSiblings(tasks: Record<string, TaskRecord>, base: string): number[] {
  const out: number[] = []
  const prefix = `${base}.rework.`
  for (const key of Object.keys(tasks)) {
    if (key.startsWith(prefix)) {
      const n = Number(key.slice(prefix.length))
      if (Number.isInteger(n) && n > 0) out.push(n)
    }
  }
  return out
}

export async function reworkTask(
  root: string,
  planRun: string,
  parentTaskID: string,
  files: string[],
  checks: Check[],
): Promise<string> {
  return lock(root, "state", lockKey(planRun), async () => {
    const graph = await readGraph(root, planRun)
    if (!graph) missingGraph(planRun)
    const g = graph as TaskGraph
    const parent = g.tasks[parentTaskID]
    if (!parent)
      throw toolError("E_TASK_TRANSITION", `Task ${parentTaskID} not found in plan ${planRun}.`, Object.keys(g.tasks))
    if (isTaskTerminal(parent.state) || parent.state === "blocked") {
      const legal = legalTargets(parent.state)
      throw toolError(
        "E_TASK_TRANSITION",
        `Task ${parentTaskID} cannot go ${parent.state} → rework (by merge). Legal targets from ${parent.state}: [${legal.join(", ")}].`,
        legal,
      )
    }
    if (!canTaskTransition(parent.state, "rework")) {
      const legal = legalTargets(parent.state)
      throw toolError(
        "E_TASK_TRANSITION",
        `Task ${parentTaskID} cannot go ${parent.state} → rework (by merge). Legal targets from ${parent.state}: [${legal.join(", ")}].`,
        legal,
      )
    }
    const base = parentTaskID.includes(".rework.") ? (parentTaskID.split(".rework.")[0] as string) : parentTaskID
    const existing = reworkSiblings(g.tasks, base)
    const next = existing.length === 0 ? 1 : Math.max(...existing) + 1
    if (next > 8) throw toolError("E_REWORK_LIMIT", `Task ${base} already has 8 rework tasks; refusing ${base}.rework.${next}.`, 8)
    const id = `${base}.rework.${next}`
    const at = now()
    g.tasks[id] = {
      title: `${parent.title} (rework ${next})`,
      state: "open",
      dependsOn: [],
      role: parent.role,
      effort: parent.effort,
      deliverable: parent.deliverable,
      paths: [...files],
      checks: [...checks],
      attempts: 0,
      history: [],
    }
    g.tasks[parentTaskID] = {
      ...parent,
      state: "rework",
      history: [...parent.history, { at, from: parent.state, to: "rework" as TaskState, by: "merge" }],
    }
    await atomicJson(taskFile(root, planRun), g)
    return id
  })
}

export async function open(root: string, planRun: string): Promise<TaskWithId[]> {
  return byState(root, planRun, "open")
}

export async function byState(root: string, planRun: string, state: TaskState): Promise<TaskWithId[]> {
  const graph = await readGraph(root, planRun)
  if (!graph) missingGraph(planRun)
  const g = graph as TaskGraph
  return Object.entries(g.tasks)
    .filter(([, t]) => t.state === state)
    .map(([id, t]) => ({ ...t, id }))
}
