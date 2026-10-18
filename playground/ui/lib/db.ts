import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface UserRecord {
	id: string;
	username: string;
	email: string;
	profession: string;
	country: string;
	passwordHash: string;
	registrationCode: string;
	createdAt: string;
}

export interface SessionRecord {
	tokenHash: string;
	userId: string;
	expiresAt: number;
}

export interface ProgressRecord {
	userId: string;
	levelKey: string;
	code: string;
	passed: boolean;
	passedAt?: string;
	updatedAt: string;
}

export interface RegistrationCodeRecord {
	code: string;
	note: string;
	maxUses: number;
	usedBy: string[];
	revoked: boolean;
	createdBy: string;
	createdAt: string;
}

interface Database {
	users: UserRecord[];
	sessions: SessionRecord[];
	registrationCodes: RegistrationCodeRecord[];
	/** Bootstrap codes from the REGISTRATION_CODES env var that have been consumed. */
	usedRegistrationCodes: string[];
	progress: ProgressRecord[];
}

const dataDir = path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? path.join(process.cwd(), ".data"));
const dbFile = path.join(dataDir, "db.json");

// Survive dev-mode module reloads so all requests share one in-memory copy and write queue.
const store = globalThis as typeof globalThis & {
	__alpDb?: { loading: Promise<Database>; queue: Promise<unknown> };
};

function state() {
	store.__alpDb ??= { loading: load(), queue: Promise.resolve() };
	return store.__alpDb;
}

async function load(): Promise<Database> {
	try {
		const parsed = JSON.parse(await readFile(dbFile, "utf8")) as Partial<Database>;
		return {
			users: parsed.users ?? [],
			sessions: parsed.sessions ?? [],
			registrationCodes: parsed.registrationCodes ?? [],
			usedRegistrationCodes: parsed.usedRegistrationCodes ?? [],
			progress: parsed.progress ?? [],
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { users: [], sessions: [], registrationCodes: [], usedRegistrationCodes: [], progress: [] };
	}
}

async function persist(db: Database): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	const tmpFile = `${dbFile}.${process.pid}.tmp`;
	await writeFile(tmpFile, JSON.stringify(db, null, "\t"), "utf8");
	await rename(tmpFile, dbFile);
}

export async function readDb<T>(reader: (db: Readonly<Database>) => T): Promise<T> {
	return reader(await state().loading);
}

export function updateDb<T>(mutator: (db: Database) => T): Promise<T> {
	const s = state();
	const next = s.queue.then(async () => {
		const db = await s.loading;
		const result = mutator(db);
		await persist(db);
		return result;
	});
	s.queue = next.catch(() => undefined);
	return next;
}
