//! WASM ABI for the flow interpreter.
//!
//! Deliberately hand-rolled instead of `wasm-bindgen`: the Worker needs three
//! calls and a byte buffer, and the generated glue assumes a module loader the
//! Workers runtime does not provide.
//!
//! ## Contract
//!
//! ```text
//! alloc(len) -> ptr            allocate `len` bytes for the caller
//! dealloc(ptr, len)            free a buffer from alloc/run
//! run(ptr, len) -> ptr         read JSON, write [u32 LE length][JSON]
//! ```
//!
//! The returned buffer is owned by the module; the caller reads the length,
//! copies the payload, then calls `dealloc(ptr, 4 + length)`.

use dakflare_flow::{RunInput, run};
use serde_json::{Value, json};

/// # Safety
/// `len` bytes are allocated and returned uninitialised; the caller must fill them.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let boxed = vec![0u8; len].into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

/// # Safety
/// `ptr` must come from `alloc`/`run` with the same `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    drop(unsafe { Vec::from_raw_parts(ptr, len, len) });
}

/// # Safety
/// `ptr`/`len` must describe a buffer allocated with `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn run_json(ptr: *const u8, len: usize) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let payload = evaluate(input);

    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    framed.extend_from_slice(&payload);

    Box::into_raw(framed.into_boxed_slice()) as *mut u8
}

fn evaluate(input: &[u8]) -> Vec<u8> {
    let parsed: Result<RunInput, _> = serde_json::from_slice(input);
    match parsed {
        Ok(run_input) => {
            let result = run(&run_input);
            serde_json::to_vec(&result).unwrap_or_else(|e| error_json(&e.to_string()))
        }
        Err(e) => error_json(&format!("invalid input: {e}")),
    }
}

/// Validate a graph document without running it.
///
/// Returns `{"ok":true,"graph":...}` with the canonical form (schema stamped,
/// unknown keys dropped, `ui_layout` computed) or `{"ok":false,"issues":[...]}`.
/// The Worker uses this on save; the handset uses it to refuse a graph the edge
/// accepted from an older build.
///
/// # Safety
/// `ptr`/`len` must describe a buffer allocated with `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn validate_json(ptr: *const u8, len: usize) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    frame(validate_payload(input))
}

/// Validate, then place every node. Returns `{"ok":true,"algorithm":...,"positions":{...}}`.
///
/// # Safety
/// `ptr`/`len` must describe a buffer allocated with `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn layout_json(ptr: *const u8, len: usize) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    frame(layout_payload(input))
}

/// Validate and run one message. Returns `{"ok":true,"trace":...}` or the issues.
///
/// `delay` and `webhook` and `send_sms` are actions in the trace, not effects:
/// the caller performs them, which is what keeps this deterministic.
///
/// # Safety
/// `ptr`/`len` must describe a buffer allocated with `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn trace_json(ptr: *const u8, len: usize) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    frame(trace_payload(input))
}

fn validate_payload(input: &[u8]) -> Vec<u8> {
    let value: Value = match serde_json::from_slice(input) {
        Ok(value) => value,
        Err(error) => return issues_json(&format!("document is not JSON: {error}")),
    };
    match dakflare_flow::ir::validate(&value) {
        Ok(graph) => serde_json::to_vec(&json!({ "ok": true, "graph": graph }))
            .unwrap_or_else(|e| issues_json(&e.to_string())),
        Err(issues) => serde_json::to_vec(&json!({
            "ok": false,
            "issues": dakflare_flow::ir::sorted(issues),
        }))
        .unwrap_or_else(|e| issues_json(&e.to_string())),
    }
}

fn layout_payload(input: &[u8]) -> Vec<u8> {
    let value: Value = match serde_json::from_slice(input) {
        Ok(value) => value,
        Err(error) => return issues_json(&format!("document is not JSON: {error}")),
    };
    match dakflare_flow::ir::validate(&value) {
        Ok(graph) => {
            let layout = graph.ui_layout.clone().unwrap_or_else(|| dakflare_flow::ir::layout(&graph));
            serde_json::to_vec(&json!({
                "ok": true,
                "algorithm": layout.algorithm,
                "positions": layout.positions,
            }))
            .unwrap_or_else(|e| issues_json(&e.to_string()))
        }
        Err(issues) => serde_json::to_vec(&json!({
            "ok": false,
            "issues": dakflare_flow::ir::sorted(issues),
        }))
        .unwrap_or_else(|e| issues_json(&e.to_string())),
    }
}

fn trace_payload(input: &[u8]) -> Vec<u8> {
    let value: Value = match serde_json::from_slice(input) {
        Ok(value) => value,
        Err(error) => return issues_json(&format!("document is not JSON: {error}")),
    };
    let graph_value = value.get("graph").cloned().unwrap_or(Value::Null);
    let message_value = value.get("message").cloned().unwrap_or(Value::Null);

    let graph = match dakflare_flow::ir::validate(&graph_value) {
        Ok(graph) => graph,
        Err(issues) => {
            return serde_json::to_vec(&json!({
                "ok": false,
                "issues": dakflare_flow::ir::sorted(issues),
            }))
            .unwrap_or_else(|e| issues_json(&e.to_string()))
        }
    };
    let message: dakflare_flow::Message = match serde_json::from_value(message_value) {
        Ok(message) => message,
        Err(error) => return issues_json(&format!("message: {error}")),
    };

    let trace = run(&RunInput { graph, message });
    serde_json::to_vec(&json!({ "ok": true, "trace": trace }))
        .unwrap_or_else(|e| issues_json(&e.to_string()))
}

fn issues_json(message: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "ok": false,
        "issues": [{ "path": "", "message": message }],
    }))
    .unwrap_or_else(|_| b"{\"ok\":false,\"issues\":[]}".to_vec())
}

/// `[u32 LE length][JSON]`, the same framing `run_json` uses.
fn frame(payload: Vec<u8>) -> *mut u8 {
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    framed.extend_from_slice(&payload);
    Box::into_raw(framed.into_boxed_slice()) as *mut u8
}

fn error_json(message: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "matched": false,
        "outcome": "error",
        "actions": [],
        "variables": {},
        "steps": [],
        "error": message,
    }))
    .unwrap_or_else(|_| b"{\"matched\":false,\"outcome\":\"error\",\"actions\":[],\"variables\":{},\"steps\":[],\"error\":\"encoding\"}".to_vec())
}
