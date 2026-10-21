#!/usr/bin/env bash
# Rebuild the Worker's flow interpreter.
#
# The .wasm is committed because `cf deploy` bundles it; regenerate it whenever
# `simulator/flow` changes.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/dakflare_flow_wasm.wasm \
   ../../worker/src/wasm/flow.wasm
echo "wrote worker/src/wasm/flow.wasm ($(wc -c < ../../worker/src/wasm/flow.wasm) bytes)"
