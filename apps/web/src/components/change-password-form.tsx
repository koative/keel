import { Button } from "@keel/ui/components/button";
import { Input } from "@keel/ui/components/input";
import { Label } from "@keel/ui/components/label";
import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";

export default function ChangePasswordForm() {
	const form = useForm({
		defaultValues: {
			currentPassword: "",
			newPassword: "",
		},
		onSubmit: async ({ value }) => {
			await authClient.changePassword(
				{
					currentPassword: value.currentPassword,
					newPassword: value.newPassword,
				},
				{
					onError: (error) => {
						// The new password passed the client validator, so a rejection here
						// is almost always the current one being wrong. Better Auth answers
						// that with INVALID_PASSWORD and the message "Invalid password",
						// which reads as if the field the user just chose was refused. Name
						// the field that actually failed.
						if (error.error.code === "INVALID_PASSWORD") {
							toast.error("Your current password is not correct");
							return;
						}
						toast.error(error.error.message || error.error.statusText);
					},
					onSuccess: () => {
						// This session keeps its cookie — Better Auth only rotates it when
						// `revokeOtherSessions` is set — so there is nowhere to navigate.
						// Clearing the fields is the whole reset: leaving a password sitting
						// in a filled input after the operation is done is not useful.
						form.reset();
						toast.success("Password changed");
					},
				}
			);
		},
		validators: {
			onSubmit: z.object({
				currentPassword: z.string().min(1, "Your current password is required"),
				newPassword: z
					.string()
					.min(8, "Password must be at least 8 characters"),
			}),
		},
	});

	return (
		<form
			className="space-y-4"
			onSubmit={(e) => {
				e.preventDefault();
				e.stopPropagation();
				form.handleSubmit();
			}}
		>
			<div>
				<form.Field name="currentPassword">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>Current password</Label>
							<Input
								autoComplete="current-password"
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

			<div>
				<form.Field name="newPassword">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>New password</Label>
							<Input
								autoComplete="new-password"
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
					<Button disabled={!canSubmit || isSubmitting} type="submit">
						{isSubmitting ? "Changing..." : "Change password"}
					</Button>
				)}
			</form.Subscribe>
		</form>
	);
}
