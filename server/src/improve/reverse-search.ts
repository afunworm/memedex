import type { SearchProvider } from '../config';

/** A copy of the image somewhere on the internet, as the search service describes it. */
export interface WebMatch {
	/** Direct link to the image file. */
	imageUrl: string;
	/** The page it appears on. */
	pageUrl: string | null;
	width: number;
	height: number;
}

export class ReverseSearchError extends Error {}

/**
 * TinEye: the image is uploaded (works even if MemeDex isn't reachable from
 * the internet). Biggest matches first. Request and response shapes follow
 * TinEye's official client (tineye-api on npm) and a live sandbox call.
 */
async function tineye(apiKey: string, image: Buffer): Promise<WebMatch[]> {
	const form = new FormData();
	form.append('image_upload', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'image.jpg');
	const res = await fetch('https://api.tineye.com/rest/search/?limit=30&sort=size&order=desc', {
		method: 'POST',
		headers: { 'X-API-Key': apiKey },
		body: form,
		signal: AbortSignal.timeout(60_000),
	});
	const body: any = await res.json().catch(() => null);
	if (res.status === 401 || res.status === 403) throw new ReverseSearchError('TinEye rejected the API key');
	if (!res.ok || !body || body.code !== 200) {
		throw new ReverseSearchError(`TinEye: ${body?.messages?.join(' ') || `HTTP ${res.status}`}`);
	}
	const out: WebMatch[] = [];
	for (const m of body.results?.matches ?? []) {
		for (const b of (m.backlinks ?? []).slice(0, 3)) {
			if (b.url) out.push({ imageUrl: b.url, pageUrl: b.backlink ?? null, width: m.width, height: m.height });
		}
	}
	return out;
}

/**
 * SerpApi (Google Lens): Google fetches the image by URL, so MemeDex must be
 * reachable from the internet (a short-lived signed link is sent).
 * visual_matches carry the full image link and its size.
 */
async function serpapi(apiKey: string, publicImageUrl: string): Promise<WebMatch[]> {
	const q = new URLSearchParams({ engine: 'google_lens', type: 'visual_matches', url: publicImageUrl, api_key: apiKey });
	const res = await fetch(`https://serpapi.com/search.json?${q}`, { signal: AbortSignal.timeout(90_000) });
	const body: any = await res.json().catch(() => null);
	if (res.status === 401) throw new ReverseSearchError('SerpApi rejected the API key');
	if (!res.ok || !body || body.error) {
		// "hasn't returned any results" is a normal empty answer
		if (typeof body?.error === 'string' && /any results/i.test(body.error)) return [];
		throw new ReverseSearchError(`SerpApi: ${body?.error || `HTTP ${res.status}`}`);
	}
	return (body.visual_matches ?? [])
		.filter((m: any) => m.image && m.image_width && m.image_height)
		.map((m: any) => ({ imageUrl: m.image, pageUrl: m.link ?? null, width: m.image_width, height: m.image_height }));
}

export function reverseSearch(
	provider: SearchProvider,
	apiKey: string,
	input: { jpeg: Buffer; publicUrl: string | null },
): Promise<WebMatch[]> {
	if (provider === 'tineye') return tineye(apiKey, input.jpeg);
	if (!input.publicUrl) {
		throw new ReverseSearchError(
			"SerpApi needs MemeDex to be reachable from the internet (set PUBLIC_URL if it is, behind a proxy), or use TinEye",
		);
	}
	return serpapi(apiKey, input.publicUrl);
}

/** Checks a search key without running a (paid) search. */
export async function testSearchKey(provider: SearchProvider, apiKey: string): Promise<string> {
	if (provider === 'tineye') {
		const res = await fetch('https://api.tineye.com/rest/remaining_searches/', {
			headers: { 'X-API-Key': apiKey },
			signal: AbortSignal.timeout(20_000),
		});
		const body: any = await res.json().catch(() => null);
		if (!res.ok || body?.code !== 200) throw new ReverseSearchError('TinEye rejected the API key');
		const left = body.results?.total_remaining_searches ?? body.results?.remaining_searches;
		return left !== undefined ? `Works. ${typeof left === 'object' ? JSON.stringify(left) : left} searches left.` : 'Works.';
	}
	const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(apiKey)}`, {
		signal: AbortSignal.timeout(20_000),
	});
	const body: any = await res.json().catch(() => null);
	if (!res.ok || body?.error) throw new ReverseSearchError(`SerpApi: ${body?.error ?? 'rejected the API key'}`);
	const left = body?.total_searches_left ?? body?.plan_searches_left;
	return left !== undefined ? `Works. ${left} searches left.` : 'Works.';
}
