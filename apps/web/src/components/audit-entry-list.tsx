/**
 * Structurally typed rather than derived from the client's response type: the
 * route already owns that inference, and a presentational list should not have to
 * name a generic to render six strings.
 */
export interface AuditEntryRow {
	actorId: string | null;
	createdAt: string;
	id: string;
	method: string;
	path: string;
	requestId: string;
	status: number;
}

export default function AuditEntryList({
	actorNames,
	entries,
}: {
	actorNames: Record<string, string>;
	entries: AuditEntryRow[];
}) {
	return (
		<ul className="divide-y">
			{entries.map((entry) => (
				<li className="flex flex-wrap items-baseline gap-3 py-3" key={entry.id}>
					<span
						className={
							entry.status >= 400 ? "font-mono text-red-500" : "font-mono"
						}
					>
						{entry.status}
					</span>
					<span className="min-w-48 flex-1 break-all">
						<span className="font-medium">{entry.method}</span> {entry.path}
					</span>
					<span className="text-muted-foreground text-sm">
						{/*
						 * An actor who is no longer a member of this organization keeps their
						 * row — that is the point of an audit trail — so the id is the
						 * fallback rather than a blank. A null actor is an unauthenticated
						 * request that still reached a tenant-scoped route.
						 */}
						{entry.actorId
							? (actorNames[entry.actorId] ?? entry.actorId)
							: "anonymous"}
					</span>
					<span className="text-muted-foreground text-sm">
						{new Date(entry.createdAt).toLocaleString()}
					</span>
					<span className="w-full font-mono text-muted-foreground text-xs">
						{entry.requestId}
					</span>
				</li>
			))}
		</ul>
	);
}
