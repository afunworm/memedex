import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { AuthUser } from '../auth/auth.service';
import { CLAUDE_MODELS, DEFAULT_MODEL, SEARCH_PROVIDERS, SearchProvider } from '../config';
import { encryptionProblem, reveal, SecretDecryptError, seal } from '../common/secret-crypto';

export interface UserSettings {
	hasApiKey: boolean;
	/** Last 4 characters of the saved key, to tell keys apart. */
	apiKeyHint: string | null;
	/** Set when the saved key can't be opened (encryption key changed). */
	apiKeyProblem: string | null;
	model: string;
	models: typeof CLAUDE_MODELS;
	/** Reverse image search ("find a better copy online"). */
	search: {
		provider: SearchProvider | null;
		hasKey: boolean;
		keyHint: string | null;
		keyProblem: string | null;
	};
	searchProviders: typeof SEARCH_PROVIDERS;
	/** Why keys can't be saved right now (server misconfiguration). */
	encryptionProblem: string | null;
}

interface UserRow {
	claude_api_key: string | null;
	claude_model: string | null;
	search_provider: string | null;
	search_api_key: string | null;
}

/** Last 4 characters of a stored secret, or why it can't be opened. */
function describeSecret(stored: string | null): { hint: string | null; problem: string | null } {
	if (!stored) return { hint: null, problem: null };
	try {
		return { hint: reveal(stored).slice(-4), problem: null };
	} catch (e) {
		return { hint: null, problem: e instanceof SecretDecryptError ? e.message : 'The saved key could not be read' };
	}
}

function openSecret(stored: string | null | undefined): string | null {
	if (!stored) return null;
	try {
		return reveal(stored);
	} catch (e) {
		throw new BadRequestException(e instanceof SecretDecryptError ? e.message : 'Your saved API key could not be read');
	}
}

function sealSecret(value: string | null): string | null {
	if (!value) return null;
	const problem = encryptionProblem();
	if (problem) throw new BadRequestException(`Can't save API keys: ${problem}`);
	return seal(value.trim());
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
		return this.dbs.db
			.prepare(`SELECT claude_api_key, claude_model, search_provider, search_api_key FROM users WHERE sub = ?`)
			.get(sub) as UserRow | undefined;
	}

	settings(sub: string): UserSettings {
		const r = this.row(sub);
		const claude = describeSecret(r?.claude_api_key ?? null);
		const search = describeSecret(r?.search_api_key ?? null);
		return {
			hasApiKey: !!r?.claude_api_key,
			apiKeyHint: claude.hint,
			apiKeyProblem: claude.problem,
			model: this.model(sub),
			models: CLAUDE_MODELS,
			search: {
				provider: this.searchProvider(sub),
				hasKey: !!r?.search_api_key,
				keyHint: search.hint,
				keyProblem: search.problem,
			},
			searchProviders: SEARCH_PROVIDERS,
			encryptionProblem: encryptionProblem(),
		};
	}

	model(sub: string): string {
		const m = this.row(sub)?.claude_model;
		return m && CLAUDE_MODELS.some((x) => x.id === m) ? m : DEFAULT_MODEL;
	}

	/** The user's Claude API key in plaintext, or null when none is saved. */
	apiKey(sub: string): string | null {
		return openSecret(this.row(sub)?.claude_api_key);
	}

	saveApiKey(sub: string, apiKey: string | null) {
		this.dbs.db.prepare(`UPDATE users SET claude_api_key = ? WHERE sub = ?`).run(sealSecret(apiKey), sub);
	}

	saveModel(sub: string, model: string) {
		if (!CLAUDE_MODELS.some((m) => m.id === model)) throw new BadRequestException('Unknown model');
		this.dbs.db.prepare(`UPDATE users SET claude_model = ? WHERE sub = ?`).run(model, sub);
	}

	searchProvider(sub: string): SearchProvider | null {
		const p = this.row(sub)?.search_provider;
		return SEARCH_PROVIDERS.some((x) => x.id === p) ? (p as SearchProvider) : null;
	}

	/** Provider and key for reverse image search, or null when not set up. */
	search(sub: string): { provider: SearchProvider; apiKey: string } | null {
		const provider = this.searchProvider(sub);
		const apiKey = openSecret(this.row(sub)?.search_api_key);
		return provider && apiKey ? { provider, apiKey } : null;
	}

	saveSearch(sub: string, provider: string | undefined, apiKey: string | null | undefined) {
		if (provider !== undefined) {
			if (!SEARCH_PROVIDERS.some((p) => p.id === provider)) throw new BadRequestException('Unknown search service');
			// A key belongs to one service: switching services clears it
			if (provider !== this.searchProvider(sub) && apiKey === undefined) apiKey = null;
			this.dbs.db.prepare(`UPDATE users SET search_provider = ? WHERE sub = ?`).run(provider, sub);
		}
		if (apiKey !== undefined) {
			this.dbs.db.prepare(`UPDATE users SET search_api_key = ? WHERE sub = ?`).run(sealSecret(apiKey), sub);
		}
	}
}
