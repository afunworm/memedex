import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ImageStore } from '../images/image-store.service';
import { EmbeddingService, toBlob } from '../search/embedding.service';
import { VectorIndex } from '../search/vector-index.service';

export interface MemeRow {
	id: number;
	user_sub: string;
	sha256: string;
	ext: string;
	mime: string;
	width: number | null;
	height: number | null;
	animated: number;
	bytes: number;
	original_name: string | null;
	phash: string | null;
	title: string | null;
	ocr_text: string | null;
	ai_status: string;
	ai_error: string | null;
	ai_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface MemeDto {
	id: number;
	title: string | null;
	mime: string;
	width: number | null;
	height: number | null;
	animated: boolean;
	bytes: number;
	originalName: string | null;
	ocrText: string | null;
	descriptions: { text: string; source: 'user' | 'ai' }[];
	tags: string[];
	aiStatus: 'none' | 'queued' | 'running' | 'done' | 'error';
	aiError: string | null;
	createdAt: string;
	url: string;
	thumbUrl: string;
}

export interface MemeEdit {
	title?: string | null;
	descriptions?: string[];
	tags?: string[];
}

export interface AiSuggestion {
	title: string;
	descriptions: string[];
	tags: string[];
	ocrText: string;
}

const MAX_LINES = 60;
const MAX_TAGS = 40;

export function cleanTag(t: string): string {
	return t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 40);
}

function cleanLine(t: string): string {
	return t.trim().replace(/\s+/g, ' ').slice(0, 300);
}

@Injectable()
export class MemesService {
	private readonly logger = new Logger('Memes');

	constructor(
		private readonly dbs: DbService,
		private readonly images: ImageStore,
		private readonly embeddings: EmbeddingService,
		private readonly vectors: VectorIndex,
	) {}

	private get db() {
		return this.dbs.db;
	}

	row(sub: string, id: number): MemeRow {
		const r = this.db.prepare(`SELECT * FROM memes WHERE id = ? AND user_sub = ?`).get(id, sub) as MemeRow | undefined;
		if (!r) throw new NotFoundException('Meme not found');
		return r;
	}

	/** Full DTOs for these ids, in the given order (missing / other users' ids are dropped). */
	dtos(sub: string, ids: number[]): MemeDto[] {
		if (!ids.length) return [];
		const ph = ids.map(() => '?').join(',');
		const rows = this.db
			.prepare(`SELECT * FROM memes WHERE user_sub = ? AND id IN (${ph})`)
			.all(sub, ...ids) as MemeRow[];
		const descs = this.db
			.prepare(`SELECT meme_id, text, source FROM meme_descriptions WHERE meme_id IN (${ph}) ORDER BY position, id`)
			.all(...ids) as { meme_id: number; text: string; source: 'user' | 'ai' }[];
		const tags = this.db
			.prepare(`SELECT meme_id, tag FROM meme_tags WHERE meme_id IN (${ph}) ORDER BY tag`)
			.all(...ids) as { meme_id: number; tag: string }[];

		const byId = new Map(rows.map((r) => [r.id, r]));
		return ids
			.filter((id) => byId.has(id))
			.map((id) => {
				const r = byId.get(id)!;
				return {
					id: r.id,
					title: r.title,
					mime: r.mime,
					width: r.width,
					height: r.height,
					animated: !!r.animated,
					bytes: r.bytes,
					originalName: r.original_name,
					ocrText: r.ocr_text,
					descriptions: descs.filter((d) => d.meme_id === id).map((d) => ({ text: d.text, source: d.source })),
					tags: tags.filter((t) => t.meme_id === id).map((t) => t.tag),
					aiStatus: r.ai_status as MemeDto['aiStatus'],
					aiError: r.ai_error,
					createdAt: r.created_at,
					url: this.images.signedUrl(r.id, r.sha256, 'full'),
					thumbUrl: this.images.signedUrl(r.id, r.sha256, 'thumb'),
				};
			});
	}

