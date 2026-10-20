import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { CANDIDATES_DIR, DATA_DIR, IMAGES_DIR, THUMBS_DIR } from '../config';
import { sign } from '../common/secret-crypto';

const FORMATS: Record<string, { ext: string; mime: string }> = {
	jpeg: { ext: 'jpg', mime: 'image/jpeg' },
	png: { ext: 'png', mime: 'image/png' },
	webp: { ext: 'webp', mime: 'image/webp' },
	gif: { ext: 'gif', mime: 'image/gif' },
};

export interface StoredImage {
	sha256: string;
	ext: string;
	mime: string;
	width: number | null;
	height: number | null;
	animated: boolean;
	bytes: number;
	phash: string;
	sig: Buffer;
}

/** full / thumb: a meme (id = meme id); cand: a better version awaiting review (id = candidate id). */
export type ImageKind = 'full' | 'thumb' | 'cand';

/** Signed image URLs stay the same for this long, so browsers can cache them. */
const URL_WINDOW_MS = 6 * 3600_000;

@Injectable()
export class ImageStore {
	/** Signs URLs when SETTINGS_ENCRYPTION_KEY isn't set (kept across restarts). */
	private readonly fallbackSecret: string;

	constructor() {
		const file = join(DATA_DIR, '.url-secret');
		if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
		this.fallbackSecret = readFileSync(file, 'utf8').trim();
	}

	/** Folder per user, named by a hash of their subject. */
	private userDir(sub: string) {
		return createHash('sha256').update(sub).digest('hex').slice(0, 16);
	}

	fullPath(sub: string, sha: string, ext: string) {
		return join(IMAGES_DIR, this.userDir(sub), `${sha}.${ext}`);
	}

	thumbPath(sub: string, sha: string) {
		return join(THUMBS_DIR, this.userDir(sub), `${sha}.webp`);
	}

	/** Folder for one meme's better versions awaiting review. */
	candidateDir(memeId: number) {
		return join(CANDIDATES_DIR, String(memeId));
	}

	async removeCandidates(memeId: number) {
		await rm(this.candidateDir(memeId), { recursive: true, force: true });
	}

	/** Checks the file really is a supported image, then writes it and its thumbnail. */
	async save(sub: string, buf: Buffer): Promise<StoredImage> {
		let meta: sharp.Metadata;
		try {
			meta = await sharp(buf, { animated: true }).metadata();
		} catch {
			throw new BadRequestException('Not an image');
		}
		const fmt = FORMATS[meta.format ?? ''];
		if (!fmt) throw new BadRequestException('Only JPG, PNG, WebP and GIF images are supported');

		const sha = createHash('sha256').update(buf).digest('hex');
		const full = this.fullPath(sub, sha, fmt.ext);
		mkdirSync(join(IMAGES_DIR, this.userDir(sub)), { recursive: true });
		mkdirSync(join(THUMBS_DIR, this.userDir(sub)), { recursive: true });
		if (!existsSync(full)) writeFileSync(full, buf);

		const animated = (meta.pages ?? 1) > 1;
		await sharp(buf, { animated })
			.rotate()
			.resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: 78 })
			.toFile(this.thumbPath(sub, sha));

		return {
			sha256: sha,
			ext: fmt.ext,
			mime: fmt.mime,
			width: meta.width ?? null,
			// For animations sharp reports the height of all frames stacked
			height: meta.pageHeight ?? meta.height ?? null,
			animated,
			bytes: buf.length,
			phash: await this.phash(buf),
			sig: await this.signature(buf),
		};
	}

	/**
	 * Perceptual fingerprint for finding near-duplicates: the first frame is
	 * shrunk to 9x9 greyscale, and each bit says whether a pixel is darker than
	 * its right neighbour (64 bits) or the one below (64 bits). Resizing,
	 * re-encoding or format changes flip at most a few of the 128 bits.
	 */
	/** 32x32 RGB thumbnail of the first frame, stretched to a square: compared pixel by pixel. */
	signature(input: Buffer | string): Promise<Buffer> {
		return sharp(input, { animated: false })
			.rotate()
			.flatten({ background: '#ffffff' })
			.resize(32, 32, { fit: 'fill', kernel: 'lanczos3' })
			.removeAlpha()
			.raw()
			.toBuffer();
	}

	async phash(input: Buffer | string): Promise<string> {
		const px = await sharp(input, { animated: false })
			.rotate()
			.flatten({ background: '#ffffff' })
			.greyscale()
			.resize(9, 9, { fit: 'fill', kernel: 'lanczos3' })
			.raw()
			.toBuffer();
		const bits: number[] = [];
		for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) bits.push(px[r * 9 + c] < px[r * 9 + c + 1] ? 1 : 0);
		for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) bits.push(px[r * 9 + c] < px[(r + 1) * 9 + c] ? 1 : 0);
		let hex = '';
		for (let i = 0; i < 128; i += 4) hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
		return hex;
	}

	async remove(sub: string, sha: string, ext: string) {
		await rm(this.fullPath(sub, sha, ext), { force: true });
		await rm(this.thumbPath(sub, sha), { force: true });
	}

	/** The image as Claude should see it: first frame, at most 1568 px, JPEG or PNG. */
	async forClaude(input: Buffer | string): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' }> {
		const img = sharp(input, { animated: false })
			.rotate()
			.resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true });
		const meta = await sharp(input).metadata();
		// Keep PNG for images with transparency or sharp text; JPEG otherwise (smaller)
		if (meta.hasAlpha || meta.format === 'png') {
			return { data: (await img.png().toBuffer()).toString('base64'), mediaType: 'image/png' };
		}
		return { data: (await img.jpeg({ quality: 88 }).toBuffer()).toString('base64'), mediaType: 'image/jpeg' };
	}

	/** A URL the browser can put in <img src> without the bearer token. */
	signedUrl(id: number, sha: string, kind: ImageKind): string {
		const exp = Math.ceil(Date.now() / URL_WINDOW_MS) * URL_WINDOW_MS + URL_WINDOW_MS;
		const s = sign(`${id}:${kind}:${sha}:${exp}`, this.fallbackSecret);
		return `/api/img/${id}/${kind}?v=${sha.slice(0, 8)}&e=${exp}&s=${s}`;
	}

	verify(id: number, sha: string, kind: ImageKind, exp: number, s: string): boolean {
		if (!exp || exp < Date.now() || !s) return false;
		const expected = Buffer.from(sign(`${id}:${kind}:${sha}:${exp}`, this.fallbackSecret));
		const given = Buffer.from(s);
		return expected.length === given.length && timingSafeEqual(expected, given);
	}
}
