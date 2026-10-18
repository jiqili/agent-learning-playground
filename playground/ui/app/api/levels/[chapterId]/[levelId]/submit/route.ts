import { getCurrentUser } from "@/lib/auth";
import { findLevel, levelKey } from "@/lib/curriculum";
import { HttpError, isRecord, isSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import { isLevelUnlocked, saveAttempt } from "@/lib/progress";
import { runLevelTests } from "@/lib/test-runner";

const MAX_CODE_BYTES = 100 * 1024;

export async function POST(request: Request, { params }: RouteContext<"/api/levels/[chapterId]/[levelId]/submit">) {
	if (!isSameOrigin(request)) return jsonError(403, "非法来源");
	const user = await getCurrentUser();
	if (!user) return jsonError(401, "请先登录");

	const { chapterId, levelId } = await params;
	const found = findLevel(chapterId, levelId);
	if (!found) return jsonError(404, "关卡不存在");
	if (!(await isLevelUnlocked(user.id, chapterId, levelId))) return jsonError(403, "请先通过上一关");

	try {
		const body = await readJsonBody(request, MAX_CODE_BYTES + 1024);
		if (!isRecord(body) || typeof body.code !== "string") return jsonError(400, "缺少 code 字段");
		if (Buffer.byteLength(body.code) > MAX_CODE_BYTES) return jsonError(413, "代码不能超过 100 KB");

		const result = await runLevelTests(user.id, chapterId, found.level.testFile, body.code);
		await saveAttempt(user.id, levelKey(chapterId, levelId), body.code, result.passed);
		return Response.json({ result, next: result.passed && found.next ? found.next.id : undefined });
	} catch (error) {
		if (error instanceof HttpError) return jsonError(error.status, error.message);
		throw error;
	}
}
