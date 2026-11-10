# DakFlare Workflow Editor & SvelteFlow Logic Canvas

> **Document Status**: Production Specification & Technical Architecture  
> **Applies to**: DakFlare Console v6.1.0+, Svelte 5, `@xyflow/svelte` v0.1+, DakFlare Flow IR v2  
> **Target Path**: `dashboard/src/lib/components/workflow/` & `dashboard/src/lib/workflow/`

---

## 1. Overview & Architecture

The DakFlare Workflow Editor provides a visual, node-based Directed Acyclic Graph (DAG) canvas for creating and managing automated SMS interaction pipelines. It allows operators to design conditional logic, data extraction, external integrations, and telephony replies without writing raw JSON or code.

```
       Console (Authoring)                      Edge Coordinator                        Handset Radio
 ┌─────────────────────────────┐        ┌───────────────────────────────┐       ┌───────────────────────────────┐
 │   SvelteKit + SvelteFlow    │        │      Cloudflare Workers       │       │    Android Native (Rust Core) │
 │  (/admin/workflows/:id)     │        │          (flow.wasm)          │       │     (libsimulator_lib.so)     │
 └──────────────┬──────────────┘        └───────────────▲───────────────┘       └───────────────▲───────────────┘
                │                                       │                                       │
         Save Workflow                           Partial Offload                        Sync Flow Cache
         (Flow IR v2)                        (Webhooks & DO Delays)                     (Zero-Network Exec)
                │                                       │                                       │
                ▼                                       │                                       │
     ┌──────────────────────┐                           │                                       │
     │     D1 Database      │───────────────────────────┴───────────────────────────────────────┘
     │     (workflows)      │
     └──────────────────────┘
```

### Core Design Principles

1. **Split-Horizon Execution**: Workflows authored on the canvas are saved to Cloudflare D1 and synced to enrolled Android handsets. When an inbound SMS arrives, the handset evaluates the flow **instantly and offline** via native Rust code (`simulator/flow`) compiled into `libsimulator_lib.so`. If a flow contains actions requiring internet services (e.g. `webhook` or long `delay`), the phone marks the run as `partial` and offloads the remaining actions to Cloudflare Workers (`flow.wasm` / `dispatch.ts`).
2. **Reactivity with Svelte 5 Runes**: The editor canvas, node inspector, and validation pipelines are written entirely using Svelte 5 runes (`$state`, `$derived`, `$props`, `$effect`), eliminating legacy store subscriptions and synchronization race conditions.
3. **Lossless Schema Forward-Compatibility**: If an older console opens a workflow created by a newer release with unfamiliar node kinds, it renders an `unsupported` card that preserves the original configuration intact across load and save cycles.
4. **Client-Side Simulation**: Operators can test workflows before deploying them. An embedded synchronous interpreter (`simulate.ts`) walks the graph, evaluates regex extractions and conditions, outputs a trace log, and **visually animates the active path** on the canvas.

---

## 2. Source Code & Component Layout

The editor subsystem is split cleanly between UI components and the graph transformation engine:

```
dashboard/src/
├── lib/
│   ├── components/
│   │   └── workflow/
│   │       ├── WorkflowEditor.svelte    # Top-level orchestrator & SvelteFlow shell
│   │       ├── FlowBridge.svelte        # SvelteFlow hook bridge to canvas context
│   │       ├── FlowPalette.svelte       # Draggable/clickable step catalog drawer
│   │       ├── FlowEdge.svelte          # Custom smoothstep edge with branch indicators
│   │       ├── NodeInspector.svelte     # Contextual property editor for selected node
│   │       ├── NodeCard.svelte          # Shared visual card wrapper for all nodes
│   │       ├── SimulationPanel.svelte   # In-browser test runner & trace viewer
│   │       ├── ValidationList.svelte    # Structural error drawer
│   │       ├── WorkflowSettings.svelte  # Metadata modal (scope, name, active toggle)
│   │       ├── VariableHints.svelte     # Autocomplete pill helper for {{variables}}
│   │       └── [Node Components]       # Individual cards (Trigger, Extract, Condition, etc.)
│   └── workflow/
│       ├── graph.ts                     # Graph translation, DAG validation, layout helpers
│       ├── simulate.ts                  # Synchronous in-browser graph simulator
│       ├── context.ts                   # Svelte Context key and interface contracts
│       └── workflow.css                 # SvelteFlow dark/light theme tokens and layout
```

