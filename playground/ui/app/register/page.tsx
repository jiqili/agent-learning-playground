import { AuthForm } from "../components/AuthForm";

const professions = ["软件工程师", "学生", "数据科学家", "产品经理", "研究员", "教师", "设计师"];
const countries = ["中国", "美国", "日本", "韩国", "新加坡", "英国", "德国", "加拿大", "澳大利亚"];

export default function RegisterPage() {
	return (
		<main className="auth-card">
			<h1>注册</h1>
			<p className="muted">需要有效的注册码才能创建账号。</p>
			<AuthForm
				endpoint="/api/auth/register"
				submitLabel="注册并进入"
				fields={[
					[{ name: "registrationCode", label: "注册码", autoComplete: "off", maxLength: 128 }],
					[
						{ name: "username", label: "用户名", autoComplete: "username", minLength: 3, maxLength: 32, placeholder: "字母、数字、_ 或 -" },
						{ name: "email", label: "邮箱", type: "email", autoComplete: "email", maxLength: 254 },
					],
					[{ name: "password", label: "密码", type: "password", autoComplete: "new-password", minLength: 8, maxLength: 128, placeholder: "至少 8 位" }],
					[
						{ name: "profession", label: "职业", list: "profession-options", maxLength: 64 },
						{ name: "country", label: "国家", list: "country-options", autoComplete: "country-name", maxLength: 64 },
					],
				]}
				footer={{ text: "已有账号？", href: "/login", linkLabel: "直接登录" }}
			/>
			<datalist id="profession-options">
				{professions.map((value) => <option key={value} value={value} />)}
			</datalist>
			<datalist id="country-options">
				{countries.map((value) => <option key={value} value={value} />)}
			</datalist>
		</main>
	);
}
