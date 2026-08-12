/**
 * The module's only entry point.
 *
 * Nothing outside `modules/ai/` may name a file inside it. Whatever leaves
 * through here is the module's API: the internal surface that hands prompts to
 * the queue — the model call itself stays in the worker, and a `/v1` AI
 * contract is a frozen-contract decision nobody has made yet.
 */
export { internalAiRoutes } from "./internal/ai.routes";
