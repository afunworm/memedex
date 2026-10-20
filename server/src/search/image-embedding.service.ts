import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AutoProcessor, CLIPVisionModelWithProjection, env, Processor, RawImage, PreTrainedModel } from '@huggingface/transformers';
import sharp from 'sharp';
import { CLIP_MODEL, MODEL_DIR } from '../config';
import { DbService } from '../db/db.service';
import { ImageStore } from '../images/image-store.service';
import { toBlob } from './embedding.service';

/**
 * What an image looks like, as a vector (CLIP, run locally, ~30 ms per image).
 * Memes showing the same template, character or scene end up close together
 * even with different captions, which descriptions alone can't tell.
 */
@Injectable()
export class ImageEmbeddingService implements OnApplicationBootstrap {
	private readonly logger = new Logger('Image embeddings');
	private model: Promise<{ processor: Processor; model: PreTrainedModel }> | null = null;
	private readonly pending = new Set<number>();
	private working = false;

	constructor(
		private readonly dbs: DbService,
		private readonly images: ImageStore,
	) {}

	onApplicationBootstrap() {
		const rows = this.dbs.db.prepare(`SELECT id FROM memes WHERE clip IS NULL`).all() as { id: number }[];
		if (rows.length) this.logger.log(`Indexing ${rows.length} image(s) for "Same look"`);
		this.queue(rows.map((r) => r.id));
	}

	private load() {
		if (!this.model) {
			env.cacheDir = MODEL_DIR;
			this.model = Promise.all([
				AutoProcessor.from_pretrained(CLIP_MODEL),
				CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'q8' }),
			]).then(([processor, model]) => ({ processor, model }));
			this.model.catch((e) => {
				this.logger.error(`Could not load ${CLIP_MODEL}: ${e.message}`);
				this.model = null;
			});
		}
		return this.model;
	}

	/** Computes vectors for these memes in the background, one at a time. */
	queue(ids: number[]) {
		for (const id of ids) this.pending.add(id);
		if (!this.working) this.work();
	}

	/** How many images still wait for a vector (the "Same look" tab says so). */
	backlog() {
		return this.pending.size;
	}

	private async work() {
		this.working = true;
		try {
			while (this.pending.size) {
				const id = this.pending.values().next().value as number;
				this.pending.delete(id);
				const r = this.dbs.db.prepare(`SELECT user_sub, sha256, ext FROM memes WHERE id = ?`).get(id) as
					| { user_sub: string; sha256: string; ext: string }
					| undefined;
				if (!r) continue;
				try {
					const v = await this.embed(this.images.fullPath(r.user_sub, r.sha256, r.ext));
					this.dbs.db.prepare(`UPDATE memes SET clip = ? WHERE id = ?`).run(toBlob(v), id);
				} catch (e: any) {
					this.logger.warn(`Meme ${id}: ${e.message}`);
				}
			}
		} finally {
			this.working = false;
		}
	}

	/** L2-normalised 512-d vector of the first frame. */
	async embed(input: Buffer | string): Promise<Float32Array> {
		const { processor, model } = await this.load();
		const { data, info } = await sharp(input, { animated: false })
			.rotate()
			.flatten({ background: '#ffffff' })
			.resize(448, 448, { fit: 'inside', withoutEnlargement: true })
			.raw()
			.toBuffer({ resolveWithObject: true });
		const image = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
		const out = await model(await processor(image));
		const v = out.image_embeds.data as Float32Array;
		let n = 0;
		for (const x of v) n += x * x;
		n = Math.sqrt(n) || 1;
		return Float32Array.from(v, (x) => x / n);
	}
}
