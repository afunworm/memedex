import { join, resolve } from 'path';

/** Where the database and images live (a Docker volume in production). */
export const DATA_DIR = resolve(process.env.DATA_DIR || './data');
export const DB_PATH = join(DATA_DIR, 'memedex.sqlite');
export const IMAGES_DIR = join(DATA_DIR, 'images');
export const THUMBS_DIR = join(DATA_DIR, 'thumbs');

/** The built Angular app, served by the server (absent in local dev). */
export const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || './public');

/** Embedding model, downloaded at build time by scripts/fetch-model.mjs. */
export const MODEL_DIR = resolve(process.env.MODEL_DIR || './models');
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

export const OIDC_ISSUER = (process.env.OIDC_ISSUER || '').replace(/\/+$/, '');
export const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || '';

/** Largest upload accepted, per file. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Claude models a user can pick in Settings. The first is the default. */
export const CLAUDE_MODELS = [
	{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
	{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)' },
	{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
];
export const DEFAULT_MODEL = CLAUDE_MODELS[0].id;
