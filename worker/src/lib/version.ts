/**
 * Single source of truth for the installed version.
 *
 * Must match `package.json`. Bump this in the same commit as any schema or wire-format change.
 * `GET /v1/admin/health` reports it, and that is the only version signal an operator or a support
 * thread has — nobody upstream can inspect a self-hosted deployment.
 */
export const VERSION = "5.1.0";
