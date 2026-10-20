import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { fromBlob } from './embedding.service';

interface UserIndex {
	/** Description vectors, one after another (count x dim). */
	matrix: Float32Array;
	dim: number;
	memeIds: number[];
	texts: string[];
}

export interface VectorHit {
	memeId: number;
	score: number;
	/** The description line that matched best. */
	text: string;
}

/**
 * All of a user's description vectors, held in memory and searched by brute
 * force. A few thousand memes x ~8 lines x 384 floats is a few tens of MB at
 * most and takes milliseconds to scan; no vector database needed. Rebuilt
 * lazily after any change.
 */
@Injectable()
export class VectorIndex {
	private readonly cache = new Map<string, UserIndex>();

	constructor(private readonly dbs: DbService) {}

	invalidate(sub: string) {
		this.cache.delete(sub);
	}

	clear() {
		this.cache.clear();
	}

	private load(sub: string): UserIndex {
		let idx = this.cache.get(sub);
		if (idx) return idx;
		const rows = this.dbs.db
			.prepare(
				`SELECT d.meme_id, d.text, d.embedding FROM meme_descriptions d
				 JOIN memes m ON m.id = d.meme_id
				 WHERE m.user_sub = ? AND d.embedding IS NOT NULL`,
			)
			.all(sub) as { meme_id: number; text: string; embedding: Buffer }[];
		const dim = rows.length ? rows[0].embedding.length / 4 : 0;
		const matrix = new Float32Array(rows.length * dim);
		rows.forEach((r, i) => matrix.set(fromBlob(r.embedding), i * dim));
		idx = { matrix, dim, memeIds: rows.map((r) => r.meme_id), texts: rows.map((r) => r.text) };
		this.cache.set(sub, idx);
		return idx;
	}

	/**
	 * "Same vibe": memes whose descriptions cover the same ground as this one's.
	 * For each of this meme's lines, every other meme gets its closest line's
	 * similarity; a meme's score is the average of its better half of those,
	 * so it has to match several lines well, not just one by luck.
	 * Returns null when this meme has no description vectors.
	 */
	similarByLines(sub: string, memeId: number, limit: number): (VectorHit & { theirs: string })[] | null {
		const { matrix, dim, memeIds, texts } = this.load(sub);
		const mine: number[] = [];
		for (let i = 0; i < memeIds.length; i++) if (memeIds[i] === memeId) mine.push(i);
		if (!mine.length) return null;

		// sims[k]: best match among the other meme's lines for my line k.
		// back: for each of the other meme's lines, its best match among mine.
		const best = new Map<number, { sims: Float32Array; pair: Int32Array; back: number[] }>();
		for (let j = 0; j < memeIds.length; j++) {
			const other = memeIds[j];
			if (other === memeId) continue;
			let entry = best.get(other);
			if (!entry) {
				entry = { sims: new Float32Array(mine.length).fill(-1), pair: new Int32Array(mine.length), back: [] };
				best.set(other, entry);
			}
			const oj = j * dim;
			let rowBest = -1;
			for (let k = 0; k < mine.length; k++) {
				const oi = mine[k] * dim;
				let s = 0;
				for (let d = 0; d < dim; d++) s += matrix[oi + d] * matrix[oj + d];
				if (s > entry.sims[k]) {
					entry.sims[k] = s;
					entry.pair[k] = j;
				}
				if (s > rowBest) rowBest = s;
			}
			entry.back.push(rowBest);
		}

		/** Mean of the better half: several lines must match, not just one by luck. */
		const topHalf = (v: ArrayLike<number>) => {
			const sorted = Array.from(v).sort((a, b) => b - a);
			const half = Math.max(1, Math.ceil(sorted.length / 2));
			let s = 0;
			for (let k = 0; k < half; k++) s += sorted[k];
			return s / half;
		};
		const hits: (VectorHit & { theirs: string })[] = [];
		for (const [other, { sims, pair, back }] of best) {
			// Both directions, so A→B and B→A score the same
			const score = (topHalf(sims) + topHalf(back)) / 2;
			let k = 0;
			for (let i = 1; i < sims.length; i++) if (sims[i] > sims[k]) k = i;
			// The closest pair of lines, to show why it matched
			hits.push({ memeId: other, score, text: texts[mine[k]], theirs: texts[pair[k]] });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Best-matching memes for a query vector; each meme scores by its single best line. */
	search(sub: string, query: Float32Array, limit: number): VectorHit[] {
		const { matrix, dim, memeIds, texts } = this.load(sub);
		const best = new Map<number, VectorHit>();
		for (let i = 0; i < memeIds.length; i++) {
			let s = 0;
			const off = i * dim;
			for (let j = 0; j < dim; j++) s += matrix[off + j] * query[j];
			const cur = best.get(memeIds[i]);
			if (!cur || s > cur.score) best.set(memeIds[i], { memeId: memeIds[i], score: s, text: texts[i] });
		}
		return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
	}
}
