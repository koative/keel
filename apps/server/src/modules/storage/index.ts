/**
 * The module's only entry point.
 *
 * Nothing outside `modules/storage/` may name a file inside it. Whatever leaves
 * through here is the module's API: a single internal surface, so there is
 * nothing else to export — and no `/v1` storage contract, which would freeze a
 * shape nobody has needed yet.
 */
export { internalStorageRoutes } from "./internal/storage.routes";
