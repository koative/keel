import { Button } from "@keel/ui/components/button";
import { Input } from "@keel/ui/components/input";
import { Label } from "@keel/ui/components/label";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";

import Loader from "./loader";

export default function SignUpForm({
	onSwitchToSignIn,
	redirectTo,
}: {
	onSwitchToSignIn: () => void;
	redirectTo: string;
}) {
	const navigate = useNavigate({
		from: "/",
	});
	/**
	 * The address a verification mail has just been sent to, and the signal that
	 * this form is done: sign-up is terminal here, not a step on the way to a
	 * session.
	 */
	const [pendingVerification, setPendingVerification] = useState<string | null>(
		null
	);
	const { isPending } = authClient.useSession();

	const form = useForm({
		defaultValues: {
			email: "",
			name: "",
			password: "",
		},
		onSubmit: async ({ value }) => {
			await authClient.signUp.email(
				{
					email: value.email,
					name: value.name,
					password: value.password,
				},
				{
					onError: (error) => {
						toast.error(error.error.message || error.error.statusText);
					},
					// Annotated because better-auth's client types this callback's `data`
					// as `any`, and the branch below is the whole fix — an unchecked
					// property access would let a rename break it silently.
					onSuccess: ({ data }: { data: { token: string | null } }) => {
						/**
						 * A null token means the server refuses to sign anyone in until
						 * the address is proven, and it set no cookie. Navigating anyway
						 * would send a sessionless user at the authenticated area, whose
						 * guard bounces them back to /login and re-renders this form —
						 * and a second sign-up of the same address answers with a
						 * synthetic success, so the loop would never resolve into an
						 * error either. The mail is the only way on from here.
						 */
						if (data.token === null) {
							setPendingVerification(value.email);
							return;
						}

						// `href`, not `to`: the destination came from a guard as a full path
						// and is not a known route literal.
						navigate({ href: redirectTo });
						toast.success("Sign up successful");
					},
				}
			);
		},
		validators: {
			onSubmit: z.object({
				email: z.email("Invalid email address"),
				name: z.string().min(2, "Name must be at least 2 characters"),
				password: z.string().min(8, "Password must be at least 8 characters"),
			}),
		},
	});

	if (isPending) {
		return <Loader />;
	}

	if (pendingVerification) {
		return (
			<div className="mx-auto mt-10 w-full max-w-md p-6">
				<h1 className="mb-6 text-center font-bold text-3xl">
					Check your inbox
				</h1>

				<p className="text-center">
					We sent a confirmation link to {pendingVerification}. Open it to
					finish signing up — until then, there is nothing to sign in to.
				</p>

				<div className="mt-4 text-center">
					<Button
						className="text-indigo-600 hover:text-indigo-800"
						onClick={onSwitchToSignIn}
						variant="link"
					>
						Already confirmed? Sign In
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="mx-auto mt-10 w-full max-w-md p-6">
			<h1 className="mb-6 text-center font-bold text-3xl">Create Account</h1>

			<form
				className="space-y-4"
				onSubmit={(e) => {
					e.preventDefault();
					e.stopPropagation();
					form.handleSubmit();
				}}
			>
				<div>
					<form.Field name="name">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Name</Label>
								<Input
									id={field.name}
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									value={field.state.value}
								/>
								{field.state.meta.errors.map((error) => (
									<p className="text-red-500" key={error?.message}>
										{error?.message}
									</p>
								))}
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="email">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Email</Label>
								<Input
									id={field.name}
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									type="email"
									value={field.state.value}
								/>
								{field.state.meta.errors.map((error) => (
									<p className="text-red-500" key={error?.message}>
										{error?.message}
									</p>
								))}
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="password">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Password</Label>
								<Input
									id={field.name}
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									type="password"
									value={field.state.value}
								/>
								{field.state.meta.errors.map((error) => (
									<p className="text-red-500" key={error?.message}>
										{error?.message}
									</p>
								))}
							</div>
						)}
					</form.Field>
				</div>

				<form.Subscribe
					selector={(state) => ({
						canSubmit: state.canSubmit,
						isSubmitting: state.isSubmitting,
					})}
				>
					{({ canSubmit, isSubmitting }) => (
						<Button
							className="w-full"
							disabled={!canSubmit || isSubmitting}
							type="submit"
						>
							{isSubmitting ? "Submitting..." : "Sign Up"}
						</Button>
					)}
				</form.Subscribe>
			</form>

			<div className="mt-4 text-center">
				<Button
					className="text-indigo-600 hover:text-indigo-800"
					onClick={onSwitchToSignIn}
					variant="link"
				>
					Already have an account? Sign In
				</Button>
			</div>
		</div>
	);
}
