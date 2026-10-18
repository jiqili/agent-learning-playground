import { authenticate, startSession } from "@/lib/auth";
import { clientIp, HttpError, isRecord, isSameOrigin, jsonError, rateLimit, readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
	if (!isSameOrigin(request)) return jsonError(403, "非法来源");

	try {
		const body = await readJsonBody(request, 16 * 1024);
		const username = isRecord(body) && typeof body.username === "string" ? body.username.trim() : "";
		const password = isRecord(body) && typeof body.password === "string" ? body.password : "";
		if (!username || !password || password.length > 128) return jsonError(400, "请输入用户名和密码");

		const ip = clientIp(request);
		if (!rateLimit(`login:${ip}`, 30, 15 * 60 * 1000) || !rateLimit(`login:${ip}:${username.toLowerCase()}`, 8, 15 * 60 * 1000)) {
			return jsonError(429, "登录尝试过于频繁，请 15 分钟后再试");
		}

		const user = await authenticate(username, password);
		if (!user) return jsonError(401, "用户名或密码错误");
		await startSession(user.id, request);
		return Response.json({ user: { username: user.username } });
	} catch (error) {
		if (error instanceof HttpError) return jsonError(error.status, error.message);
		throw error;
	}
}
