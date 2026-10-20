import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { env, pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL, MODEL_DIR } from '../config';

/**
 * Sentence embeddings computed locally (Claude has no embeddings API).
 * all-MiniLM-L6-v2 is small (~23 MB, 384 dimensions), runs on CPU, and is
 * trained for short-sentence similarity, which is exactly what description
 * lines like "really?" and "what did you just say" are.
 */
@Injectable()
export class EmbeddingService implements OnApplicationBootstrap {
	private readonly logger = new Logger('Embeddings');
	private extractor: Promise<FeatureExtractionPipeline> | null = null;

	onApplicationBootstrap() {
		// Warm up in the background so the first search isn't slow
		this.load().catch((e) => this.logger.error(`Could not load ${EMBEDDING_MODEL}: ${e.message}`));
	}

	private load() {
		if (!this.extractor) {
			env.cacheDir = MODEL_DIR;
			this.extractor = pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' }).then((p) => {
				this.logger.log(`${EMBEDDING_MODEL} loaded`);
				return p as FeatureExtractionPipeline;
			});
			this.extractor.catch(() => (this.extractor = null));
		}
		return this.extractor;
	}

	/** L2-normalised vectors, one per text (so cosine similarity = dot product). */
	async embed(texts: string[]): Promise<Float32Array[]> {
		if (!texts.length) return [];
		const extractor = await this.load();
		const out: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += 64) {
			const batch = texts.slice(i, i + 64).map((t) => t.toLowerCase());
			const t = await extractor(batch, { pooling: 'mean', normalize: true });
			const [n, d] = t.dims as [number, number];
			const data = t.data as Float32Array;
			for (let j = 0; j < n; j++) out.push(Float32Array.from(data.subarray(j * d, (j + 1) * d)));
		}
		return out;
	}
}

export function toBlob(v: Float32Array): Buffer {
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
	// Copy: the Buffer may not be 4-byte aligned
	return new Float32Array(new Uint8Array(b).buffer);
}
