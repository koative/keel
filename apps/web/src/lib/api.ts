import { createApiClient } from "@keel/api-client";
import { env } from "@keel/env/web";
import { serverOrigin } from "./server-url";

/**
 * The typed client for `/api`.
 *
 * Every path, body and response shape is checked against the server's route tree
 * at build time, so a renamed field breaks the build here instead of returning
 * `undefined` at runtime. Nothing is hand-written per endpoint.
 */
export const api = createApiClient(serverOrigin(env.VITE_SERVER_URL));

/** Named here because this module owns the instance. */
export type Api = typeof api;