	/** Newest first, optionally only those with a tag or still lacking descriptions. */
	list(sub: string, opts: { offset: number; limit: number; tag?: string; undescribed?: boolean }) {
		const where = ['m.user_sub = ?'];
		const args: unknown[] = [sub];
		if (opts.tag) {
			where.push('EXISTS (SELECT 1 FROM meme_tags t WHERE t.meme_id = m.id AND t.tag = ?)');
			args.push(cleanTag(opts.tag));
		}
		if (opts.undescribed) {
			where.push('NOT EXISTS (SELECT 1 FROM meme_descriptions d WHERE d.meme_id = m.id)');
		}
		const total = (this.db.prepare(`SELECT COUNT(*) n FROM memes m WHERE ${where.join(' AND ')}`).get(...args) as any).n;
		const ids = (
			this.db
				.prepare(`SELECT m.id FROM memes m WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`)
				.all(...args, opts.limit, opts.offset) as { id: number }[]
		).map((r) => r.id);
		return { total, items: this.dtos(sub, ids) };
	}

	tags(sub: string) {
		return this.db
			.prepare(
				`SELECT t.tag, COUNT(*) count FROM meme_tags t JOIN memes m ON m.id = t.meme_id
				 WHERE m.user_sub = ? GROUP BY t.tag ORDER BY count DESC, t.tag`,
			)
			.all(sub) as { tag: string; count: number }[];
	}

	async upload(sub: string, files: { buffer: Buffer; originalname: string }[]) {
		const created: number[] = [];
		const duplicates: number[] = [];
		const errors: { name: string; error: string }[] = [];
		for (const f of files) {
			try {
				const img = await this.images.save(sub, f.buffer);
				const existing = this.db
					.prepare(`SELECT id FROM memes WHERE user_sub = ? AND sha256 = ?`)
					.get(sub, img.sha256) as { id: number } | undefined;
				if (existing) {
					duplicates.push(existing.id);
					continue;
				}
				const r = this.db
					.prepare(
						`INSERT INTO memes (user_sub, sha256, ext, mime, width, height, animated, bytes, original_name, phash, sig)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(sub, img.sha256, img.ext, img.mime, img.width, img.height, img.animated ? 1 : 0, img.bytes, f.originalname || null, img.phash, img.sig);
				const id = Number(r.lastInsertRowid);
				this.reindex(id);
				created.push(id);
			} catch (e: any) {
				errors.push({ name: f.originalname, error: e?.message ?? 'Upload failed' });
			}
		}
		return { created: this.dtos(sub, created), duplicates: this.dtos(sub, duplicates), errors };
	}

	async update(sub: string, id: number, edit: MemeEdit): Promise<MemeDto> {
		this.row(sub, id);
		const tx = this.db.transaction(() => {
			if (edit.title !== undefined) {
				this.db.prepare(`UPDATE memes SET title = ? WHERE id = ?`).run(edit.title?.trim().slice(0, 120) || null, id);
			}
			if (edit.descriptions) this.replaceDescriptions(id, edit.descriptions);
			if (edit.tags) this.replaceTags(id, edit.tags);
			this.db.prepare(`UPDATE memes SET updated_at = datetime('now') WHERE id = ?`).run(id);
		});
		tx();
		await this.afterChange(sub, id);
		return this.dtos(sub, [id])[0];
	}

	/** Keeps each line's source and embedding when its text didn't change. */
	private replaceDescriptions(id: number, lines: string[]) {
		const old = this.db
			.prepare(`SELECT text, source, embedding FROM meme_descriptions WHERE meme_id = ?`)
			.all(id) as { text: string; source: string; embedding: Buffer | null }[];
		const byText = new Map(old.map((o) => [o.text.toLowerCase(), o]));
		const seen = new Set<string>();
		const clean = lines.map(cleanLine).filter((l) => {
			const k = l.toLowerCase();
			if (!l || seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		if (clean.length > MAX_LINES) throw new BadRequestException(`At most ${MAX_LINES} descriptions`);
		this.db.prepare(`DELETE FROM meme_descriptions WHERE meme_id = ?`).run(id);
		const ins = this.db.prepare(
			`INSERT INTO meme_descriptions (meme_id, text, source, position, embedding) VALUES (?, ?, ?, ?, ?)`,
		);
		clean.forEach((text, i) => {
			const prev = byText.get(text.toLowerCase());
			ins.run(id, text, prev?.source ?? 'user', i, prev?.embedding ?? null);
		});
	}

	private replaceTags(id: number, tags: string[]) {
		const clean = [...new Set(tags.map(cleanTag).filter(Boolean))];
		if (clean.length > MAX_TAGS) throw new BadRequestException(`At most ${MAX_TAGS} tags`);
		this.db.prepare(`DELETE FROM meme_tags WHERE meme_id = ?`).run(id);
		const ins = this.db.prepare(`INSERT INTO meme_tags (meme_id, tag) VALUES (?, ?)`);
		for (const t of clean) ins.run(id, t);
	}

	/** Adds Claude's suggestions to what's there; never removes the user's own lines or tags. */
	async applyAi(sub: string, id: number, s: AiSuggestion) {
		const r = this.row(sub, id);
		const tx = this.db.transaction(() => {
			const existing = this.db
				.prepare(`SELECT text FROM meme_descriptions WHERE meme_id = ?`)
				.all(id) as { text: string }[];
			const have = new Set(existing.map((e) => e.text.toLowerCase()));
			let pos = existing.length;
			const ins = this.db.prepare(
				`INSERT INTO meme_descriptions (meme_id, text, source, position) VALUES (?, ?, 'ai', ?)`,
			);
			for (const line of s.descriptions.map(cleanLine)) {
				if (!line || have.has(line.toLowerCase()) || pos >= MAX_LINES) continue;
				have.add(line.toLowerCase());
				ins.run(id, line, pos++);
			}
			const tagIns = this.db.prepare(`INSERT OR IGNORE INTO meme_tags (meme_id, tag) VALUES (?, ?)`);
			for (const t of s.tags.map(cleanTag).filter(Boolean).slice(0, MAX_TAGS)) tagIns.run(id, t);
			this.db
				.prepare(
					`UPDATE memes SET title = COALESCE(title, ?), ocr_text = ?, ai_status = 'done', ai_error = NULL,
					 ai_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
				)
				.run(s.title?.trim().slice(0, 120) || null, s.ocrText?.trim() || r.ocr_text, id);
		});
		tx();
		await this.afterChange(sub, id);
	}

