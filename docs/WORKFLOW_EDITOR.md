# DakFlare Workflow Editor

> Applies to the console at `/admin/workflows/edit`, Svelte 5, `@xyflow/svelte`, flow IR v2.

The editor authors one canonical flow document. The handset runs it offline first; the Worker runs the
same graph when the phone is unreachable or when a step needs the network. The editor never stores a
canvas blob: it stores nodes and edges, and the Worker computes the layout.

## 1. Two surfaces, one document

The editor is not a single canvas.

| Surface | What it is | When it is right |
|---|---|---|
| **Steps** (default) | a branch-aware vertical list of steps, each with its branch label and the next step under it | reading and editing a flow on a phone or a narrow card, and the common linear case |
| **Map** | the SvelteFlow canvas: palette, inspector, minimap, arrange | seeing the branches and the shape of a large graph |

The surface is the operator's habit, not the flow's. It is remembered in
`localStorage` under `dakflare.workflow.surface`; opening a flow keeps the surface you left it in.
Switching to Map restores the viewport you left.

A third surface is a **sheet**, not a mode: the `Source` sheet shows the canonical JSON read-only and
accepts a replacement document with a structural diff before it writes. It exists so an operator or an
agent can move a flow between the console and the CLI without guessing at the wire shape.

## 2. Component map

```
dashboard/src/lib/components/workflow/
├── WorkflowEditor.svelte   the shell: load, save, surfaces, undo, leave guard
├── FlowPalette.svelte      the step catalog
├── FlowBridge.svelte       SvelteFlow hook bridge
├── FlowEdge.svelte         custom edge with branch indicators
├── NodeCard.svelte         shared card wrapper
├── NodeInspector.svelte    the selected step's properties
├── PatternSheet.svelte     pattern workbench for extract and switch
├── SourceSheet.svelte      read-only JSON and apply
├── StepFinder.svelte       Ctrl+K over step titles and ids
├── SimulationPanel.svelte  the in-browser run and trace
├── ValidationList.svelte   structural problems
├── WorkflowSettings.svelte name, scope, enabled
├── VariableHints.svelte    {{variable}} completion
└── [Node].svelte           Trigger, Extract, SetVar, Condition, Switch,
                            Delay, Webhook, SendSms, Stop, Unsupported
```

The graph transformation, simulation and WASM bridge live in `dashboard/src/lib/workflow/`:
`graph.ts`, `simulate.ts`, `wasm-engine.ts`, `context.ts`, `starter-templates.ts`, `sms-encoding.ts`
and `workflow.css`.

## 3. Node taxonomy

Nine operational kinds plus one forward-compatibility card. The Worker's `flow-ir.ts` is the authority;
the editor mirrors its schema.

| Kind | Data | Outgoing |
|---|---|---|
| `trigger` | `{ kind: "incoming", sender?, body? }`, matchers with `any`, `exact`, `prefix`, `keyword` or `regex` | 1 |
| `extract` | `{ source, pattern, flags? }`; at least one named group | 1 |
| `set_var` | `{ name, value }`; the value may interpolate | 1 |
| `condition` | `{ left, op, right? }`; `equals`, `not_equals`, `contains`, `matches` (a regex) or `exists`, which takes no right value | 2 (`true`, `false`) |
| `switch` | `{ value, cases }`; at most 8 cases plus `default` | one per case plus `default` |
| `delay` | `{ seconds }`, 1 to 300 | 1 |
| `webhook` | `{ url, body }`; HTTPS only, SSRF-guarded | 1 |
| `send_sms` | `{ to, body }`; 4,096 characters | 1 |
| `stop` | `{ reason? }` | 0 |
| `unsupported` | preserved as-is | passthrough |

An `extract` pattern must declare a named group, for example `(?<order>[A-Z0-9]{6})`; the group becomes
a variable. Templates use `{{name}}`, and `{{vars.name}}` is the same thing. Built-ins (`{{sender}}`,
`{{body}}`, `{{received_at}}`) are always bound.

`delay` and `webhook` are the two steps the handset cannot finish alone: it runs the graph
synchronously, skips them, and marks the run `partial` so the Worker can take the rest. A delay over
five seconds becomes a `FlowExecutionWorkflow`; a webhook goes through the webhook queue.

## 4. Interactions

- **Ctrl/Cmd+S** saves. The button is disabled until validation passes.
- **Ctrl/Cmd+K** opens the step finder, which searches titles and ids and reveals the step on either
  surface.
- **Ctrl/Cmd+Z** undoes, **Ctrl/Cmd+Shift+Z** and **Ctrl/Cmd+Y** redo. A burst of typing in one field
  is one undo entry, not one per keystroke.
- **Arrange map** recomputes the layout through the Worker's ranker and moves only the steps that
  would change.
- **Add step** appends on Steps and inserts at the pointer or the canvas centre on Map. The palette
  explains what each kind does before it is added.
- **Leave guard**: a dirty flow raises `Leave without saving?` on a link or the browser Back. Back is
  held until the navigation actually lands; a spent guard is re-armed on a one second fallback.
- Edges are not focusable: seven fewer tab stops, and a Delete on an edge no longer removes it.

## 5. Graph model, limits and validation

The stored document is `{ nodes: [{ id, type, data }], edges: [{ id, source, target, sourceHandle? }] }`.
Positions are not part of the contract; a bare graph is enough for `dakflare flows apply`, and the
Worker ranks every node by its longest distance from the trigger.

| Limit | Value |
|---|---|
| Nodes | 200 |
| Edges | 400 |
| Name | 120 characters |
| Switch cases | 8 plus default |
| SMS body | 4,096 characters |
| Delay | 300 seconds |
| Topology | acyclic |

Validation refuses a cycle with the edge and the node it returns to, and refuses a variable that is
not bound on every path. The second check intersects the variables guaranteed by every incoming edge,
so `{{amount}}` on a branch that never extracts it is a save-time error, not an empty string at 3am.

## 6. Simulation

`SimulationPanel` runs the graph in the browser against a sample sender and body, highlights the path
that was taken, dims the branches that were not, and lists the extracted variables and the reply. It
also runs the compiled `flow.wasm`, so what it prints is what the Worker's engine will do. The panel
reports `replied`, `filtered`, `halted` or `error`, and names the step that stopped it.

## 7. Storage and API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/admin/workflows` | ids and metadata, newest save first, no graphs |
| `GET` | `/v1/admin/workflows/:id` | the full document |
| `PUT` | `/v1/admin/workflows/:id` | validate, rank and save; returns the layout |
| `DELETE` | `/v1/admin/workflows/:id` | delete and cascade cleanup |
| `GET` | `/v1/flows` | the handset's flow cache |

A flow is fleet-wide (`device_id: null`) or scoped to one handset. The CLI speaks the same document:
`dakflare flows apply <file> --dry-run` prints the structural diff before the write.

## 8. Rules and workflows

| | Rules | Workflows |
|---|---|---|
| Authoring | one sentence-shaped form | Steps or Map |
| Logic | one matcher, one reply | a DAG of extract, branch, delay, webhook, send, stop |
| Runs | Worker, during the inbound request | handset first, Worker fallback |
| Offline | no | yes |
| Limits | cooldown and hourly cap | graph limits above; authority via grants for agents |
| Order | rules first | flows only if no rule replied |
