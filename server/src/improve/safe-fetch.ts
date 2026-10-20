import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';

/**
 * Downloads an image found by a reverse image search. Those URLs come from
 * the internet, so this refuses anything that resolves to a private, local or
 * otherwise internal address (no reaching into the server's own network),
 * re-checks every redirect, and caps the size and time.
 */

const BLOCKED = new BlockList();
for (const [net, bits] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const) {
	BLOCKED.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
	['::', 128],
	['::1', 128],
	// No rule for IPv4-mapped addresses (::ffff:0:0/96): BlockList checks IPv4
	// addresses against it too, which would block every site. Mapped forms of
	// private IPv4 addresses are caught by the IPv4 rules above instead.
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
] as const) {
	BLOCKED.addSubnet(net, bits, 'ipv6');
}

const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 15_000;

async function assertPublic(url: URL) {
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) links');
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
	for (const a of addrs) {
		if (BLOCKED.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) throw new Error('Address not allowed');
	}
}

export async function fetchPublicImage(raw: string, maxBytes: number): Promise<Buffer> {
	let url = new URL(raw);
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await assertPublic(url);
		const res = await fetch(url, {
			redirect: 'manual',
			signal,
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MemeDex/1.0)', Accept: 'image/*' },
		});
		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			url = new URL(res.headers.get('location')!, url);
			continue;
		}
		if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
		if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error('Too large');

		const chunks: Buffer[] = [];
		let size = 0;
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error('Too large');
			}
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks);
	}
	throw new Error('Too many redirects');
}
