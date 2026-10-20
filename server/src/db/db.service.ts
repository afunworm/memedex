import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { DATA_DIR, DB_PATH, IMAGES_DIR, THUMBS_DIR } from '../config';

/** Each entry runs once, in order; the index is stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
	`
	CREATE TABLE users (
		sub TEXT PRIMARY KEY,              -- OIDC subject
		name TEXT,                         -- display name from the token / userinfo
		email TEXT,
		claude_api_key TEXT,               -- encrypted (enc:v1:...), never sent to the browser
		claude_model TEXT,                 -- model id picked in Settings (null = default)
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_seen_at TEXT
	);

	CREATE TABLE memes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
		sha256 TEXT NOT NULL,              -- of the original file; also its file name on disk
		ext TEXT NOT NULL,                 -- jpg | png | webp | gif
		mime TEXT NOT NULL,
		width INTEGER,
		height INTEGER,
		animated INTEGER NOT NULL DEFAULT 0,
		bytes INTEGER NOT NULL,
		original_name TEXT,
		title TEXT,                        -- short name (AI or user)
		ocr_text TEXT,                     -- text written on the image (AI)
		ai_status TEXT NOT NULL DEFAULT 'none', -- none | queued | running | done | error
		ai_error TEXT,
		ai_at TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (user_sub, sha256)
	);
	CREATE INDEX memes_user_created ON memes(user_sub, created_at DESC);

	-- One row per description line; each has its own embedding so a search
	-- matches the single best line, not a blurred average of all of them.
	CREATE TABLE meme_descriptions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		meme_id INTEGER NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
		text TEXT NOT NULL,
		source TEXT NOT NULL DEFAULT 'user', -- user | ai
		position INTEGER NOT NULL DEFAULT 0,
		embedding BLOB                     -- Float32 x 384, L2-normalised (null until computed)
	);
	CREATE INDEX meme_descriptions_meme ON meme_descriptions(meme_id);

	CREATE TABLE meme_tags (
		meme_id INTEGER NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
		tag TEXT NOT NULL,                 -- lower case
		PRIMARY KEY (meme_id, tag)
	);
	CREATE INDEX meme_tags_tag ON meme_tags(tag);

	-- Keyword index; rowid = memes.id. Rebuilt per meme by MemesService.reindex().
	CREATE VIRTUAL TABLE memes_fts USING fts5(body, tokenize = 'porter unicode61');
	`,
	`
	-- 128-bit difference hash (32 hex chars) of the first frame; near-identical
	-- images (other resolution / format / compression) differ in only a few bits.
	-- Filled in at upload, and at startup for older rows.
	ALTER TABLE memes ADD COLUMN phash TEXT /* see DuplicatesService */;
	-- 32x32 RGB of the first frame (3072 bytes): the close-up check for pairs the hash flags
	ALTER TABLE memes ADD COLUMN sig BLOB /* see DuplicatesService */;

	-- Pairs the user marked "not duplicates", so they aren't suggested again (a < b).
	CREATE TABLE duplicate_ignores (
		a INTEGER NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
		b INTEGER NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
		PRIMARY KEY (a, b)
	);
	`,
];

@Injectable()
export class DbService implements OnModuleDestroy {
	private readonly logger = new Logger('Database');
	readonly db: Database.Database;

	constructor() {
		for (const dir of [DATA_DIR, IMAGES_DIR, THUMBS_DIR]) mkdirSync(dir, { recursive: true });
		this.db = new Database(DB_PATH);
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('foreign_keys = ON');
		this.db.pragma('busy_timeout = 5000');
		this.migrate();
	}

	onModuleDestroy() {
		this.db.close();
	}

	private migrate() {
		const current = this.db.pragma('user_version', { simple: true }) as number;
		for (let v = current; v < MIGRATIONS.length; v++) {
			this.db.transaction(() => {
				this.db.exec(MIGRATIONS[v]);
				this.db.pragma(`user_version = ${v + 1}`);
			})();
			this.logger.log(`Applied migration ${v + 1}`);
		}
	}
}
