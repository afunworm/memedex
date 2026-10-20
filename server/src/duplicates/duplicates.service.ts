import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ImageStore } from '../images/image-store.service';
import { MemeDto, MemesService } from '../memes/memes.service';

/**
 * Two checks, cheap then exact:
 * 1. The 128-bit hashes are at most MAX_DISTANCE bits apart (rules out most
 *    pairs fast, but simple images, e.g. text on a plain background, can look
 *    alike to it).
 * 2. Their 32x32 colour thumbnails match pixel by pixel: on average within
 *    MAX_MEAN_DIFF (of 255), with at most MAX_CHANGED of pixels off by more
 *    than CHANGED. Resizing and re-compressing stay well inside that; a
 *    different caption or colour doesn't.
 */
const MAX_DISTANCE = 20;
const MAX_MEAN_DIFF = 5;
const CHANGED = 48;
const MAX_CHANGED = 0.01;
/** Width/height ratios must be this close; a crop or different layout isn't a duplicate. */
export const MAX_ASPECT_DIFF = 0.12;

export interface DuplicateGroup {
	/** The suggested one to keep (largest image), listed first in items. */
	keepId: number;
	items: MemeDto[];
}

interface Candidate {
	id: number;
	hash: Uint32Array;
	sig: Buffer;
	aspect: number;
}

function parse(hex: string): Uint32Array {
	const out = new Uint32Array(4);
	for (let i = 0; i < 4; i++) out[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
	return out;
}

function popcount(n: number): number {
	n = n - ((n >>> 1) & 0x55555555);
	n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
	return Math.imul((n + (n >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function distance(a: Uint32Array, b: Uint32Array): number {
	return popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]) + popcount(a[2] ^ b[2]) + popcount(a[3] ^ b[3]);
}

/** Do two 32x32 RGB thumbnails show the same picture? */
export function sameImage(a: Buffer, b: Buffer): boolean {
	if (a.length !== b.length) return false;
	const pixels = a.length / 3;
	let total = 0;
	let changed = 0;
	for (let i = 0; i < a.length; i += 3) {
		const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
		total += d;
		if (d > CHANGED) changed++;
	}
	return total / pixels <= MAX_MEAN_DIFF && changed / pixels <= MAX_CHANGED;
}

/**
 * Finds images that are the same picture at another resolution, format or
 * compression level (identical files are already refused at upload).
 */
@Injectable()
export class DuplicatesService implements OnApplicationBootstrap {
	private readonly logger = new Logger('Duplicates');

	constructor(
		private readonly dbs: DbService,
		private readonly images: ImageStore,
		private readonly memes: MemesService,
	) {}

	/** Fingerprints images uploaded before this feature existed. */
	async onApplicationBootstrap() {
		const rows = this.dbs.db
			.prepare(`SELECT id, user_sub, sha256, ext FROM memes WHERE phash IS NULL OR sig IS NULL`)
			.all() as { id: number; user_sub: string; sha256: string; ext: string }[];
		if (!rows.length) return;
		const upd = this.dbs.db.prepare(`UPDATE memes SET phash = ?, sig = ? WHERE id = ?`);
		let done = 0;
		for (const r of rows) {
			try {
				const path = this.images.fullPath(r.user_sub, r.sha256, r.ext);
				upd.run(await this.images.phash(path), await this.images.signature(path), r.id);
				done++;
			} catch (e: any) {
				this.logger.warn(`Could not fingerprint meme ${r.id}: ${e.message}`);
			}
		}
		this.logger.log(`Fingerprinted ${done} existing image(s)`);
	}

	find(sub: string): DuplicateGroup[] {
		const rows = this.dbs.db
			.prepare(
				`SELECT id, phash, sig, width, height, bytes FROM memes
				 WHERE user_sub = ? AND phash IS NOT NULL AND sig IS NOT NULL`,
			)
			.all(sub) as { id: number; phash: string; sig: Buffer; width: number | null; height: number | null; bytes: number }[];

		const cands: Candidate[] = rows.map((r) => ({
			id: r.id,
			hash: parse(r.phash),
			sig: r.sig,
			aspect: r.width && r.height ? r.width / r.height : 1,
		}));

		const ignored = new Set(
			(
				this.dbs.db
					.prepare(
						`SELECT i.a, i.b FROM duplicate_ignores i JOIN memes m ON m.id = i.a WHERE m.user_sub = ?`,
					)
					.all(sub) as { a: number; b: number }[]
			).map((p) => `${p.a}:${p.b}`),
		);

		// Union-find over every close pair (a few thousand images: well under a second)
		const parent = new Map<number, number>(cands.map((c) => [c.id, c.id]));
		const root = (x: number): number => {
			while (parent.get(x) !== x) {
				parent.set(x, parent.get(parent.get(x)!)!);
				x = parent.get(x)!;
			}
			return x;
		};
		for (let i = 0; i < cands.length; i++) {
			for (let j = i + 1; j < cands.length; j++) {
				const a = cands[i];
				const b = cands[j];
				if (Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect) > MAX_ASPECT_DIFF) continue;
				if (distance(a.hash, b.hash) > MAX_DISTANCE) continue;
				const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
				if (ignored.has(key) || !sameImage(a.sig, b.sig)) continue;
				parent.set(root(a.id), root(b.id));
			}
		}

		const groups = new Map<number, number[]>();
		for (const c of cands) {
			const r = root(c.id);
			groups.set(r, [...(groups.get(r) ?? []), c.id]);
		}

		const info = new Map(rows.map((r) => [r.id, r]));
		const quality = (id: number) => {
			const r = info.get(id)!;
			return (r.width ?? 0) * (r.height ?? 0) * 1e3 + r.bytes / 1e6;
		};
		return [...groups.values()]
			.filter((ids) => ids.length > 1)
			.map((ids) => {
				ids.sort((a, b) => quality(b) - quality(a));
				return { keepId: ids[0], items: this.memes.dtos(sub, ids) };
			})
			.sort((a, b) => b.items.length - a.items.length || b.keepId - a.keepId);
	}

	/** "Not duplicates": never suggest these together again. */
	ignore(sub: string, ids: number[]) {
		for (const id of ids) this.memes.row(sub, id);
		const ins = this.dbs.db.prepare(`INSERT OR IGNORE INTO duplicate_ignores (a, b) VALUES (?, ?)`);
		this.dbs.db.transaction(() => {
			for (let i = 0; i < ids.length; i++)
				for (let j = i + 1; j < ids.length; j++) ins.run(Math.min(ids[i], ids[j]), Math.max(ids[i], ids[j]));
		})();
	}
}
