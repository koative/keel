import { env } from "@keel/env/web";
import { createAuthClient } from "better-auth/react";
import { serverOrigin } from "./server-url";

export const authClient = createAuthClient({
	// better-auth derives its route-matching base from this URL's path, so the
	// public auth path must equal the server-side mount (/api/auth everywhere)
	baseURL: new URL("/api/auth", serverOrigin(env.VITE_SERVER_URL)).toString(),
});
