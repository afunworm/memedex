import { Injectable, Logger } from '@nestjs/common';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { UPSCALE_MODEL } from '../config';

/** The model works on fixed 128x128 tiles and returns 512x512 (4x). */
const TILE = 128;
/** Overlap on each side of a tile; only the middle of each output tile is kept, so no seams. */
const PAD = 8;
const CORE = TILE - 2 * PAD;
const SCALE = 4;

/**
 * "AI enhance": Real-ESRGAN General x4v3 run locally with ONNX Runtime (CPU).
 * It's small (~5 MB) and fast (~0.1 s per tile, a few seconds for a typical
 * meme). Good at JPEG blockiness and blur; it can warp small text, which is
 * why results are only ever offered for review.
 */
@Injectable()
export class UpscalerService {
	private readonly logger = new Logger('Upscaler');
	private session: Promise<ort.InferenceSession> | null = null;
	/** One image at a time: it already uses several CPU threads. */
	private chain: Promise<unknown> = Promise.resolve();

	private load() {
		if (!this.session) {
			this.session = ort.InferenceSession.create(UPSCALE_MODEL, { intraOpNumThreads: 4 });
			this.session.then(
				() => this.logger.log('Real-ESRGAN loaded'),
				(e) => {
					this.logger.error(`Could not load Real-ESRGAN: ${e.message}`);
					this.session = null;
				},
			);
		}
		return this.session;
	}

	/** Upscales the first frame 4x. Transparency is kept (alpha is resized normally). */
	upscale(input: Buffer | string): Promise<{ data: Buffer; width: number; height: number; channels: 3 | 4 }> {
		const run = this.chain.then(() => this.run(input));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async run(input: Buffer | string) {
		const session = await this.load();
		const base = sharp(input, { animated: false }).rotate();
		const meta = await base.clone().metadata();
		const { data: rgb, info } = await base.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
		const W = info.width;
		const H = info.height;
		const nx = Math.ceil(W / CORE);
		const ny = Math.ceil(H / CORE);
		const PW = nx * CORE + 2 * PAD;
		const PH = ny * CORE + 2 * PAD;

		// Mirror the edges so border tiles have context, and round up to whole tiles
		const padded = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
			.extend({ top: PAD, left: PAD, right: PW - W - PAD, bottom: PH - H - PAD, extendWith: 'mirror' })
			.raw()
			.toBuffer();

		const OW = nx * CORE * SCALE;
		const OH = ny * CORE * SCALE;
		const OT = TILE * SCALE;
		const out = Buffer.alloc(OW * OH * 3);
		const tile = new Float32Array(3 * TILE * TILE);
		const plane = TILE * TILE;
		const oplane = OT * OT;

		for (let ty = 0; ty < ny; ty++) {
			for (let tx = 0; tx < nx; tx++) {
				const x0 = tx * CORE;
				const y0 = ty * CORE;
				for (let y = 0; y < TILE; y++) {
					for (let x = 0; x < TILE; x++) {
						const i = ((y0 + y) * PW + x0 + x) * 3;
						const t = y * TILE + x;
						tile[t] = padded[i] / 255;
						tile[plane + t] = padded[i + 1] / 255;
						tile[2 * plane + t] = padded[i + 2] / 255;
					}
				}
				const result = await session.run({ image: new ort.Tensor('float32', tile, [1, 3, TILE, TILE]) });
				const o = result[session.outputNames[0]].data as Float32Array;
				for (let y = 0; y < CORE * SCALE; y++) {
					const sy = y + PAD * SCALE;
					const row = (ty * CORE * SCALE + y) * OW + tx * CORE * SCALE;
					for (let x = 0; x < CORE * SCALE; x++) {
						const s = sy * OT + x + PAD * SCALE;
						const d = (row + x) * 3;
						out[d] = clamp(o[s]);
						out[d + 1] = clamp(o[oplane + s]);
						out[d + 2] = clamp(o[2 * oplane + s]);
					}
				}
			}
		}

		const width = W * SCALE;
		const height = H * SCALE;
		let img = sharp(out, { raw: { width: OW, height: OH, channels: 3 } }).extract({ left: 0, top: 0, width, height });
		if (meta.hasAlpha) {
			const alpha = await base.clone().extractChannel('alpha').resize(width, height, { kernel: 'lanczos3' }).raw().toBuffer();
			img = sharp(await img.raw().toBuffer(), { raw: { width, height, channels: 3 } }).joinChannel(alpha, {
				raw: { width, height, channels: 1 },
			});
			return { data: await img.raw().toBuffer(), width, height, channels: 4 as const };
		}
		return { data: await img.raw().toBuffer(), width, height, channels: 3 as const };
	}
}

function clamp(v: number): number {
	return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}