	/**
	 * Cleaning up duplicates: moves the other copies' descriptions (with their
	 * vectors), tags, title and image text onto the one being kept, then
	 * deletes the copies.
	 */
	async mergeInto(sub: string, keepId: number, removeIds: number[]) {
		const keep = this.row(sub, keepId);
		removeIds = [...new Set(removeIds)].filter((id) => id !== keepId);
		const others = removeIds.map((id) => this.row(sub, id));
		this.db.transaction(() => {
			const existing = this.db
				.prepare(`SELECT text FROM meme_descriptions WHERE meme_id = ?`)
				.all(keepId) as { text: string }[];
			const have = new Set(existing.map((e) => e.text.toLowerCase()));
			let pos = existing.length;
			const descs = this.db.prepare(
				`SELECT text, source, embedding FROM meme_descriptions WHERE meme_id = ? ORDER BY position, id`,
			);
			const ins = this.db.prepare(
				`INSERT INTO meme_descriptions (meme_id, text, source, position, embedding) VALUES (?, ?, ?, ?, ?)`,
			);
			const tagIns = this.db.prepare(`INSERT OR IGNORE INTO meme_tags (meme_id, tag) SELECT ?, tag FROM meme_tags WHERE meme_id = ?`);
			for (const o of others) {
				for (const d of descs.all(o.id) as { text: string; source: string; embedding: Buffer | null }[]) {
					if (have.has(d.text.toLowerCase()) || pos >= MAX_LINES) continue;
					have.add(d.text.toLowerCase());
					ins.run(keepId, d.text, d.source, pos++, d.embedding);
				}
				tagIns.run(keepId, o.id);
			}
			const title = keep.title ?? others.find((o) => o.title)?.title ?? null;
			const ocr = keep.ocr_text ?? others.find((o) => o.ocr_text)?.ocr_text ?? null;
			this.db
				.prepare(`UPDATE memes SET title = ?, ocr_text = ?, updated_at = datetime('now') WHERE id = ?`)
				.run(title, ocr, keepId);
		})();
		await this.remove(sub, removeIds);
		await this.afterChange(sub, keepId);
		return this.dtos(sub, [keepId])[0];
	}

