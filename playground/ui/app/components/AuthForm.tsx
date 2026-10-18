"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export interface AuthField {
	name: string;
	label: string;
	type?: string;
	autoComplete?: string;
	placeholder?: string;
	list?: string;
	minLength?: number;
	maxLength?: number;
}

interface AuthFormProps {
	endpoint: string;
	submitLabel: string;
	fields: AuthField[][];
	footer: { text: string; href: string; linkLabel: string };
}

export function AuthForm({ endpoint, submitLabel, fields, footer }: AuthFormProps) {
	const router = useRouter();
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(undefined);
		setPending(true);
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => ({}))) as { error?: string };
				setError(payload.error ?? `请求失败（${response.status}）`);
				return;
			}
			router.push("/chapters");
			router.refresh();
		} catch {
			setError("网络错误，请稍后再试");
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="form" onSubmit={onSubmit}>
			{fields.map((row, index) => (
				<div key={index} className={row.length > 1 ? "field-row" : undefined}>
					{row.map((field) => (
						<label key={field.name} className="field">
							{field.label}
							<input
								name={field.name}
								type={field.type ?? "text"}
								autoComplete={field.autoComplete}
								placeholder={field.placeholder}
								list={field.list}
								minLength={field.minLength}
								maxLength={field.maxLength}
								required
							/>
						</label>
					))}
				</div>
			))}
			{error && <div className="form-error" role="alert">{error}</div>}
			<button type="submit" className="button" disabled={pending}>
				{pending ? "请稍候…" : submitLabel}
			</button>
			<p className="muted" style={{ margin: 0, fontSize: 14 }}>
				{footer.text} <Link href={footer.href}>{footer.linkLabel}</Link>
			</p>
		</form>
	);
}
