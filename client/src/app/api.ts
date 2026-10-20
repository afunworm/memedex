import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Meme {
	id: number;
	title: string | null;
	mime: string;
	width: number | null;
	height: number | null;
	animated: boolean;
	originalName: string | null;
	ocrText: string | null;
	descriptions: { text: string; source: 'user' | 'ai' }[];
	tags: string[];
	aiStatus: 'none' | 'queued' | 'running' | 'done' | 'error';
	aiError: string | null;
	createdAt: string;
	url: string;
	thumbUrl: string;
	/** Search only: the description line that matched. */
	matched?: string | null;
	/** Respond only: why Claude picked it. */
	reason?: string;
}

export interface Settings {
	hasApiKey: boolean;
	apiKeyHint: string | null;
	apiKeyProblem: string | null;
	model: string;
	models: { id: string; label: string }[];
	encryptionProblem: string | null;
}

export interface Me extends Settings {
	sub: string;
	name: string | null;
	email: string | null;
}

export interface RespondResult {
	analysis: { summary: string; reactions: string[]; keywords: string[] };
	picks: Meme[];
	more: Meme[];
}

export interface UploadResult {
	created: Meme[];
	duplicates: Meme[];
	errors: { name: string; error: string }[];
}

/** The server's error message from an HttpErrorResponse (or anything thrown). */
export function errorMessage(e: unknown): string {
	const err = e as { error?: { message?: string | string[] }; message?: string; status?: number };
	const m = err?.error?.message;
	if (Array.isArray(m)) return m.join(', ');
	if (m) return m;
	if (err?.status === 0) return 'Could not reach the server';
	return err?.message ?? 'Something went wrong';
}

@Injectable({ providedIn: 'root' })
export class Api {
	private readonly http = inject(HttpClient);

	me() {
		return firstValueFrom(this.http.get<Me>('/api/me'));
	}

	list(opts: { offset?: number; limit?: number; tag?: string; undescribed?: boolean } = {}) {
		const params: Record<string, string> = {
			offset: String(opts.offset ?? 0),
			limit: String(opts.limit ?? 60),
		};
		if (opts.tag) params['tag'] = opts.tag;
		if (opts.undescribed) params['undescribed'] = '1';
		return firstValueFrom(this.http.get<{ total: number; items: Meme[] }>('/api/memes', { params }));
	}

	tags() {
		return firstValueFrom(this.http.get<{ tag: string; count: number }[]>('/api/memes/tags'));
	}

	lookup(ids: number[]) {
		return firstValueFrom(this.http.post<Meme[]>('/api/memes/lookup', { ids }));
	}

	upload(files: File[]) {
		const form = new FormData();
		for (const f of files) form.append('files', f, f.name);
		return firstValueFrom(this.http.post<UploadResult>('/api/memes', form));
	}

	update(id: number, edit: { title?: string | null; descriptions?: string[]; tags?: string[] }) {
		return firstValueFrom(this.http.patch<Meme>(`/api/memes/${id}`, edit));
	}

	generate(ids: number[]) {
		return firstValueFrom(this.http.post<{ queued: number[] }>('/api/memes/ai', { ids }));
	}

	remove(ids: number[]) {
		return firstValueFrom(this.http.post('/api/memes/delete', { ids }));
	}

	search(q: string) {
		return firstValueFrom(this.http.get<{ items: Meme[] }>('/api/search', { params: { q } }));
	}

	respond(text: string, image: File | null) {
		const form = new FormData();
		form.append('text', text);
		if (image) form.append('image', image, image.name || 'screenshot.png');
		return firstValueFrom(this.http.post<RespondResult>('/api/respond', form));
	}

	settings() {
		return firstValueFrom(this.http.get<Settings>('/api/settings'));
	}

	saveSettings(body: { apiKey?: string; model?: string }) {
		return firstValueFrom(this.http.put<Settings>('/api/settings', body));
	}

	testSettings() {
		return firstValueFrom(this.http.post<{ ok: boolean; model?: string; error?: string }>('/api/settings/test', {}));
	}
}