---

## 3. Node Taxonomy & Data Specifications

The editor supports 9 operational node types and 1 forward-compatibility node. Every node adheres to the schemas enforced by `graph.ts` and `worker/src/lib/flow-ir.ts`:

### 3.1. `trigger` (TriggerNode.svelte)
- **Role**: Entry point for every workflow. Exactly one trigger node must exist per graph.
- **Visuals**: Primary accent header, icon `zap`, single source handle (bottom).
- **Configuration (`TriggerData`)**:
  - `kind`: Fixed to `"incoming"`.
  - `sender`: Matcher specification with `mode` (`"any" | "exact" | "prefix" | "regex"`) and optional `pattern`.
  - `body`: Matcher specification with `mode` (`"any" | "exact" | "prefix" | "keyword" | "regex"`) and optional `pattern`.

### 3.2. `extract` (ExtractNode.svelte)
- **Role**: Evaluates regular expressions with named capture groups against message content or variables.
- **Visuals**: Purple header, icon `braces`, target handle (top), source handle (bottom).
- **Configuration (`ExtractData`)**:
  - `source`: Variable name to scan (defaults to `"body"`).
  - `pattern`: Valid regex containing named capture groups, e.g. `(?<order_id>[A-Z0-9]+)\s+(?<amount>\d+)`.
  - `flags`: Regex flags (e.g. `"i"` for case insensitivity).
- **Output**: Populates named groups as variables (`{{order_id}}`, `{{amount}}`) for downstream nodes.

### 3.3. `set_var` (SetVarNode.svelte)
- **Role**: Assigns static strings or templated variables into the execution state.
- **Visuals**: Teal header, icon `key`, target handle (top), source handle (bottom).
- **Configuration (`SetVarData`)**:
  - `name`: Alphanumeric variable name (matching `^[A-Za-z_][A-Za-z0-9_]{0,31}$`).
  - `value`: Expression string supporting template interpolation, e.g. `REF-{{order_id}}`.

### 3.4. `condition` (ConditionNode.svelte)
- **Role**: Binary conditional branch (`if / else`).
- **Visuals**: Amber header, icon `branch`, target handle (top), two source handles (bottom):
  - `true` handle (green label).
  - `false` handle (muted label).
- **Configuration (`ConditionData`)**:
  - `left`: Left-hand operand string (supports `{{vars}}`).
  - `op`: Comparison operator:
    - `"equals"`: String equality.
    - `"not_equals"`: String inequality.
    - `"contains"`: Substring search.
    - `"starts_with"`: Prefix match.
    - `"matches_regex"`: Regular expression evaluation against `right`.
    - `"gt"`: Numerical greater than.
    - `"lt"`: Numerical less than.
  - `right`: Right-hand operand string or pattern.

### 3.5. `switch` (SwitchNode.svelte)
- **Role**: Multi-branch pattern matching (up to 8 custom cases plus a default branch).
- **Visuals**: Indigo header, icon `workflow`, target handle (top), multiple source handles:
  - Positional handles `case_0`, `case_1`, … for each configured case.
  - Fallback handle `default`.
- **Configuration (`SwitchData`)**:
  - `value`: Expression being tested (defaults to `"{{body}}"`).
  - `cases`: Array of up to 8 match patterns.

### 3.6. `delay` (DelayNode.svelte)
- **Role**: Pauses execution before executing downstream actions.
- **Visuals**: Orange header, icon `clock`, target handle (top), source handle (bottom).
- **Configuration (`DelayData`)**:
  - `seconds`: Integer between 1 and 300 seconds.
