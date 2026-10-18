import Link from "next/link";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/auth";

export default function HomePage() {
	return (
		<main className="page">
			<section className="hero">
				<h1>从零实现一个 AI Agent</h1>
				<p className="muted">
					按章节闯关：每一关给出需求和测试用例，你在浏览器里编写代码，全部测试通过即可解锁下一关。
					第一章将带你实现一个 Mini Agent —— 调用大模型、执行工具、暴露生命周期。
				</p>
				<Suspense fallback={<div className="hero-actions" />}>
					<HeroActions />
				</Suspense>
			</section>
		</main>
	);
}

async function HeroActions() {
	const user = await getCurrentUser();
	return (
		<div className="hero-actions">
			{user ? (
				<Link href="/chapters" className="button">继续闯关</Link>
			) : (
				<>
					<Link href="/register" className="button">使用注册码注册</Link>
					<Link href="/login" className="button secondary">登录</Link>
				</>
			)}
		</div>
	);
}
