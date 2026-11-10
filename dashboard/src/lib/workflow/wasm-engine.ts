/**
 * Client-side WebAssembly loader for the Rust Flow Engine & prose_synth.
 *
 * Runs the exact same `flow.wasm` as the edge Worker and Android handset,
 * providing sub-16ms tactile simulation and zero-regex "Highlight-to-Extract".
 */

import { BASE } from '$lib/paths';

export interface WasmFlowResult {
	matched: boolean;
	outcome: 'delivered' | 'filtered' | 'halted' | 'no_trigger' | 'error' | 'partial';
	actions: Array<
		| { type: 'send_sms'; to: string; body: string }
		| { type: 'delay'; seconds: number }
		| { type: 'webhook'; url: string; body: string }
	>;
	variables: Record<string, string>;
	steps: Array<{
		node_id: string;
		kind: string;
		detail: string;
	}>;
	error?: string | null;
}

export interface WasmSynthResult {
	ok: boolean;
	result?: {
		pattern: string;
		group: string;
		precision: number;
		recall: number;
		matches: number;
		sample_count: number;
	};
	reason?: string;
	message?: string;
}

interface WasmExports {
	memory: WebAssembly.Memory;
	alloc(len: number): number;
	dealloc(ptr: number, len: number): void;
	run_json(ptr: number, len: number): number;
	validate_json(ptr: number, len: number): number;
	synthesize_json(ptr: number, len: number): number;
}

let wasmPromise: Promise<WasmExports> | null = null;

async function loadWasm(): Promise<WasmExports> {
	if (wasmPromise) return wasmPromise;

	wasmPromise = (async () => {
		const wasmUrl = `${BASE}/flow.wasm`;
		const res = await fetch(wasmUrl);
		if (!res.ok) {
			throw new Error(`Failed to load flow.wasm from ${wasmUrl}: ${res.status}`);
		}
		const buffer = await res.arrayBuffer();
		const instantiated = await WebAssembly.instantiate(buffer, {});
		return instantiated.instance.exports as unknown as WasmExports;
	})();

	return wasmPromise;
}

function callWasmJson(
	wasm: WasmExports,
	fn: (ptr: number, len: number) => number,
	payload: unknown
): unknown {
	const enc = new TextEncoder();
	const inputBytes = enc.encode(JSON.stringify(payload));

	const inPtr = wasm.alloc(inputBytes.byteLength);
	new Uint8Array(wasm.memory.buffer, inPtr, inputBytes.byteLength).set(inputBytes);

	const outPtr = fn(inPtr, inputBytes.byteLength);

	// First 4 bytes are length (u32 Little Endian)
	const view = new DataView(wasm.memory.buffer, outPtr, 4);
	const outLen = view.getUint32(0, true);

	const outBytes = new Uint8Array(wasm.memory.buffer, outPtr + 4, outLen);
	const text = new TextDecoder().decode(outBytes);

	wasm.dealloc(outPtr, 4 + outLen);

	try {
		return JSON.parse(text);
	} catch (e) {
		throw new Error(`Failed to parse WASM output JSON: ${text}`);
	}
}

/**
 * Execute graph simulation in-browser in < 16ms using Rust WASM.
 */
export async function runWasmFlow(
	graph: unknown,
	message: { sender: string; body: string; received_at?: number }
): Promise<WasmFlowResult> {
	const wasm = await loadWasm();
	return callWasmJson(wasm, wasm.run_json.bind(wasm), {
		graph,
		message: {
			sender: message.sender,
			body: message.body,
			received_at: message.received_at ?? Date.now()
		}
	}) as WasmFlowResult;
}

/**
 * Synthesize a regex pattern from 2+ example substrings using Rust prose_synth.
 */
export async function synthesizePattern(
	samples: Array<{ body: string; value: string }>,
	groupName: string = 'val'
): Promise<WasmSynthResult> {
	const wasm = await loadWasm();
	return callWasmJson(wasm, wasm.synthesize_json.bind(wasm), {
		samples,
		group: groupName
	}) as WasmSynthResult;
}