- **Execution Note**: Handsets offload delays $> 0$s to Cloudflare Worker Durable Objects via scheduled alarms.

### 3.7. `webhook` (WebhookNode.svelte)
- **Role**: Issues an HTTP `POST` request to an external service.
- **Visuals**: Blue header, icon `external`, target handle (top), source handle (bottom).
- **Configuration (`WebhookData`)**:
  - `url`: Must be a valid HTTPS URL (blocked by SSRF guard against RFC 1918 / Cloudflare metadata IPs).
  - `body`: Optional JSON string payload supporting variable interpolation.
- **Execution Note**: Webhook actions are filtered out on handsets and dispatched by the Worker edge.

### 3.8. `send_sms` (SendSmsNode.svelte)
- **Role**: Transmits an outbound SMS message via the handset's telephony radio.
- **Visuals**: Green header, icon `send`, target handle (top), source handle (bottom).
- **Configuration (`SendSmsData`)**:
  - `to`: E.164 phone number or template variable (defaults to `"{{sender}}"`).
  - `body`: Message text up to 4096 characters supporting `{{variable}}` substitution.

### 3.9. `stop` (StopNode.svelte)
- **Role**: Explicitly terminates a branch.
- **Visuals**: Slate header, icon `stop`, target handle (top), no source handles.
- **Configuration (`StopData`)**:
  - `reason`: Optional audit text string recorded in execution history.

### 3.10. `unsupported` (UnsupportedNode.svelte)
- **Role**: Safeguards unrecognized node schemas from breaking or being wiped when saved by older console builds.
- **Visuals**: Yellow caution header, icon `alert`.

---

## 4. Canvas Controls & User Interactions

The canvas integrates `@xyflow/svelte` with custom navigation and editing ergonomics:

- **Viewport Controls**:
  - **Zooming**: Min zoom `0.3x`, max zoom `1.8x`, mouse wheel or touch pinch.
  - **Panning**: Click-drag on empty canvas or middle-mouse drag.
  - **Grid Alignment**: Discrete snap grid at `16px × 16px` with dot pattern background (`BackgroundVariant.Dots`).
  - **Minimap**: Bottom-right floating radar minimap (`160px × 110px`) with pannable/zoomable viewport rectangle.
- **Node Selection & Editing**:
  - Clicking a node selects it and opens its properties in `NodeInspector.svelte`.
  - Pressing `Delete` or `Backspace` removes the currently selected node and all connected edges.
  - Contextual actions on cards support **Duplicate** (`Ctrl+D` / action button) and **Delete**.
- **Edge Drawing & Validation**:
  - Dragging from any output handle draws a bezier curve.
  - The connection is validated in real time via `isValidConnection`:
    - Prevents self-connections (`source === target`).
    - Enforces handle constraints (e.g., condition handles can only connect to one downstream node per branch).
    - Prevents duplicate edges between the same two handles.
- **Focus & Keyboard Navigation**:
  - Fully compliant with WCAG 2.2 accessibility: node focus indicators use high-contrast dual rings (`outline: 2px solid var(--df-accent-text)`).

---

## 5. Graph Model, Limits & Validation

### 5.1. Translation Pipeline (`toGraph` / `fromGraph`)

SvelteFlow's in-memory node state contains transient UI properties (`selected`, `measured`, `width`, `height`, `dragging`). The translation layer in `graph.ts` ensures that only clean, normalized specifications are stored or sent to the Worker API:

```typescript
// SvelteFlow UI Node (Internal Editor State)
type FlowNode = Node<Record<string, unknown>, CanvasNodeType> & {
  unsupportedType?: string;
};

// Contract Stored in Cloudflare D1
interface WorkflowGraph {
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
  }>;
}
```

### 5.2. Enforced Limits

To prevent infinite loops, buffer exhaustion, or edge memory spikes, the editor and edge enforce identical caps:

