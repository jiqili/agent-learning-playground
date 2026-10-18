import { endSession } from "@/lib/auth";
import { isSameOrigin, jsonError } from "@/lib/http";

export async function POST(request: Request) {
	if (!isSameOrigin(request)) return jsonError(403, "非法来源");
	await endSession();
	return new Response(null, { status: 204 });
}
