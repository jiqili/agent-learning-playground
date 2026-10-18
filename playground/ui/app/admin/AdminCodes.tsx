"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface CodeRow {
	code: string;
	note: string;
	maxUses: number;
	usedBy: string[];
	revoked: boolean;
	createdBy: string;
	createdAt: string;
}

type Filter = "all" | "available" | "exhausted" | "revoked";

function statusOf(row: CodeRow): Exclude<Filter, "all"> {
	if (row.revoked) return "revoked";
	return row.usedBy.length >= row.maxUses ? "exhausted" : "available";
}

const statusLabel = { available: "可用", exhausted: "已用完", revoked: "已作废" } as const;

async function errorMessage(response: Response): Promise<string> {
	const payload = (await response.json().catch(() => ({}))) as { error?: string };
	return payload.error ?? `请求失败（${response.status}）`;
}

export function AdminCodes({ codes }: { codes: CodeRow[] }) {
	const router = useRouter();
	const [created, setCreated] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const [filter, setFilter] = useState<Filter>("all");
	const [copied, setCopied] = useState<string>();

	async function generate(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setPending(true);
		setError(undefined);
		try {
			const response = await fetch("/api/admin/codes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					count: Number(form.get("count")),
					maxUses: Number(form.get("maxUses")),
					note: form.get("note"),
				}),
			});
			if (!response.ok) return setError(await errorMessage(response));
			setCreated(((await response.json()) as { codes: string[] }).codes);
			router.refresh();
		} finally {
			setPending(false);
		}
	}

	async function mutate(code: string, init: RequestInit) {
		setError(undefined);
		const response = await fetch(`/api/admin/codes/${encodeURIComponent(code)}`, {
			...init,
			headers: { "Content-Type": "application/json" },
		});
		if (!response.ok) return setError(await errorMessage(response));
		router.refresh();
	}

	async function copy(text: string, key: string) {
		await navigator.clipboard.writeText(text);
		setCopied(key);
		setTimeout(() => setCopied((current) => (current === key ? undefined : current)), 1500);
	}

	const counts = { all: codes.length, available: 0, exhausted: 0, revoked: 0 };
	for (const row of codes) counts[statusOf(row)]++;
	const visible = filter === "all" ? codes : codes.filter((row) => statusOf(row) === filter);

	return (
		<>
			<section className="chapter">
				<h2 style={{ marginTop: 0 }}>生成注册码</h2>
				<form className="admin-form" onSubmit={generate}>
					<label className="field">
						数量
						<input name="count" type="number" min={1} max={100} defaultValue={10} required />
					</label>
					<label className="field">
						每个码可用次数
						<input name="maxUses" type="number" min={1} max={1000} defaultValue={1} required />
					</label>
					<label className="field" style={{ flex: 2 }}>
						备注（可选）
						<input name="note" maxLength={100} placeholder="例如：2026 秋季训练营" />
					</label>
					<button type="submit" className="button" disabled={pending}>{pending ? "生成中…" : "生成"}</button>
				</form>
				{created.length > 0 && (
					<div className="created-codes">
						<div className="results-summary passed">
							<span>已生成 {created.length} 个注册码</span>
							<button type="button" className="button secondary" onClick={() => copy(created.join("\n"), "__all")}>
								{copied === "__all" ? "已复制" : "全部复制"}
							</button>
						</div>
						<pre className="test-output">{created.join("\n")}</pre>
					</div>
				)}
			</section>

			{error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{error}</div>}

			<section className="chapter">
				<div className="chapter-header">
					<h2>全部注册码</h2>
					<div className="filter-tabs">
						{(["all", "available", "exhausted", "revoked"] as const).map((key) => (
							<button
								key={key}
								type="button"
								className={`button ${filter === key ? "" : "secondary"}`}
								onClick={() => setFilter(key)}
							>
								{key === "all" ? "全部" : statusLabel[key]} {counts[key]}
							</button>
						))}
					</div>
				</div>
				{visible.length === 0 ? (
					<p className="muted">暂无注册码</p>
				) : (
					<div className="table-wrap">
						<table className="admin-table">
							<thead>
								<tr>
									<th>注册码</th>
									<th>状态</th>
									<th>使用情况</th>
									<th>备注</th>
									<th>创建</th>
									<th aria-label="操作" />
								</tr>
							</thead>
							<tbody>
								{visible.map((row) => {
									const status = statusOf(row);
									return (
										<tr key={row.code}>
											<td>
												<code>{row.code}</code>{" "}
												<button type="button" className="link-button" onClick={() => copy(row.code, row.code)}>
													{copied === row.code ? "已复制" : "复制"}
												</button>
											</td>
											<td><span className={`badge ${status === "available" ? "passed" : ""}`}>{statusLabel[status]}</span></td>
											<td>
												{row.usedBy.length} / {row.maxUses}
												{row.usedBy.length > 0 && <div className="muted small">{row.usedBy.join(", ")}</div>}
											</td>
											<td>{row.note || <span className="muted">—</span>}</td>
											<td className="muted small" suppressHydrationWarning>
												{row.createdBy}<br />{new Date(row.createdAt).toLocaleString()}
											</td>
											<td className="row-actions">
												<button
													type="button"
													className="link-button"
													onClick={() => mutate(row.code, { method: "PATCH", body: JSON.stringify({ revoked: !row.revoked }) })}
												>
													{row.revoked ? "恢复" : "作废"}
												</button>
												<button
													type="button"
													className="link-button danger"
													onClick={() => {
														if (window.confirm(`确定删除注册码 ${row.code} 吗？已注册的账号不受影响。`)) {
															void mutate(row.code, { method: "DELETE" });
														}
													}}
												>
													删除
												</button>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	);
}
