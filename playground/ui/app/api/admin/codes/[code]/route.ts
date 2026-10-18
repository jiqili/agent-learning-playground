import { getCurrentUser } from "@/lib/auth";
import { HttpError, isRecord, isSameOrigin, jsonError, readJsonBody } from "@/lib/http";
import { deleteRegistrationCode, setRegistrationCodeRevoked } from "@/lib/registration-codes";

type Context = RouteContext<"/api/admin/codes/[code]">;

async function authorize(request: Request): Promise<Response | undefined> {
	if (!isSameOrigin(request)) return jsonError(403, "非法来源");
	const user = await getCurrentUser();
	if (!user?.isAdmin) return jsonError(403, "需要管理员权限");
}

export async function PATCH(request: Request, { params }: Context) {
	const denied = await authorize(request);
	if (denied) return denied;

	try {
		const body = await readJsonBody(request, 1024);
		if (!isRecord(body) || typeof body.revoked !== "boolean") return jsonError(400, "缺少 revoked 字段");
		await setRegistrationCodeRevoked((await params).code, body.revoked);
		return new Response(null, { status: 204 });
	} catch (error) {
		if (error instanceof HttpError) return jsonError(error.status, error.message);
		throw error;
	}
}

export async function DELETE(request: Request, { params }: Context) {
	const denied = await authorize(request);
	if (denied) return denied;

	try {
		await deleteRegistrationCode((await params).code);
		return new Response(null, { status: 204 });
	} catch (error) {
		if (error instanceof HttpError) return jsonError(error.status, error.message);
		throw error;
	}
}
