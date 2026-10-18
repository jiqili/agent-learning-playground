import { registerUser, startSession, validateRegistration } from "@/lib/auth";
import { clientIp, HttpError, isSameOrigin, jsonError, rateLimit, readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
	if (!isSameOrigin(request)) return jsonError(403, "非法来源");
	if (!rateLimit(`register:${clientIp(request)}`, 10, 60 * 60 * 1000)) {
		return jsonError(429, "注册尝试过于频繁，请稍后再试");
	}

	try {
		const input = validateRegistration(await readJsonBody(request, 16 * 1024));
		const user = await registerUser(input);
		await startSession(user.id, request);
		return Response.json({ user: { username: user.username } }, { status: 201 });
	} catch (error) {
		if (error instanceof HttpError) return jsonError(error.status, error.message);
		throw error;
	}
}
