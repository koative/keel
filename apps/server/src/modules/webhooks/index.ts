/**
 * The module's only entry point.
 *
 * Nothing outside `modules/webhooks/` may name a file inside it — not the
 * repository, not a schema, not a worker handler. Two rules keep that true:
 * relative imports may not escape a module directory, and `@/modules/<name>/...`
 * deep paths are rejected. Whatever leaves through here is the module's API:
 * the internal receiver surface, and the worker-side handler for the
 * `webhook.process` job kind — the two halves of the webhook pipeline, the
 * receiver delivering events and the worker processing them.
 */
export { internalWebhookRoutes } from "./internal/webhooks.routes";
export { webhookProcess } from "./internal/webhooks.worker";
