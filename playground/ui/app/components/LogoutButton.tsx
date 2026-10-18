"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
	const router = useRouter();
	const [pending, setPending] = useState(false);

	async function logout() {
		setPending(true);
		await fetch("/api/auth/logout", { method: "POST" });
		router.push("/login");
		router.refresh();
	}

	return (
		<button type="button" className="button secondary sm" onClick={logout} disabled={pending}>
			退出
		</button>
	);
}
