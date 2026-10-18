import "server-only";
import { randomInt } from "node:crypto";
import { readDb, updateDb, type RegistrationCodeRecord } from "./db";
import { HttpError } from "./http";

// Excludes look-alike characters (0/O, 1/I/L) so codes are easy to read aloud and retype.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(): string {
	const groups = Array.from({ length: 3 }, () =>
		Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""));
	return groups.join("-");
}

export async function listRegistrationCodes(): Promise<RegistrationCodeRecord[]> {
	return readDb((db) => db.registrationCodes.map((record) => ({ ...record, usedBy: [...record.usedBy] })).reverse());
}

export async function generateRegistrationCodes(
	createdBy: string,
	options: { count: number; maxUses: number; note: string },
): Promise<string[]> {
	return updateDb((db) => {
		const existing = new Set(db.registrationCodes.map((record) => record.code));
		const createdAt = new Date().toISOString();
		const codes: string[] = [];
		while (codes.length < options.count) {
			const code = newCode();
			if (existing.has(code)) continue;
			existing.add(code);
			codes.push(code);
			db.registrationCodes.push({
				code,
				note: options.note,
				maxUses: options.maxUses,
				usedBy: [],
				revoked: false,
				createdBy,
				createdAt,
			});
		}
		return codes;
	});
}

export async function setRegistrationCodeRevoked(code: string, revoked: boolean): Promise<void> {
	await updateDb((db) => {
		const record = db.registrationCodes.find((candidate) => candidate.code === code);
		if (!record) throw new HttpError(404, "注册码不存在");
		record.revoked = revoked;
	});
}

export async function deleteRegistrationCode(code: string): Promise<void> {
	await updateDb((db) => {
		const index = db.registrationCodes.findIndex((candidate) => candidate.code === code);
		if (index < 0) throw new HttpError(404, "注册码不存在");
		db.registrationCodes.splice(index, 1);
	});
}
