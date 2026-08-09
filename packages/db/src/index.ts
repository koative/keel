import { env } from "@keel/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema/index";

export function createDb() {
	return drizzle(env.DATABASE_URL, { schema });
}

export const db = createDb();
