import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only; pages and route handlers re-validate the session.
export function proxy(request: NextRequest) {
	if (!request.cookies.has("alp_session")) {
		return NextResponse.redirect(new URL("/login", request.url));
	}
	return NextResponse.next();
}

export const config = {
	matcher: ["/chapters/:path*", "/admin/:path*"],
};
