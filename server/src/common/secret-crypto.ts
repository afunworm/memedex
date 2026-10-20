import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'crypto';

/**
 * Secrets (each user's Claude API key) are encrypted at rest with AES-256-GCM,
 * so the database file and its backups only hold ciphertext. The key comes
 * from SETTINGS_ENCRYPTION_KEY in the server env (at least 32 characters,
 * e.g. `openssl rand -base64 32`).
 *
 * Stored form: 'enc:v1:' + base64url(iv[12] | tag[16] | ciphertext).
 * Changing or losing the key means everyone re-enters their API key in
 * Settings (there's no old-key fallback: one key per user is cheap to redo).
 */

const PREFIX = 'enc:v1:';
const AAD = Buffer.from('memedex-secrets');
const MIN_KEY_LENGTH = 32;

const derived = new Map<string, Buffer>();
function derive(secret: string, salt: string): Buffer {
	const id = `${salt}:${secret}`;
	let k = derived.get(id);
	if (!k) {
		k = scryptSync(secret, salt, 32);
		derived.set(id, k);
	}
	return k;
}

function envKey(name: string): Buffer | null {
	const v = (process.env[name] ?? '').trim();
	return v.length >= MIN_KEY_LENGTH ? derive(v, 'memedex-secrets-v1') : null;
}

/** Why secrets can't be saved (null = they can). */
export function encryptionProblem(): string | null {
	const v = (process.env.SETTINGS_ENCRYPTION_KEY ?? '').trim();
	if (!v) return 'SETTINGS_ENCRYPTION_KEY is not set on the server';
	if (v.length < MIN_KEY_LENGTH) return `SETTINGS_ENCRYPTION_KEY is too short (at least ${MIN_KEY_LENGTH} characters)`;
	return null;
}

export function isEncrypted(value: string | null | undefined): boolean {
	return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plain: string, key: Buffer): string {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key, iv);
	c.setAAD(AAD);
	const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

function decryptWith(value: string, key: Buffer): string {
	const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
	const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	d.setAAD(AAD);
	d.setAuthTag(raw.subarray(12, 28));
	return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** Encrypts a secret for storage. Throws when there's no usable key. */
export function seal(plain: string): string {
	const k = envKey('SETTINGS_ENCRYPTION_KEY');
	if (!k) throw new Error(encryptionProblem() ?? 'No encryption key');
	return encrypt(plain, k);
}

export class SecretDecryptError extends Error {}

/** The plaintext of a stored secret. Throws SecretDecryptError when the key doesn't open it. */
export function reveal(value: string): string {
	if (!isEncrypted(value)) throw new SecretDecryptError('Stored secret is not encrypted');
	const k = envKey('SETTINGS_ENCRYPTION_KEY');
	if (k) {
		try {
			return decryptWith(value, k);
		} catch {
			/* sealed with a different key */
		}
	}
	throw new SecretDecryptError(
		'Your saved API key could not be decrypted: SETTINGS_ENCRYPTION_KEY changed. Enter it again in Settings.',
	);
}

/** HMAC for signed image URLs. Keyed separately from the encryption key. */
export function sign(data: string, fallbackSecret: string): string {
	const v = (process.env.SETTINGS_ENCRYPTION_KEY ?? '').trim();
	const key = v.length >= MIN_KEY_LENGTH ? derive(v, 'memedex-url-signing-v1') : Buffer.from(fallbackSecret);
	return createHmac('sha256', key).update(data).digest('base64url').slice(0, 32);
}
