import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { DbService } from '../db/db.service';
import { ImageStore } from '../images/image-store.service';
import { MemeRow, MemesService } from '../memes/memes.service';
import { UsersService } from '../users/users.service';
import { MAX_ASPECT_DIFF, sameImage } from '../duplicates/duplicates.service';
import { MAX_UPLOAD_BYTES, PUBLIC_URL } from '../config';
import { UpscalerService } from './upscaler.service';
import { fetchPublicImage } from './safe-fetch';
import { reverseSearch, ReverseSearchError } from './reverse-search';

/**
 * web: find a bigger copy online. enhance: AI upscale locally.
 * auto: web if a search service is set up and finds something, else enhance.
 */
export type ImproveMode = 'web' | 'enhance' | 'auto';

/** Web copies must be at least this much bigger (by pixel count) to be worth offering. */
const MIN_GAIN = 1.2;
/** How many search results to download and check before giving up. */
const MAX_DOWNLOADS = 15;
/** Bigger than this (longer side) doesn't need, or can't afford, AI upscaling. */
const MAX_ENHANCE_INPUT = 1200;
/** Upscaled results are scaled down to at most this (longer side). */
const MAX_ENHANCE_OUTPUT = 2400;
/** Jobs at once (each search or upscale). */
const CONCURRENCY = 2;

const FORMATS: Record<string, { ext: string; mime: string }> = {
	jpeg: { ext: 'jpg', mime: 'image/jpeg' },
	png: { ext: 'png', mime: 'image/png' },
	webp: { ext: 'webp', mime: 'image/webp' },
	gif: { ext: 'gif', mime: 'image/gif' },
};

export interface CandidateDto {
	id: number;
	kind: 'web' | 'enhance';
	mime: string;
	width: number;
	height: number;
	bytes: number;
	sourceUrl: string | null;
	sourcePage: string | null;
	createdAt: string;
	url: string;
}

interface CandidateRow {
	id: number;
	meme_id: number;
	kind: 'web' | 'enhance';
	file: string;
	mime: string;
	width: number;
	height: number;
	bytes: number;
	source_url: string | null;
	source_page: string | null;
	created_at: string;
}

/** Thrown when a job ran fine but there's nothing to offer (shown to the user, not logged as a failure). */
class NothingFound extends Error {}

/**
 * "Improve quality". Results are saved as candidates next to the original;
 * the original is only replaced when the user accepts one (accept()).
 */
@Injectable()
export class ImproveService implements OnApplicationBootstrap {
	private readonly logger = new Logger('Improve');
	private readonly pending: { sub: string; id: number; mode: ImproveMode; baseUrl: string | null }[] = [];
	private running = 0;

	constructor(
		private readonly dbs: DbService,
		private readonly memes: MemesService,
		private readonly images: ImageStore,
		private readonly users: UsersService,
		private readonly upscaler: UpscalerService,
	) {}

	/** Jobs live in memory; ones cut short by a restart are marked so the user can run them again. */
	onApplicationBootstrap() {
		this.dbs.db
			.prepare(
				`UPDATE memes SET improve_status = 'error', improve_error = 'Stopped by a server restart. Try again.'
				 WHERE improve_status IN ('queued', 'running')`,
			)
			.run();
	}

	enqueue(sub: string, ids: number[], mode: ImproveMode, baseUrl: string | null): number[] {
		if (mode === 'web' && !this.users.search(sub)) {
			throw new BadRequestException('Choose a reverse image search service and add its API key in Settings first');
		}
		const queued: number[] = [];
		for (const id of ids) {
			const r = this.memes.row(sub, id);
			if (r.improve_status === 'queued' || r.improve_status === 'running') continue;
			this.memes.setImproveStatus(id, 'queued');
			this.pending.push({ sub, id, mode, baseUrl });
			queued.push(id);
		}
		this.pump();
		return queued;
	}

	private pump() {
		while (this.running < CONCURRENCY && this.pending.length) {
			const job = this.pending.shift()!;
			this.running++;
			this.run(job).finally(() => {
				this.running--;
				this.pump();
			});
		}
	}

