import { Toaster } from "@keel/ui/components/sonner";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import Header from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

/**
 * What the router is created with, which is nothing: every value in context is
 * contributed by a descendant's `beforeLoad` — the session by `_auth`, the
 * organization by `_auth/_org`.
 *
 * `Record<never, never>` and not `Record<string, never>`. The latter carries a
 * string index signature of `never`, which intersects with every key a child
 * adds and collapses it back to `never`. That type-checks at the guard that
 * returns the value and fails at the consumer that reads it, with an error
 * naming the property rather than the declaration responsible.
 */
export type RouterAppContext = Record<never, never>;

export const Route = createRootRouteWithContext<RouterAppContext>()({
	component: RootComponent,
	head: () => ({
		links: [
			{
				href: "/favicon.ico",
				rel: "icon",
			},
		],
		meta: [
			{
				title: "keel",
			},
			{
				content: "keel is a web application",
				name: "description",
			},
		],
	}),
});

function RootComponent() {
	return (
		<>
			<HeadContent />
			<ThemeProvider
				attribute="class"
				defaultTheme="dark"
				disableTransitionOnChange
				storageKey="vite-ui-theme"
			>
				<div className="grid h-svh grid-rows-[auto_1fr]">
					<Header />
					<Outlet />
				</div>
				<Toaster richColors />
			</ThemeProvider>
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
