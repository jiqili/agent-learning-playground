import { connection } from "next/server";

export async function GET() {
	await connection();
	return Response.json({
		status: "ok",
		configured: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL),
	});
}
