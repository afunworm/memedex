// Downloads the models into MODEL_DIR (default ./models) so the Docker image
// carries them and the server never fetches them at runtime:
// - the sentence-embedding model for search
// - CLIP (image model) for "More like this → Same look"
// - Real-ESRGAN General x4v3 (ONNX, Qualcomm AI Hub export) for "AI enhance"
import { AutoProcessor, CLIPVisionModelWithProjection, env, pipeline } from '@huggingface/transformers';
import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const DIR = process.env.MODEL_DIR || './models';
env.cacheDir = DIR;

const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const out = await embed(['really?', 'what did you just say'], { pooling: 'mean', normalize: true });
console.log(`${MODEL} ready in ${DIR}: ${out.dims.join('x')}`);

// CLIP image model for "More like this → Same look"
const CLIP = process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32';
await AutoProcessor.from_pretrained(CLIP);
await CLIPVisionModelWithProjection.from_pretrained(CLIP, { dtype: 'q8' });
console.log(`${CLIP} ready in ${DIR}`);

const ESRGAN_URL =
	'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/real_esrgan_general_x4v3/releases/v0.64.0/real_esrgan_general_x4v3-onnx-float.zip';
const ESRGAN_SHA256 = 'fc094329b24a00c936ebc1cc4c51bc59633e7dc36f4a553344342171cbd3c7cf';
const esrganDir = join(DIR, 'real-esrgan');
if (existsSync(join(esrganDir, 'real_esrgan_general_x4v3.onnx'))) {
	console.log(`Real-ESRGAN already in ${esrganDir}`);
} else {
	const res = await fetch(ESRGAN_URL);
	if (!res.ok) throw new Error(`Real-ESRGAN download failed: ${res.status}`);
	const zip = Buffer.from(await res.arrayBuffer());
	const sha = createHash('sha256').update(zip).digest('hex');
	if (sha !== ESRGAN_SHA256) throw new Error(`Real-ESRGAN download has an unexpected checksum: ${sha}`);
	mkdirSync(esrganDir, { recursive: true });
	// The .onnx graph and its .data weights must sit side by side
	for (const entry of new AdmZip(zip).getEntries()) {
		const name = entry.entryName.split('/').pop();
		if (entry.isDirectory || !/^real_esrgan_general_x4v3\.(onnx|data)$/.test(name)) continue;
		new AdmZip(zip).extractEntryTo(entry, esrganDir, false, true);
	}
	console.log(`Real-ESRGAN ready in ${esrganDir}`);
}
