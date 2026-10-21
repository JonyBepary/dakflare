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
