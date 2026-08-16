import { readError } from "@keel/http/envelope";
import { Button } from "@keel/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@keel/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import AuditEntryList, {
	type AuditEntryRow,
} from "@/components/audit-entry-list";
import { api } from "@/lib/api";

/** One page of entries, as a string because it travels as a query parameter. */
const PAGE_SIZE = "25";

/**
 * Under `_org`, unlike `/settings/account`: this is one organization's activity,
 * every row belongs to the tenant rather than to the viewer, and the endpoint
 * scopes it by the organization on the session.
 */
export const Route = createFileRoute("/_auth/_org/settings/activity")({
	component: RouteComponent,
	loader: async () => {
		const response = await api.api.audit.$get({ query: { limit: PAGE_SIZE } });

		if (!response.ok) {
			const problem = readError(await response.json(), response.status);
			// The server decides who may read this — a member who is neither owner nor
			// admin gets 403 — and that is an answer, not a failure. Returning null
			// lets the screen explain itself instead of throwing the router into an
			// error page, and it keeps the role rule in one place: re-deriving it here
			// from the membership list would be a second opinion that can disagree.
			if (problem.code === "FORBIDDEN") {
				return null;
			}
			throw new Error(problem.message);
		}

		return await response.json();
	},
});

function RouteComponent() {
	const { organization } = Route.useRouteContext();
	const page = Route.useLoaderData();
	const [entries, setEntries] = useState<AuditEntryRow[]>(
		page?.data.entries ?? []
	);
	const [cursor, setCursor] = useState(page?.data.nextCursor ?? null);
	const [isLoading, setIsLoading] = useState(false);

	async function loadMore() {
		if (!cursor) {
			return;
		}

		setIsLoading(true);
		const response = await api.api.audit.$get({
			query: { cursor, limit: PAGE_SIZE },
		});
		setIsLoading(false);

		if (!response.ok) {
			toast.error(readError(await response.json(), response.status).message);
			return;
		}

		const next = await response.json();
		// Appended rather than replaced: the cursor only moves forward, so a page
		// that scrolled away has no second URL to go back to.
		setEntries((current) => [...current, ...next.data.entries]);
		setCursor(next.data.nextCursor);
	}

	const actorNames = Object.fromEntries(
		organization.members.map((member) => [member.userId, member.user.name])
	);

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
			<div>
				<h1 className="font-semibold text-2xl">Activity</h1>
				<p className="text-muted-foreground text-sm">{organization.name}</p>
			</div>

			{page === null ? (
				<Card>
					<CardHeader>
						<CardTitle>Not visible to you</CardTitle>
						<CardDescription>
							This is everything everyone in {organization.name} has done, so
							only owners and admins can read it. Ask one of them if you need an
							action traced.
						</CardDescription>
					</CardHeader>
				</Card>
			) : (
				<Card>
					<CardHeader>
						<CardTitle>Recent changes</CardTitle>
						<CardDescription>
							Newest first. The trail records every request that changes
							something — a page someone merely opened does not appear here —
							including the ones that were refused, which is what makes a failed
							attempt visible.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						{entries.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								Nothing has been changed yet.
							</p>
						) : (
							<AuditEntryList actorNames={actorNames} entries={entries} />
						)}

						{cursor ? (
							<Button disabled={isLoading} onClick={loadMore} variant="outline">
								{isLoading ? "Loading..." : "Load more"}
							</Button>
						) : null}
					</CardContent>
				</Card>
			)}
		</div>
	);
}