| Parameter | Limit | Enforced At |
|---|---|---|
| **Max Nodes** | 200 nodes | Client & Worker API |
| **Max Edges** | 400 edges | Client & Worker API |
| **Max Workflow Name** | 120 characters | Client & Worker API |
| **Max Switch Cases** | 8 cases + 1 default | Client & Worker API |
| **Max SMS Body** | 4,096 characters | Client & Worker API |
| **Max Delay Duration** | 300 seconds | Client & Worker API |
| **Graph Topology** | Strict DAG (Cycles Prohibited) | Client & Worker API |

### 5.3. Structural Validation Rules (`validateWorkflow`)

The **Save** button remains disabled until all checks pass:
1. **DAG Cycle Trapping**: Depth-First Search (DFS) traversal verifies no cycles exist in the graph.
2. **Root Trigger Requirement**: The graph must have exactly one `trigger` node.
3. **No Orphan Actions**: Every node (except `trigger`) must have at least one incoming connection from an ancestor path originating at `trigger`.
4. **Variable Scope Resolution**: Any variable referenced via `{{variable_name}}` in `send_sms`, `webhook`, `condition`, or `set_var` must be defined upstream by an `extract` group or `set_var` node on the same execution path. Built-in variables (`{{sender}}`, `{{body}}`, `{{received_at}}`) are always available.

---

## 6. Embedded Simulation Engine (`simulate.ts`)

DakFlare includes an interactive test interpreter embedded inside the console:

```
[ Input Message ] ──> [ Interpreter Walk ] ──> [ Active Path Highlighting ]
  • +15551234567         • Regex Evaluation       • Canvas Nodes Glow Green
  • "ORDER A-1042"       • Branch Traversal       • Canvas Edges Animate
                         • Output Collection      • SMS Reply Trace Log
```

1. **Step-by-Step Traversal**: The simulator accepts a test phone number and message body, starts at the `trigger` node, checks pattern conditions, extracts regex groups, resolves template variables, and navigates downstream edges.
2. **Visual Path Animation**:
   - Visited node IDs are collected into `visitedNodes` (`simNodeIds`).
   - Visited edge IDs are collected into `visitedEdges` (`simEdgeIds`).
   - SvelteFlow cards on the active execution path render with bright accent borders and pulsing badges. Untaken branches are dimmed to 40% opacity.
3. **Trace Diagnostics**:
   - Summarizes execution status: `delivered` (replied), `filtered` (stopped by trigger), `halted` (stopped by stop node), or `error` (unresolved branch).
   - Displays all extracted variables and provides warnings if unassigned template parameters were encountered.

---

## 7. Storage, Synchronization & API Contract

Workflows are managed via authenticated REST endpoints on the Cloudflare Worker coordinator:

- `GET /v1/admin/workflows`: Lists all stored workflows with metadata and node counts.
- `GET /v1/admin/workflows/:id`: Fetches the complete graph document for rendering in the editor.
- `PUT /v1/admin/workflows/:id`: Validates and saves the workflow graph.
- `DELETE /v1/admin/workflows/:id`: Deletes the workflow and cascades cleanup.
- `GET /v1/device/flows`: Handset endpoint to synchronize the active flow cache.

Workflows can be scoped fleet-wide (`device_id: null`) or restricted to a specific handset hardware ID (`device_id: "devecb9748c95b5395a"`).

---

## 8. Summary Comparison: Rules vs. Workflows

| Capability | Rules (`/admin/rules`) | Workflows (`/admin/workflows`) |
|---|---|---|
| **Authoring Mode** | Simple form | Visual SvelteFlow canvas |
| **Logic Structure** | Single condition $\rightarrow$ Single reply | Multi-step DAG (extract, branch, delay, webhook) |
| **Execution Tier** | Edge Coordinator (Cloudflare Workers) | Device Primary (Android Rust) + Edge Fallback |
| **Offline Operation** | Requires active edge connection | **Fully offline capable on device** |
| **Rate Limiting** | Built-in hourly & cooldown caps | Managed via control flows or agent grants |
| **Execution Order** | Evaluated first on inbound sync | Evaluated if no rule matched |
