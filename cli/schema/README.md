# `flow-v2.json`

The canonical `dakflare.flow/v2` document, as a JSON Schema (draft 2020-12).

It is **derived from the validator**, not a second validator. There was no schema
anywhere in the repository when this was written: the two implementations that
actually decide whether a flow is acceptable are

- `worker/src/lib/flow-ir.ts` (the Worker, used on save), and
- `simulator/flow/src/ir.rs` (the handset, plus the WASM module the Worker falls
  back to),

kept honest against each other by `test-support/flow-ir-vectors.json`. This file
names what those checkers accept — node kinds and their `data` fields, edge
handles, template references, and the target fields an `ag1_` apply handle
carries — with the same bounds (`MAX_NODES`, `MAX_EDGES`, `MAX_TEMPLATE_CHARS`,
`MAX_DELAY_SECONDS`, ...).

Where this document and the validators disagree, **the validators win**. Add a
test to `test-support` when changing either; do not treat a schema pass as a
graph the Worker will accept.

Print it:

```bash
dakflare schema --flow-v2          # a summary and this path
dakflare schema --flow-v2 --json   # the document alone, no envelope
```

`--json` deliberately prints the raw document so it can be piped straight into a
validator:

```bash
dakflare schema --flow-v2 --json > flow-v2.json
```

## Notes that are not expressible as JSON Schema

- Exactly one `trigger` node; it has no incoming edges and exactly one outgoing.
- A `condition` has one `true` and one `false` outgoing edge; a `switch` has
  `cases.length + 1` outgoing edges (`case:<i>` and `default`).
- A `stop` has no outgoing edges; every other kind has exactly one.
- The graph is acyclic and every node is reachable from the trigger.
- Every `{{ name }}` reference must be bound on **every** path to the node.
- Capture-group names are unique across the whole graph and may not shadow the
  builtins `sender`, `body`, `received_at`.
- `pattern`, and a `matches` right-hand side, must pass the RE2 lint
  (`worker/src/lib/re2-compat.ts`).
- A webhook URL must not resolve to loopback, private, CGNAT or metadata space
  (`isBlockedWebhookHost`).
