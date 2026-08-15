import { createEnv } from "@t3-oss/env-core";
import { serverUrlSchema } from "./server-url";

// `import.meta.env` is injected by Vite at build time. This package is consumed
// by the web app but does not depend on Vite itself, so the shape is declared
// locally instead of pulling in `vite/client` types.
const runtimeEnv = (
	import.meta as ImportMeta & { env: Record<string, string | undefined> }
).env;

export const env = createEnv({
	client: {
		VITE_SERVER_URL: serverUrlSchema,
	},
	clientPrefix: "VITE_",
	emptyStringAsUndefined: true,
	runtimeEnv,
});