	setAiStatus(id: number, status: MemeDto['aiStatus'], error: string | null = null) {
		this.db.prepare(`UPDATE memes SET ai_status = ?, ai_error = ? WHERE id = ?`).run(status, error, id);
	}

	async remove(sub: string, ids: number[]) {
		for (const id of ids) {
			const r = this.db.prepare(`SELECT * FROM memes WHERE id = ? AND user_sub = ?`).get(id, sub) as MemeRow | undefined;
			if (!r) continue;
			this.db.transaction(() => {
				this.db.prepare(`DELETE FROM memes WHERE id = ?`).run(id);
				this.db.prepare(`DELETE FROM memes_fts WHERE rowid = ?`).run(id);
			})();
			await this.images.remove(sub, r.sha256, r.ext);
		}
		this.vectors.invalidate(sub);
	}

	private async afterChange(sub: string, id: number) {
		this.reindex(id);
		await this.embedMissing(id);
		this.vectors.invalidate(sub);
	}

	/** Rebuilds the keyword index entry for one meme. */
	reindex(id: number) {
		const m = this.db.prepare(`SELECT title, ocr_text, original_name FROM memes WHERE id = ?`).get(id) as any;
		if (!m) return;
		const descs = this.db.prepare(`SELECT text FROM meme_descriptions WHERE meme_id = ?`).all(id) as { text: string }[];
		const tags = this.db.prepare(`SELECT tag FROM meme_tags WHERE meme_id = ?`).all(id) as { tag: string }[];
		const body = [m.title, ...tags.map((t) => t.tag), ...descs.map((d) => d.text), m.ocr_text]
			.filter(Boolean)
			.join('\n');
		this.db.prepare(`DELETE FROM memes_fts WHERE rowid = ?`).run(id);
		this.db.prepare(`INSERT INTO memes_fts (rowid, body) VALUES (?, ?)`).run(id, body);
	}

	/** Computes vectors for description lines that don't have one yet. */
	async embedMissing(id: number) {
		const rows = this.db
			.prepare(`SELECT id, text FROM meme_descriptions WHERE meme_id = ? AND embedding IS NULL`)
			.all(id) as { id: number; text: string }[];
		if (!rows.length) return;
		try {
			const vecs = await this.embeddings.embed(rows.map((r) => r.text));
			const upd = this.db.prepare(`UPDATE meme_descriptions SET embedding = ? WHERE id = ?`);
			this.db.transaction(() => rows.forEach((r, i) => upd.run(toBlob(vecs[i]), r.id)))();
		} catch (e: any) {
			// Keyword search still works; vectors are retried on the next start
			this.logger.error(`Embedding failed for meme ${id}: ${e.message}`);
		}
	}

	/** At startup: fill in any vectors missing after a crash or failed model load. */
	async embedAllMissing() {
		const ids = this.db
			.prepare(`SELECT DISTINCT meme_id FROM meme_descriptions WHERE embedding IS NULL`)
			.all() as { meme_id: number }[];
		for (const { meme_id } of ids) await this.embedMissing(meme_id);
		this.vectors.clear();
		if (ids.length) this.logger.log(`Computed missing vectors for ${ids.length} meme(s)`);
	}
}
