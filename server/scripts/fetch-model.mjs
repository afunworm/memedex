// Downloads the embedding model into MODEL_DIR (default ./models) so the
// Docker image carries it and the server never fetches it at runtime.
import { env, pipeline } from '@huggingface/transformers';

const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
env.cacheDir = process.env.MODEL_DIR || './models';

const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const out = await embed(['really?', 'what did you just say'], { pooling: 'mean', normalize: true });
console.log(`${MODEL} ready in ${env.cacheDir}: ${out.dims.join('x')}`);
