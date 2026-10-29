#!/usr/bin/env node
/**
 * Compatibility entry point.
 *
 * The implementation lives in `cli/bin/dakflare.js`; this shim keeps the
 * historical `node cli/dakflare.mjs` path and the root package's `bin` entry
 * working.
 */
import './bin/dakflare.js';
