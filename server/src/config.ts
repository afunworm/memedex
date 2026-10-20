import { join, resolve } from 'path';

/** Where the database and images live (a Docker volume in production). */
export const DATA_DIR = resolve(process.env.DATA_DIR || './data');
export const DB_PATH = join(DATA_DIR, 'memedex.sqlite');
export const IMAGES_DIR = join(DATA_DIR, 'images');
export const THUMBS_DIR = join(DATA_DIR, 'thumbs');
/** Better versions waiting for review (see ImproveService). */
export const CANDIDATES_DIR = join(DATA_DIR, 'candidates');

/** The built Angular app, served by the server (absent in local dev). */
export const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || './public');

/** Embedding model, downloaded at build time by scripts/fetch-model.mjs. */
export const MODEL_DIR = resolve(process.env.MODEL_DIR || './models');
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
/** Real-ESRGAN General x4v3 (ONNX), also downloaded by scripts/fetch-model.mjs. */
export const UPSCALE_MODEL = join(MODEL_DIR, 'real-esrgan', 'real_esrgan_general_x4v3.onnx');

/**
 * The address MemeDex is reached at from the internet, e.g. https://memedex.example.com.
 * Only needed for SerpApi (it fetches the image by URL) when it can't be worked
 * out from the request (behind a proxy that doesn't send X-Forwarded-Host).
 */
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

/** Images whose longer side is below this are "low-res". */
export const LOW_RES = 500;

export const SEARCH_PROVIDERS = [
	{ id: 'tineye', label: 'TinEye', keyHelp: 'API key from services.tineye.com' },
	{ id: 'serpapi', label: 'SerpApi (Google Lens)', keyHelp: 'API key from serpapi.com/manage-api-key' },
] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number]['id'];

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
