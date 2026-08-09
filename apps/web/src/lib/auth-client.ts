import { env } from "@keel/env/web";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { serverOrigin } from "./server-url";

export const authClient = createAuthClient({
	// better-auth derives its route-matching base from this URL's path, so the
	// public auth path must equal the server-side mount (/api/auth everywhere)
	baseURL: new URL("/api/auth", serverOrigin(env.VITE_SERVER_URL)).toString(),
	// Tenancy is organization-only, so the SPA needs both halves of this plugin:
	// the `/organization/*` calls and the `session.activeOrganizationId` field
	// every tenant-scoped guard reads. It takes no options because the server
	// registers `organization()` with the default `owner | admin | member` roles.
	plugins: [organizationClient()],
});
