import { readError } from "@keel/http/envelope";
import { Button } from "@keel/ui/components/button";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
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
 *
 * Nothing here passes an organization: the tenant comes from the session cookie
 * and is applied server-side. A client that could name its own tenant would be a
 * client that could name someone else's.
 */
export const Route = createFileRoute("/_auth/_org/dashboard")({
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
	const { organization, user } = Route.useRouteContext();
	const { data: projects, meta } = Route.useLoaderData();
	const router = useRouter();

	return (
		<div className="space-y-4 p-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="font-bold text-2xl">{organization.name}</h1>
					<p className="text-muted-foreground">Welcome {user.name}</p>
				</div>
				<div className="flex gap-2">
					<Link to="/settings/activity">
						<Button variant="outline">Activity</Button>
					</Link>
					<Link to="/settings/members">
						<Button variant="outline">Members</Button>
					</Link>
				</div>
			</div>

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
