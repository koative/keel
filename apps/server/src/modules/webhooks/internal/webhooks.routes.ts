import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { rejectInvalid } from "@/lib/validate";
import { receive } from "./webhooks.handlers";
import { webhookHeadersSchema, webhookProviderSchema } from "./webhooks.schema";

/**
 * `/api/webhooks/:provider` — where a provider's deliveries land.
 *
 * Deliberately no session guards and no rate limiter, unlike every other
 * internal surface. The signature is the authentication: a provider has no
 * cookie, so `requireUser` would 401 every delivery, and the receiver's own
 * protections — verify, replay window, unique index, namespaced dedupe — are
 * the abuse surface. Rate limiting a provider's legitimate retries would break
 * delivery; the window and the index are what stop replays.
 *
 * Unversioned and free to change, like all of `/api`: nothing outside this
 * repo may depend on it, and a `/v1` webhook contract is a frozen-contract
 * decision nobody has made yet.
 */
export const internalWebhookRoutes = new Hono<AppEnv>().post(
	"/:provider",
	zValidator("param", webhookProviderSchema, rejectInvalid),
	zValidator("header", webhookHeadersSchema, rejectInvalid),
	receive
);
