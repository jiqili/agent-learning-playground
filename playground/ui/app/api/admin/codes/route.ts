import { getCurrentUser } from "@/lib/auth";
import { HttpError, isRecord, isSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import { generateRegistrationCodes } from "@/lib/registration-codes";

export async function POST(request: Request) {
	if (!isSameOrigin(request)) return jsonError(403, "非法来源");
	const user = await getCurrentUser();
	if (!user?.isAdmin) return jsonError(403, "需要管理员权限");

	try {
		const body = await readJsonBody(request, 4 * 1024);
		if (!isRecord(body)) return jsonError(400, "请求体格式错误");
		const count = Number(body.count);
		const maxUses = Number(body.maxUses);
		const note = typeof body.note === "string" ? body.note.trim() : "";
		if (!Number.isInteger(count) || count < 1 || count > 100) return jsonError(400, "数量需为 1-100 的整数");
		if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) return jsonError(400, "可用次数需为 1-1000 的整数");
		if (note.length > 100) return jsonError(400, "备注不能超过 100 字");

		const codes = await generateRegistrationCodes(user.username, { count, maxUses, note });
		return Response.json({ codes }, { status: 201 });
	} catch (error) {
		if (error instanceof HttpError) return jsonError(error.status, error.message);
		throw error;
	}
}
