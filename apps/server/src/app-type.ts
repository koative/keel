/**
 * The module the declaration bundle is built from.
 *
 * `tsdown.types.config.ts` points the bundle entry here so `AppType` — the type
 * behind @keel/api-client's `hc<AppType>` — derives from `internalRoutes`
 * alone. The frozen `/v1` half of `app` never enters the bundle, so a change
 * to a public endpoint cannot degrade the client's types to `any` again.
 *
 * Nothing imports this module at runtime: it exists only to give the bundle
 * a surface that stops at what the client is allowed to see.
 */
import { internalRoutes } from "@/internal-routes";

export type AppType = typeof internalRoutes;
