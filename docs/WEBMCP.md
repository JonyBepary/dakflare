# WebMCP in the workflow editor

The workflow editor at `/admin/workflows/edit` declares what an agent may do there
instead of leaving it to guess from the DOM. The declaration lives in
`dashboard/src/lib/components/workflow/webmcp.ts`, with one helper module for the
declarative form attributes, and it is registered for exactly as long as the editor
is mounted.

WebMCP is a W3C proposal that Chrome ships behind a flag/origin trial. It is a
progressive enhancement: a browser without the API gets a no-op, and the editor
behaves identically.

## The four imperative tools

Registered on mount by `registerWorkflowTools` (`webmcp.ts:274`) and removed on
destroy. Every tool returns MCP-style content:

```json
{ "content": [{ "type": "text", "text": "<json or a sentence>" }] }
```

and sets `isError: true` when it refuses. Successful structured answers are JSON
text inside that envelope.

| Tool | Read/write | Inputs | Successful output |
|---|---|---|---|
| `dakflare_get_flow_ast` | read-only | none | `{ flow_id, name, enabled, dirty, staged_patch, graph: { nodes, edges } }` — the live editor state, not a copy |
| `dakflare_stage_flow_patch` | **consequential** (stages a preview) | `intent` (string), `patch` (`{ nodes: [...], edges: [...] }`) | `{ ok, message, added, modified }` |
| `dakflare_synthesize_pattern` | local computation, nothing saved | `sample` (string), optional `spans` (`{ start, end, role, name, slot_type }[]`) | `{ pattern, variables, trigger_phrases }` |
| `dakflare_diagnose_message` | read-only (one `POST /v1/agent/diagnose`) | `message` (string), optional `pattern` (string) | `{ code, summary, encoding, segments }` |

Notes that matter to an agent or a reviewer:

- `get_flow_ast` reads through a closure over the editor's state, so it always
  describes the flow currently on screen, including a staged patch summary.
- `stage_flow_patch` replaces any patch already staged. It validates the shape
  (`nodes` and `edges` arrays), converts it through the same `fromGraph` path the
  worker's contract uses, and returns `isError` with a reason when the patch does
  not fit the flow (`stageExternalPatch` in `WorkflowEditor.svelte`).
- `synthesize_pattern` runs the same WASM synthesis as the pattern sheet, in the
  page. It refuses an empty sample and reports a failure reason if synthesis
  fails.
- `diagnose_message` calls the gateway's agent route, with a 15 s timeout. When
  the route is absent (`not-deployed`), the provider is down, the browser is
  offline or the answer is unreadable, it refuses with the operator-facing
  sentence from `unavailableCopy`; nothing is changed.
- No tool saves a flow, and no tool applies a patch.

### How the consequential one is marked

`dakflare_stage_flow_patch` declares:

```ts
annotations: {
  readOnlyHint: false,
  consequentialHint: true, // WebMCP's hint; Chrome surfaces this
  destructiveHint: true,   // MCP's name, kept for MCP-shaped clients
  idempotentHint: false
}
```

`consequentialHint` is the field Chrome 156 reports from `getTools()`.
`destructiveHint` alone is not surfaced by Chrome, which is why the tool previously
looked non-consequential to a browser even though its description said otherwise.
The other three tools keep `destructiveHint: false`; the read-only ones set
`readOnlyHint: true`.

### Approval for `stage_flow_patch`

Staging is not applying. The patch lands in the editor's existing ghost banner:

- map and outline show a **Preview**;
- the banner reads **STAGED PATCH · NOT APPLIED** and names the intent;
- because no model judged an externally staged patch, the banner says so
  (`judged: false`);
- **Accept** (Enter) applies it to the editor state; **Revert** (Escape) removes
  it; nothing reaches the worker/D1 until the operator saves the flow;
- graph validation runs first: when the patch would leave a step disconnected,
  the banner lists the block and Accept stays disabled. An agent cannot bypass
  this by calling the tool again; a second call replaces the staged patch and is
  validated the same way.

There is no auto-submit anywhere in this path.

## Declarative tools (forms)

Two forms in the editor are also tools, via `webmcp-attributes.ts`. Svelte cannot
type unknown HTML attributes, so the maps keep the names in one place:

| Attribute | Helper | Meaning |
|---|---|---|
| `toolname` | `toolForm(name, description)` | the tool's name |
| `tooldescription` | `toolForm(...)` | what it changes, in operator terms |
| `toolparamtitle` | `toolParam(title, description)` | a control's parameter label |
| `toolparamdescription` | `toolParam(...)` | what the parameter means |

The two forms are `dakflare_ask_agent` (`StepFinder.svelte`, the intent field) and
`dakflare_autotag_spans` (`PatternSheet.svelte`, the read-only sample-message
mirror). Both mutate what a person is working on, so neither carries
`toolautosubmit`: submission stays a click. The harness enforces that, and also
checks the helper never emits the attribute at all.

## How a browser discovers the tools

Imperative API, as used by `webmcp.ts`:

