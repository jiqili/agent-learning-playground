import { AuthForm } from "../components/AuthForm";

export default function LoginPage() {
	return (
		<main className="auth-card">
			<h1>登录</h1>
			<p className="muted">欢迎回来，继续你的 Agent 闯关之旅。</p>
			<AuthForm
				endpoint="/api/auth/login"
				submitLabel="登录"
				fields={[
					[{ name: "username", label: "用户名", autoComplete: "username", maxLength: 32 }],
					[{ name: "password", label: "密码", type: "password", autoComplete: "current-password", maxLength: 128 }],
				]}
				footer={{ text: "还没有账号？", href: "/register", linkLabel: "使用注册码注册" }}
			/>
		</main>
	);
}