	private async run(job: { sub: string; id: number; mode: ImproveMode; baseUrl: string | null }) {
		let r: MemeRow;
		try {
			r = this.memes.row(job.sub, job.id);
		} catch {
			return; // deleted while queued
		}
		this.memes.setImproveStatus(job.id, 'running');
		try {
			if (job.mode === 'enhance') {
				await this.enhance(job.sub, r);
			} else if (job.mode === 'web') {
				await this.web(job.sub, r, job.baseUrl);
			} else {
				// auto: a real copy beats an AI guess, so try the web first when it's set up
				let found = false;
				if (this.users.search(job.sub)) {
					try {
						await this.web(job.sub, r, job.baseUrl);
						found = true;
					} catch (e) {
						if (!(e instanceof NothingFound) && !(e instanceof ReverseSearchError)) throw e;
					}
				}
				if (!found) await this.enhance(job.sub, r);
			}
			this.memes.setImproveStatus(job.id, 'done');
		} catch (e: any) {
			const message = e?.response?.message ?? e?.message ?? 'Failed';
			this.memes.setImproveStatus(job.id, 'error', String(message).slice(0, 500));
			if (!(e instanceof NothingFound)) this.logger.warn(`Meme ${job.id}: ${message}`);
		}
	}

	/** Reverse image search, then download candidates and keep the biggest that is truly the same picture. */
	private async web(sub: string, r: MemeRow, baseUrl: string | null) {
		const search = this.users.search(sub);
		if (!search) throw new NothingFound('No reverse image search service is set up in Settings');
		const original = this.images.fullPath(sub, r.sha256, r.ext);
		const jpeg = await sharp(original, { animated: false }).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
		const publicUrl = baseUrl ? baseUrl + this.images.signedUrl(r.id, r.sha256, 'full') : null;

		const matches = await reverseSearch(search.provider, search.apiKey, { jpeg, publicUrl });
		const area = (r.width ?? 0) * (r.height ?? 0);
		const aspect = r.width && r.height ? r.width / r.height : 1;
		const seen = new Set<string>();
		const bigger = matches
			.filter((m) => m.width * m.height >= area * MIN_GAIN)
			.filter((m) => Math.abs(m.width / m.height - aspect) / Math.max(m.width / m.height, aspect) <= MAX_ASPECT_DIFF)
			.filter((m) => !seen.has(m.imageUrl) && seen.add(m.imageUrl))
			.sort((a, b) => b.width * b.height - a.width * a.height);
		if (!bigger.length) {
			throw new NothingFound(matches.length ? 'Copies were found online, but none bigger than yours' : 'No copies found online');
		}

		const mySig = await this.images.signature(original);
		for (const m of bigger.slice(0, MAX_DOWNLOADS)) {
			let buf: Buffer;
			let meta: sharp.Metadata;
			try {
				buf = await fetchPublicImage(m.imageUrl, MAX_UPLOAD_BYTES);
				meta = await sharp(buf, { animated: true }).metadata();
			} catch {
				continue; // gone, blocked, not an image, too big
			}
			const fmt = FORMATS[meta.format ?? ''];
			const w = meta.width ?? 0;
			const h = meta.pageHeight ?? meta.height ?? 0;
			if (!fmt || w * h < area * MIN_GAIN) continue;
			// The same check as the duplicate finder: rejects crops, edits and look-alikes
			if (!sameImage(mySig, await this.images.signature(buf))) continue;
			await this.saveCandidate(r.id, 'web', buf, fmt, w, h, m.imageUrl, m.pageUrl);
			return;
		}
		throw new NothingFound('Bigger look-alikes were found online, but none was exactly the same picture');
	}

	private async enhance(sub: string, r: MemeRow) {
		if (r.animated) throw new NothingFound("Animated GIFs can't be enhanced (the animation would be lost)");
		if (Math.max(r.width ?? 0, r.height ?? 0) > MAX_ENHANCE_INPUT) {
			throw new NothingFound(`Already large (over ${MAX_ENHANCE_INPUT} px); AI enhance is for small images`);
		}
		const up = await this.upscaler.upscale(this.images.fullPath(sub, r.sha256, r.ext));
		let img = sharp(up.data, { raw: { width: up.width, height: up.height, channels: up.channels } });
		let { width, height } = up;
		if (Math.max(width, height) > MAX_ENHANCE_OUTPUT) {
			img = img.resize({ width: MAX_ENHANCE_OUTPUT, height: MAX_ENHANCE_OUTPUT, fit: 'inside', kernel: 'lanczos3' });
			const k = MAX_ENHANCE_OUTPUT / Math.max(width, height);
			width = Math.round(width * k);
			height = Math.round(height * k);
		}
		// Keep the original's kind of file: photos stay JPEG, graphics PNG
		let fmt = FORMATS.png;
		let buf: Buffer;
		if (r.ext === 'jpg') {
			fmt = FORMATS.jpeg;
			buf = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
		} else if (r.ext === 'webp') {
			fmt = FORMATS.webp;
			buf = await img.webp({ quality: 92 }).toBuffer();
		} else {
			buf = await img.png({ compressionLevel: 7 }).toBuffer();
		}
		await this.saveCandidate(r.id, 'enhance', buf, fmt, width, height, null, null);
	}

