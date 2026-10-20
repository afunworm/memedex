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
