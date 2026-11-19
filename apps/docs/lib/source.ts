import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";
import { createOpenAPI } from "fumadocs-openapi/server";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export const openapi = createOpenAPI({
  input: ["./public/openapi.json"],
});
