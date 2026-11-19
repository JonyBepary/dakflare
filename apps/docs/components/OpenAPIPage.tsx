"use client";

import { createOpenAPIPage } from "fumadocs-openapi/ui";
import type { OpenAPIPageProps } from "fumadocs-openapi/ui";

const APIPage = createOpenAPIPage();

export function OpenAPIPage(props: OpenAPIPageProps) {
  return <APIPage {...props} />;
}
