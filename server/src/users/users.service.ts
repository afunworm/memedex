import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { AuthUser } from '../auth/auth.service';
import { CLAUDE_MODELS, DEFAULT_MODEL } from '../config';
import { encryptionProblem, reveal, SecretDecryptError, seal } from '../common/secret-crypto';

export interface UserSettings {
	hasApiKey: boolean;
	/** Last 4 characters of the saved key, to tell keys apart. */
	apiKeyHint: string | null;
	/** Set when the saved key can't be opened (encryption key changed). */
	apiKeyProblem: string | null;
	model: string;
	models: typeof CLAUDE_MODELS;
	/** Why keys can't be saved right now (server misconfiguration). */
	encryptionProblem: string | null;
}

@Injectable()
export class UsersService {
	private readonly seen = new Map<string, number>();

	constructor(private readonly dbs: DbService) {}

	/** Creates the user on first sight and keeps name/email fresh (at most once a minute). */
	touch(user: AuthUser) {
		const last = this.seen.get(user.sub) ?? 0;
		if (Date.now() - last < 60_000) return;
		this.seen.set(user.sub, Date.now());
		this.dbs.db
			.prepare(
				`INSERT INTO users (sub, name, email, last_seen_at) VALUES (?, ?, ?, datetime('now'))
				 ON CONFLICT(sub) DO UPDATE SET
				   name = COALESCE(excluded.name, name),
				   email = COALESCE(excluded.email, email),
				   last_seen_at = excluded.last_seen_at`,
			)
			.run(user.sub, user.name, user.email);
	}

	private row(sub: string) {
		return this.dbs.db.prepare(`SELECT claude_api_key, claude_model FROM users WHERE sub = ?`).get(sub) as
			| { claude_api_key: string | null; claude_model: string | null }
			| undefined;
	}

	settings(sub: string): UserSettings {
		const r = this.row(sub);
		let hint: string | null = null;
		let problem: string | null = null;
		if (r?.claude_api_key) {
			try {
				hint = reveal(r.claude_api_key).slice(-4);
			} catch (e) {
				problem = e instanceof SecretDecryptError ? e.message : 'The saved key could not be read';
			}
		}
		return {
			hasApiKey: !!r?.claude_api_key,
			apiKeyHint: hint,
			apiKeyProblem: problem,
			model: this.model(sub),
			models: CLAUDE_MODELS,
			encryptionProblem: encryptionProblem(),
		};
	}

	model(sub: string): string {
		const m = this.row(sub)?.claude_model;
		return m && CLAUDE_MODELS.some((x) => x.id === m) ? m : DEFAULT_MODEL;
	}

	/** The user's Claude API key in plaintext, or null when none is saved. */
	apiKey(sub: string): string | null {
		const stored = this.row(sub)?.claude_api_key;
		if (!stored) return null;
		try {
			return reveal(stored);
		} catch (e) {
			throw new BadRequestException(e instanceof SecretDecryptError ? e.message : 'Your saved API key could not be read');
		}
	}

	saveApiKey(sub: string, apiKey: string | null) {
		let stored: string | null = null;
		if (apiKey) {
			const problem = encryptionProblem();
			if (problem) throw new BadRequestException(`Can't save API keys: ${problem}`);
			stored = seal(apiKey.trim());
		}
		this.dbs.db.prepare(`UPDATE users SET claude_api_key = ? WHERE sub = ?`).run(stored, sub);
	}

	saveModel(sub: string, model: string) {
		if (!CLAUDE_MODELS.some((m) => m.id === model)) throw new BadRequestException('Unknown model');
		this.dbs.db.prepare(`UPDATE users SET claude_model = ? WHERE sub = ?`).run(model, sub);
	}
}
