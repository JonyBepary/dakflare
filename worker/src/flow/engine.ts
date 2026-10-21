/**
 * Loader for the Rust flow interpreter.
 *
 * The interpreter is the same crate the simulator runs natively
 * (`simulator/flow`), compiled to `wasm32-unknown-unknown`. Keeping one
 * implementation is what stops device and fallback semantics from drifting.
 *
 * The ABI is intentionally tiny — `alloc`, `dealloc`, `run_json` — rather than
 * wasm-bindgen, whose generated glue expects a module loader Workers does not
 * have. `run_json` returns a pointer to `[u32 LE length][JSON]`.
 */

import flowModule from "../wasm/flow.wasm";

export interface FlowAction {
  type: "send_sms";
  to: string;
  body: string;
}

export interface FlowStep {
  node_id: string;
  kind: string;
  detail: string;
}

export interface FlowResult {
  matched: boolean;
  outcome: "delivered" | "filtered" | "halted" | "no_trigger" | "error";
  actions: FlowAction[];
  variables: Record<string, string>;
  steps: FlowStep[];
  error?: string | null;
}

interface FlowExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  run_json(ptr: number, len: number): number;
}

let instance: Promise<FlowExports> | null = null;

function load(): Promise<FlowExports> {
  if (instance === null) {
    instance = WebAssembly.instantiate(flowModule, {}).then(
      (result) => result.exports as unknown as FlowExports
    );
  }
  return instance;
}

export interface FlowMessage {
  sender: string;
  body: string;
  received_at: number;
}

/**
 * Run one graph against one message.
 *
 * The call is synchronous once the module is loaded, so two concurrent requests
 * in the same isolate cannot interleave inside the shared memory.
 */
export async function runFlow(graph: unknown, message: FlowMessage): Promise<FlowResult> {
  const wasm = await load();
  const input = new TextEncoder().encode(
    JSON.stringify({ graph, message })
  );

  const inputPtr = wasm.alloc(input.byteLength);
  new Uint8Array(wasm.memory.buffer, inputPtr, input.byteLength).set(input);

  const outPtr = wasm.run_json(inputPtr, input.byteLength);

  // Views must be created after the call: `alloc`/`run_json` can grow memory and
  // detach any buffer captured earlier.
  const view = new DataView(wasm.memory.buffer);
  const length = view.getUint32(outPtr, true);
  const payload = new Uint8Array(wasm.memory.buffer, outPtr + 4, length).slice();

  wasm.dealloc(outPtr, 4 + length);
  wasm.dealloc(inputPtr, input.byteLength);

  return JSON.parse(new TextDecoder().decode(payload)) as FlowResult;
}
