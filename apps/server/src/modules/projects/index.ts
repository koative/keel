/**
 * The module's only entry point.
 *
 * Nothing outside `modules/projects/` may name a file inside it — not the
 * service, not the repository, not a schema. Two rules keep that true: relative
 * imports may not escape a module directory, and `@/modules/<name>/...` deep
 * paths are rejected. Whatever leaves through here is the module's API.
 */
export { internalProjectRoutes } from "./internal/projects.routes";
export { publicProjectRoutesV1 } from "./public/projects.v1.routes";
