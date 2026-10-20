import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { MemeDto, MemesService } from '../memes/memes.service';
import { fromBlob } from './embedding.service';
import { ImageEmbeddingService } from './image-embedding.service';
import { VectorIndex } from './vector-index.service';

const LIMIT = 30;
/** Below these, results are more noise than "similar". */
const MIN_MEANING = 0.35;
const MIN_LOOK = 0.75;

export type SimilarBy = 'meaning' | 'look';

export interface SimilarResult {
	items: (MemeDto & { similarity: number; matched: string | null })[];
	/** Why there are no (or few) results, when there's a reason worth saying. */
	note: string | null;
}

/** "More like this": same vibe (descriptions) or same look (the picture itself). */
@Injectable()
export class SimilarService {
	constructor(
		private readonly dbs: DbService,
		private readonly memes: MemesService,
		private readonly vectors: VectorIndex,
		private readonly imageEmbeddings: ImageEmbeddingService,
	) {}

	find(sub: string, id: number, by: SimilarBy): SimilarResult {
		this.memes.row(sub, id);
		return by === 'look' ? this.byLook(sub, id) : this.byMeaning(sub, id);
	}

	private byMeaning(sub: string, id: number): SimilarResult {
		const hits = this.vectors.similarByLines(sub, id, LIMIT * 2);
		if (!hits) {
			return { items: [], note: 'This image has no descriptions yet. Add some (or AI describe it) to find memes with the same vibe.' };
		}
		const good = hits.filter((h) => h.score >= MIN_MEANING).slice(0, LIMIT);
		const dtos = this.memes.dtos(sub, good.map((h) => h.memeId));
		return {
			items: dtos.map((m, i) => ({ ...m, similarity: good[i].score, matched: good[i].theirs })),
			note: good.length ? null : 'Nothing else in your library says something close to this.',
		};
	}

	private byLook(sub: string, id: number): SimilarResult {
		const rows = this.dbs.db
			.prepare(`SELECT id, clip FROM memes WHERE user_sub = ? AND clip IS NOT NULL`)
			.all(sub) as { id: number; clip: Buffer }[];
		const mine = rows.find((r) => r.id === id);
		const indexing = this.imageEmbeddings.backlog();
		const wait = `Still looking at your images (${indexing} to go). Try again in a moment.`;
		if (!mine) return { items: [], note: indexing ? wait : 'This image could not be analysed.' };

		const q = fromBlob(mine.clip);
		const scored = rows
			.filter((r) => r.id !== id)
			.map((r) => {
				const v = fromBlob(r.clip);
				let s = 0;
				for (let d = 0; d < v.length; d++) s += v[d] * q[d];
				return { id: r.id, s };
			})
			.filter((r) => r.s >= MIN_LOOK)
			.sort((a, b) => b.s - a.s)
			.slice(0, LIMIT);
		const dtos = this.memes.dtos(sub, scored.map((r) => r.id));
		let note: string | null = null;
		if (!scored.length) note = indexing ? wait : 'Nothing else in your library looks like this.';
		else if (indexing) note = `Still looking at ${indexing} image(s); more may show up.`;
		return { items: dtos.map((m, i) => ({ ...m, similarity: scored[i].s, matched: null })), note };
	}
}
