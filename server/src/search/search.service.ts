import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { EmbeddingService } from './embedding.service';
import { VectorIndex } from './vector-index.service';

export interface SearchHit {
	memeId: number;
	score: number;
	/** The description line that matched best by meaning, if any. */
	matched: string | null;
}

/** Reciprocal rank fusion constant: higher = flatter blend of the lists. */
const RRF_K = 60;
/** Vector matches below this cosine similarity are noise. */
const MIN_SIMILARITY = 0.3;

/**
 * Hybrid search: meaning (vectors, per description line) + words (SQLite
 * FTS5 over title, tags, descriptions and the text on the image). The two
 * ranked lists, one pair per query, are merged with reciprocal rank fusion,
 * so a meme that ranks well in several lists rises to the top.
 */
@Injectable()
export class SearchService {
	constructor(
		private readonly dbs: DbService,
		private readonly embeddings: EmbeddingService,
		private readonly vectors: VectorIndex,
	) {}

	async search(sub: string, queries: string[], limit = 60): Promise<SearchHit[]> {
		queries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
		if (!queries.length) return [];

		const fused = new Map<number, SearchHit & { sim: number }>();
		const add = (memeId: number, rank: number, weight: number, matched: string | null, sim = 0) => {
			const hit = fused.get(memeId) ?? { memeId, score: 0, matched: null, sim: 0 };
			hit.score += weight / (RRF_K + rank);
			if (matched && sim > hit.sim) {
				hit.matched = matched;
				hit.sim = sim;
			}
			fused.set(memeId, hit);
		};

		let vecs: Float32Array[] = [];
		try {
			vecs = await this.embeddings.embed(queries);
		} catch {
			/* model unavailable: keyword search only */
		}
		vecs.forEach((v) => {
			this.vectors
				.search(sub, v, 80)
				.filter((h) => h.score >= MIN_SIMILARITY)
				.forEach((h, rank) => add(h.memeId, rank, 1, h.text, h.score));
		});

		for (const q of queries) {
			this.keyword(sub, q, 80).forEach((id, rank) => add(id, rank, 0.8, null));
		}

		return [...fused.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(({ memeId, score, matched }) => ({ memeId, score, matched }));
	}

	/** FTS5 match on any of the words (prefix match), best BM25 first. */
	private keyword(sub: string, q: string, limit: number): number[] {
		const words = q
			.toLowerCase()
			.match(/[\p{L}\p{N}']+/gu)
			?.map((w) => w.replace(/'/g, ''))
			.filter((w) => w.length > 1);
		if (!words?.length) return [];
		const match = words.map((w) => `"${w}"*`).join(' OR ');
		return (
			this.dbs.db
				.prepare(
					`SELECT f.rowid id FROM memes_fts f JOIN memes m ON m.id = f.rowid
					 WHERE memes_fts MATCH ? AND m.user_sub = ? ORDER BY bm25(memes_fts) LIMIT ?`,
				)
				.all(match, sub, limit) as { id: number }[]
		).map((r) => r.id);
	}
}
