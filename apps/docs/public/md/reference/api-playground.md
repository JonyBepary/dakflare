# Interactive API Playground

> Interactive OpenAPI 3.1.0 playground powered by fumadocs-openapi for testing DakFlare endpoints.

Try DakFlare's core REST endpoints directly against your deployment using the generated [`/openapi.json`](/openapi.json) specification.

<APIPage
  document="./public/openapi.json"
  operations={[
    { path: "/v1/sms/send", method: "post" },
    { path: "/v1/sms/commands/{command_id}", method: "get" },
    { path: "/v1/devices", method: "get" },
    { path: "/v1/messages", method: "get" },
    { path: "/v1/admin/workflows/{id}", method: "put" },
    { path: "/v1/agent/triage", method: "post" },
    { path: "/v1/agent/telemetry", method: "post" },
    { path: "/v1/agent/diagnose", method: "post" },
    { path: "/v1/agent/synthesize", method: "post" },
    { path: "/v1/webhooks/{id}", method: "post" },
    { path: "/mcp", method: "post" }
  ]}
/>
