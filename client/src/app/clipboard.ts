/**
 * Copies an image to the clipboard so it can be pasted into a chat.
 * Browsers only accept PNG on the clipboard, so other formats are redrawn
 * as PNG (an animated GIF becomes its first frame; use Download to keep it moving).
 */
export async function copyImage(url: string): Promise<void> {
	const png = fetch(url)
		.then((r) => {
			if (!r.ok) throw new Error('Could not load the image');
			return r.blob();
		})
		.then((blob) => (blob.type === 'image/png' ? blob : toPng(blob)));
	// Safari needs the ClipboardItem created synchronously, with a promise inside
	await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

async function toPng(blob: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
	return new Promise((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the image'))), 'image/png'),
	);
}

export async function downloadImage(url: string, name: string) {
	const blob = await (await fetch(url)).blob();
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function extensionFor(mime: string) {
	return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] ?? 'img';
}
