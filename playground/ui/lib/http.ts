import "server-only";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonError(status: number, error: string): Response {
	return Response.json({ error }, { status });
}

// Rejects cross-site browser requests to cookie-authenticated mutation endpoints.
export function isSameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return true;
	const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > maxBytes) throw new HttpError(413, `请求体超过 ${Math.floor(maxBytes / 1024)} KB 限制`);
	const text = await request.text();
	if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, `请求体超过 ${Math.floor(maxBytes / 1024)} KB 限制`);
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "请求体不是合法的 JSON");
	}
}

export class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export function clientIp(request: Request): string {
	return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
	const now = Date.now();
	const bucket = buckets.get(key);
	if (!bucket || bucket.resetAt <= now) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		if (buckets.size > 10_000) {
			for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
		}
		return true;
	}
	bucket.count++;
	return bucket.count <= limit;
}