1. Look at `document.modelContext`, then fall back to `navigator.modelContext` (the
   earlier preview's home). A context without a `registerTool` function is treated
   as absent (`webmcp.ts:72`).
2. `registerTool(tool, { signal })` for each of the four tools, sharing one
   `AbortController` per editor mount. Chrome unregisters on abort.
3. On teardown, abort the controller, and call `unregisterTool(name)` for every
   registered name when the build provides it (older shapes). Cleanup is
   idempotent (`webmcp.ts:274`).
4. `getTools()` lists what is registered; `executeTool(registeredTool, input)`
   invokes one. In Chrome 156 both return promises, and `executeTool` resolves to
   the JSON-string envelope shown above.

Declarative API: the browser reads the `tool*` attributes from the two forms. The
`readonly` input is still a parameter; its description tells the agent to change
the message in the sheet instead.

Both paths are scoped to the editor: navigating away aborts the signal, so the
tools never describe a flow that is no longer open.

## Manual test recipe (Chrome with the API)

Chrome 156 has the API disabled by default. Launch with the feature on (or enable
WebMCP in `chrome://flags`):

```bash
chromium --enable-features=WebMCP --remote-debugging-port=9222
```

Then:

1. Start the console: `cd dashboard && npm run dev -- --port 5199`.
2. Open `http://localhost:5199/admin/workflows/edit`. A signed-in session is
   required; without the worker running the layout stops at "Cannot reach the
   gateway" and the editor — and therefore the tools — never mounts. For a local
   dry run, a stub `GET /admin/session` returning `{ "expires_at": <future> }` is
   enough for a draft (`?id=` absent).
3. In DevTools, confirm discovery:

   ```js
   document.modelContext;                       // object, not undefined
   await document.modelContext.getTools();      // 4 RegisteredTools
   ```

4. Read the graph:

   ```js
   const mc = document.modelContext;
   const tools = await mc.getTools();
   const ast = tools.find((t) => t.name === 'dakflare_get_flow_ast');
   const raw = await mc.executeTool(ast, {});
   JSON.parse(JSON.parse(raw).content[0].text); // flow_id, graph, ...
   ```

5. Stage a patch built from that graph — append a delay and an edge to it:

   ```js
   const stage = tools.find((t) => t.name === 'dakflare_stage_flow_patch');
   const read = (r) => JSON.parse(JSON.parse(r).content[0].text);
   const flow = read(await mc.executeTool(ast, {}));
   const trigger = flow.graph.nodes[0];
   const patch = {
     nodes: [...flow.graph.nodes,
       { id: 'n_check_delay', type: 'delay', position: { x: 360, y: 120 }, data: { seconds: 30 } }],
     edges: [...flow.graph.edges,
       { id: 'e_check_delay', source: trigger.id, target: 'n_check_delay' }]
   };
   read(await mc.executeTool(stage, { intent: 'add a 30 second delay after the trigger', patch }));
   ```

6. Watch the ghost patch appear: **Preview**, **STAGED PATCH · NOT APPLIED**,
   the intent, `+ Delay`, and Accept/Revert. Nothing is saved. With the delay left
   without an outgoing edge the banner also shows "Delay needs exactly one
   outgoing connection (found 0)" and Accept stays blocked — proof that staging
   did not bypass validation.

### Result recorded on this machine

Chromium `156.0.8078.79` on Linux with `--enable-features=WebMCP` exposes
`document.modelContext` (`getTools`, `registerTool`, `executeTool`; no
`unregisterTool`), so the recipe ran headlessly through the DevTools protocol
against the real Vite dev server and a stub session endpoint:

- all four tools were listed by `getTools()` with the expected names;
- Chrome reported `readOnlyHint` true for `get_flow_ast`/`diagnose_message`, and
  `consequentialHint: true` for `stage_flow_patch`;
- `dakflare_get_flow_ast` returned a draft flow (`wf_96f3…`) with one trigger;
- `dakflare_stage_flow_patch` returned `{ ok: true, added: 1, modified: 1, ... }`
  and the page showed the ghost banner with **STAGED PATCH · NOT APPLIED**, a
  Preview, `+ Delay`, and the validation block above.

The declarative forms were not driven by an agent in this run; their attribute
emission is covered by the harness, while a browser reading them into tools still
needs a manual check with a WebMCP client.

## What the harness proves, and what needs a browser

Run from `dashboard/`:

```bash
node --experimental-strip-types scripts/webmcp-check.mjs
```

It imports the real `webmcp.ts` and `webmcp-attributes.ts` into Node (a resolve
hook supplies the `$lib` alias, extensionless TS imports, and a `$app/paths`
stub), and stubs `document`/`navigator`.

Proved without a browser (20 assertions):

- the four expected names register, in order;
- annotations: read-only for `get_flow_ast`/`diagnose_message`,
  `consequentialHint: true` and `destructiveHint: true` for `stage_flow_patch`,
  non-destructive for `synthesize_pattern`, and every tool has a description and
  object schema;
- all four registrations receive the same `AbortSignal`, not aborted at
  registration;
- cleanup aborts it, calls `unregisterTool` once per tool, is idempotent, and
  still aborts when `unregisterTool` is missing;
- no `modelContext` (or a context without `registerTool`) is a no-op whose cleanup
  does not throw; `navigator.modelContext` is used when `document`'s is absent;
- `get_flow_ast` returns the live host AST; `stage_flow_patch` passes intent and
  patch through and reports a refusal as an error;
- `toolForm`/`toolParam` emit exactly the expected attributes and never
  `toolautosubmit`; neither mutating form in source carries it.

Needs a real browser (Chrome with WebMCP):

- that Chrome accepts these registrations and lists them from `getTools()`;
- that the annotation translation is what the browser surfaces (this is how the
  `consequentialHint` gap was found);
- `executeTool` round-trips and the ghost banner renders, accepts and reverts;
- the declarative forms being discovered and filled by a WebMCP client;
- teardown on navigation actually removing the tools from the browser's list;
- browser-version differences in the API shape (`unregisterTool`, promise vs
  value returns).
