import { Suspense } from "react";
import { requireAdmin } from "@/lib/auth";
import { listRegistrationCodes } from "@/lib/registration-codes";
import { AdminCodes } from "./AdminCodes";

export default function AdminPage() {
	return (
		<main className="page">
			<h1 style={{ marginTop: 0 }}>注册码管理</h1>
			<Suspense fallback={<p className="muted">加载中…</p>}>
				<AdminContent />
			</Suspense>
		</main>
	);
}

async function AdminContent() {
	await requireAdmin();
	return <AdminCodes codes={await listRegistrationCodes()} />;
}
