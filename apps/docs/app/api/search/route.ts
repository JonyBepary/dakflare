import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

/**
 * The endpoint the search dialog already calls (`/api/search?query=…`).
 *
 * It was missing, so every keystroke in the search box resolved to a 404 and the
 * dialog stayed empty. The index is built from the same loader the pages use, in
 * `zbsearch` — pure JS, no filesystem and no native module — which is what the
 * Workers runtime this site is deployed on can actually run.
 */
export const { GET } = createFromSource(source);
