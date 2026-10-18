import "server-only";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { readDb, updateDb, type UserRecord } from "./db";
import { HttpError } from "./http";

export const SESSION_COOKIE = "alp_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export interface PublicUser {
	id: string;
	username: string;
	email: string;
	profession: string;
	country: string;
	isAdmin: boolean;
}

export interface RegistrationInput {
	registrationCode: string;
	username: string;
	password: string;
	email: string;
	profession: string;
	country: string;
}

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await scryptAsync(password, salt, 64);
	return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, saltB64, keyB64] = stored.split("$");
	if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
	const expected = Buffer.from(keyB64, "base64");
	const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length);
	return timingSafeEqual(actual, expected);
}

// Used when the username does not exist so login timing does not reveal valid usernames.
const dummyHashPromise = hashPassword(randomUUID());

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function allowedRegistrationCodes(): Set<string> {
	return new Set(
		(process.env.REGISTRATION_CODES ?? "")
			.split(",")
			.map((code) => code.trim())
			.filter(Boolean),
	);
}

function toPublicUser(user: UserRecord): PublicUser {
	const admins = (process.env.ADMIN_USERNAMES ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		profession: user.profession,
		country: user.country,
		isAdmin: admins.includes(user.username.toLowerCase()),
	};
}

export function validateRegistration(body: unknown): RegistrationInput {
	const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	const field = (name: string) => (typeof input[name] === "string" ? (input[name] as string).trim() : "");
	const result: RegistrationInput = {
		registrationCode: field("registrationCode"),
		username: field("username"),
		password: typeof input.password === "string" ? input.password : "",
		email: field("email").toLowerCase(),
		profession: field("profession"),
		country: field("country"),
	};

	if (!result.registrationCode) throw new HttpError(400, "请填写注册码");
	if (!/^[A-Za-z0-9_-]{3,32}$/.test(result.username)) {
		throw new HttpError(400, "用户名需为 3-32 位字母、数字、下划线或连字符");
	}
	if (result.password.length < 8 || result.password.length > 128) {
		throw new HttpError(400, "密码长度需为 8-128 位");
	}
	if (result.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) {
		throw new HttpError(400, "邮箱格式不正确");
	}
	if (!result.profession || result.profession.length > 64) throw new HttpError(400, "请填写职业（不超过 64 字）");
	if (!result.country || result.country.length > 64) throw new HttpError(400, "请填写国家（不超过 64 字）");
	return result;
}

export async function registerUser(input: RegistrationInput): Promise<PublicUser> {
	const passwordHash = await hashPassword(input.password);
	const allowedCodes = allowedRegistrationCodes();

	return updateDb((db) => {
		const storedCode = db.registrationCodes.find((record) => record.code === input.registrationCode.toUpperCase());
		const codeUsable = storedCode
			? !storedCode.revoked && storedCode.usedBy.length < storedCode.maxUses
			: allowedCodes.has(input.registrationCode) && !db.usedRegistrationCodes.includes(input.registrationCode);
		if (!codeUsable) {
			throw new HttpError(400, "注册码无效或已被使用");
		}
		const username = input.username.toLowerCase();
		if (db.users.some((user) => user.username.toLowerCase() === username)) {
			throw new HttpError(409, "用户名已被占用");
		}
		if (db.users.some((user) => user.email === input.email)) {
			throw new HttpError(409, "邮箱已被注册");
		}

		const user: UserRecord = {
			id: randomUUID(),
			username: input.username,
			email: input.email,
			profession: input.profession,
			country: input.country,
			passwordHash,
			registrationCode: input.registrationCode,
			createdAt: new Date().toISOString(),
		};
		db.users.push(user);
		if (storedCode) storedCode.usedBy.push(user.username);
		else db.usedRegistrationCodes.push(input.registrationCode);
		return toPublicUser(user);
	});
}

export async function authenticate(username: string, password: string): Promise<PublicUser | undefined> {
	const normalized = username.trim().toLowerCase();
	const user = await readDb((db) => db.users.find((candidate) => candidate.username.toLowerCase() === normalized));
	const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyHashPromise));
	return user && valid ? toPublicUser(user) : undefined;
}

export async function startSession(userId: string, request: Request): Promise<void> {
	const token = randomBytes(32).toString("base64url");
	const expiresAt = Date.now() + SESSION_TTL_MS;
	await updateDb((db) => {
		const now = Date.now();
		db.sessions = db.sessions.filter((session) => session.expiresAt > now);
		db.sessions.push({ tokenHash: hashToken(token), userId, expiresAt });
	});
	(await cookies()).set(SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "lax",
		secure: (request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")) === "https",
		path: "/",
		expires: new Date(expiresAt),
	});
}

export async function endSession(): Promise<void> {
	const cookieStore = await cookies();
	const token = cookieStore.get(SESSION_COOKIE)?.value;
	if (token) {
		const tokenHash = hashToken(token);
		await updateDb((db) => {
			db.sessions = db.sessions.filter((session) => session.tokenHash !== tokenHash);
		});
	}
	cookieStore.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<PublicUser | undefined> {
	const token = (await cookies()).get(SESSION_COOKIE)?.value;
	if (!token) return undefined;
	// Session expiry depends on the current time, so this must never be prerendered.
	await connection();
	const tokenHash = hashToken(token);
	return readDb((db) => {
		const session = db.sessions.find((candidate) => candidate.tokenHash === tokenHash);
		if (!session || session.expiresAt <= Date.now()) return undefined;
		const user = db.users.find((candidate) => candidate.id === session.userId);
		return user ? toPublicUser(user) : undefined;
	});
}

export async function requireUser(): Promise<PublicUser> {
	const user = await getCurrentUser();
	if (!user) redirect("/login");
	return user;
}

export async function requireAdmin(): Promise<PublicUser> {
	const user = await requireUser();
	if (!user.isAdmin) notFound();
	return user;
}
