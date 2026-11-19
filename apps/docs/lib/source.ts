import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";
import { createOpenAPI } from "fumadocs-openapi/server";
import type { Document } from "fumadocs-openapi";
// The spec is bundled, not read from disk: this app runs on Cloudflare Workers, where there is
// no filesystem, and a path input throws at request time ("Failed to resolve input"). Importing
// it makes the same document available at build and at the edge.
import openapiSpec from "../public/openapi.json";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

/** The id every caller uses to look the document up. */
export const OPENAPI_SCHEMA_ID = "openapi.json";

export const openapi = createOpenAPI({
  input: { [OPENAPI_SCHEMA_ID]: openapiSpec as unknown as Document },
});