	/** Stores a better version for review, replacing an older one of the same kind. */
	private async saveCandidate(
		memeId: number,
		kind: 'web' | 'enhance',
		buf: Buffer,
		fmt: { ext: string; mime: string },
		width: number,
		height: number,
		sourceUrl: string | null,
		sourcePage: string | null,
	) {
		const dir = this.images.candidateDir(memeId);
		mkdirSync(dir, { recursive: true });
		for (const old of this.dbs.db
			.prepare(`SELECT id, file FROM meme_candidates WHERE meme_id = ? AND kind = ?`)
			.all(memeId, kind) as { id: number; file: string }[]) {
			await rm(join(dir, old.file), { force: true });
			this.dbs.db.prepare(`DELETE FROM meme_candidates WHERE id = ?`).run(old.id);
		}
		const file = `${Date.now()}-${kind}.${fmt.ext}`;
		writeFileSync(join(dir, file), buf);
		this.dbs.db
			.prepare(
				`INSERT INTO meme_candidates (meme_id, kind, file, mime, width, height, bytes, source_url, source_page)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(memeId, kind, file, fmt.mime, width, height, buf.length, sourceUrl, sourcePage);
	}

	candidates(sub: string, memeId: number): CandidateDto[] {
		this.memes.row(sub, memeId);
		const rows = this.dbs.db
			.prepare(`SELECT * FROM meme_candidates WHERE meme_id = ? ORDER BY kind = 'web' DESC, id DESC`)
			.all(memeId) as CandidateRow[];
		return rows.map((c) => ({
			id: c.id,
			kind: c.kind,
			mime: c.mime,
			width: c.width,
			height: c.height,
			bytes: c.bytes,
			sourceUrl: c.source_url,
			sourcePage: c.source_page,
			createdAt: c.created_at,
			url: this.images.signedUrl(c.id, c.file, 'cand'),
		}));
	}

	private candidate(sub: string, memeId: number, candidateId: number): CandidateRow {
		this.memes.row(sub, memeId);
		const c = this.dbs.db
			.prepare(`SELECT * FROM meme_candidates WHERE id = ? AND meme_id = ?`)
			.get(candidateId, memeId) as CandidateRow | undefined;
		if (!c) throw new NotFoundException('That version is no longer available');
		return c;
	}

	/** The user confirmed: the candidate becomes the meme's image. */
	accept(sub: string, memeId: number, candidateId: number) {
		const c = this.candidate(sub, memeId, candidateId);
		const buf = readFileSync(join(this.images.candidateDir(memeId), c.file));
		return this.memes.replaceImage(sub, memeId, buf);
	}

	async discard(sub: string, memeId: number, candidateId: number) {
		const c = this.candidate(sub, memeId, candidateId);
		await rm(join(this.images.candidateDir(memeId), c.file), { force: true });
		this.dbs.db.prepare(`DELETE FROM meme_candidates WHERE id = ?`).run(c.id);
		const left = this.dbs.db.prepare(`SELECT COUNT(*) n FROM meme_candidates WHERE meme_id = ?`).get(memeId) as { n: number };
		if (!left.n) this.memes.setImproveStatus(memeId, 'none');
		return this.memes.dtos(sub, [memeId])[0];
	}

	/** Where MemeDex is reachable from the internet (SerpApi fetches the image from there). */
	static baseUrl(req: { protocol: string; get(name: string): string | undefined }): string | null {
		if (PUBLIC_URL) return PUBLIC_URL;
		const host = req.get('host') ?? '';
		if (!host || /^(localhost|127\.|\[::1\])/i.test(host)) return null;
		return `${req.protocol}://${host}`;
	}
}
