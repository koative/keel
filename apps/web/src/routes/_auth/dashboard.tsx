import { readError } from "@keel/http/envelope";
import { Button } from "@keel/ui/components/button";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { api } from "@/lib/api";

/**
 * The reference consumer of the typed client.
 *
 * `api.api.projects.$get()` is checked against the server's route tree at build
 * time: rename `slug` on the server and this file stops compiling. Note that no
 * response type is written down — the loader's return type flows into
 * `useLoaderData`, so the shape is the server's shape by construction rather than
 * by a hand-maintained interface that drifts.
 *
 * The failure body is a separate concern: it is produced by `app.onError`, which
 * sits outside any route definition, so the client cannot infer it. That is what
 * `@keel/http/envelope` is for — one shared shape, zod only, no server imports.
 */
export const Route = createFileRoute("/_auth/dashboard")({
	component: RouteComponent,
	loader: async () => {
		// `limit` is required by the type because the endpoint declares it. That is
		// the point: the paging contract is not something to remember.
		const response = await api.api.projects.$get({ query: { limit: "25" } });
		if (!response.ok) {
			throw new Error(
				readError(await response.json(), response.status).message
			);
		}

		return await response.json();
	},
});

function RouteComponent() {
	const { user } = Route.useRouteContext();
	const { data: projects, meta } = Route.useLoaderData();
	const router = useRouter();

	return (
		<div className="space-y-4 p-6">
			<h1 className="font-bold text-2xl">Dashboard</h1>
			<p>Welcome {user.name}</p>

			{projects.length === 0 ? (
				<p className="text-muted-foreground">No projects yet.</p>
			) : (
				<ul className="space-y-1">
					{projects.map((project) => (
						<li key={project.id}>
							<span className="font-medium">{project.name}</span>{" "}
							<span className="text-muted-foreground">{project.slug}</span>
						</li>
					))}
				</ul>
			)}

			{meta.nextCursor ? (
				<p className="text-muted-foreground text-sm">
					More projects available beyond this page.
				</p>
			) : null}

			<Button onClick={() => router.invalidate()} variant="outline">
				Reload
			</Button>
		</div>
	);
}
