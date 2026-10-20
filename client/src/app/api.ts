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
	bytes: number;
	originalName: string | null;
	ocrText: string | null;
	descriptions: { text: string; source: 'user' | 'ai' }[];
	tags: string[];
	aiStatus: 'none' | 'queued' | 'running' | 'done' | 'error';
	aiError: string | null;
	/** "Improve quality" job (find a bigger copy online / AI enhance). */
	improveStatus: 'none' | 'queued' | 'running' | 'done' | 'error';
	improveError: string | null;
	/** Better versions waiting to be accepted or discarded. */
	candidates: number;
	lowRes: boolean;
	createdAt: string;
	url: string;
	thumbUrl: string;
	/** Search only: the description line that matched. */
	matched?: string | null;
	/** Respond only: why Claude picked it. */
	reason?: string;
	/** "More like this" only: how close it is (0..1). */
	similarity?: number;
}

export interface Settings {
	hasApiKey: boolean;
	apiKeyHint: string | null;
	apiKeyProblem: string | null;
	model: string;
	models: { id: string; label: string }[];
	search: { provider: string | null; hasKey: boolean; keyHint: string | null; keyProblem: string | null };
	searchProviders: { id: string; label: string; keyHelp: string }[];
	encryptionProblem: string | null;
}

/** A better version of a meme, waiting for the user to accept or discard it. */
export interface Candidate {
	id: number;
	kind: 'web' | 'enhance';
	mime: string;
	width: number;
	height: number;
	bytes: number;
	sourceUrl: string | null;
	sourcePage: string | null;
	createdAt: string;
	url: string;
}

export type ImproveMode = 'web' | 'enhance' | 'auto';

/** "More like this": meaning = same vibe (descriptions), look = same template / character / scene. */
export type SimilarBy = 'meaning' | 'look';

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

/** Reply to a message, or react to a described situation. */
export type AskKind = 'message' | 'situation';

export interface DuplicateGroup {
	/** Suggested one to keep (the largest); listed first. */
	keepId: number;
	items: Meme[];
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

	list(
		opts: { offset?: number; limit?: number; tag?: string; undescribed?: boolean; lowRes?: boolean; review?: boolean } = {},
	) {
		const params: Record<string, string> = {
			offset: String(opts.offset ?? 0),
			limit: String(opts.limit ?? 60),
		};
		if (opts.tag) params['tag'] = opts.tag;
		if (opts.undescribed) params['undescribed'] = '1';
		if (opts.lowRes) params['lowres'] = '1';
		if (opts.review) params['review'] = '1';
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

	improve(ids: number[], mode: ImproveMode) {
		return firstValueFrom(this.http.post<{ queued: number[] }>('/api/memes/improve', { ids, mode }));
	}

	similar(id: number, by: SimilarBy) {
		return firstValueFrom(this.http.get<{ items: Meme[]; note: string | null }>(`/api/memes/${id}/similar`, { params: { by } }));
	}

	candidates(id: number) {
		return firstValueFrom(this.http.get<Candidate[]>(`/api/memes/${id}/candidates`));
	}

	acceptCandidate(id: number, candidateId: number) {
		return firstValueFrom(this.http.post<Meme>(`/api/memes/${id}/candidates/${candidateId}/accept`, {}));
	}

	discardCandidate(id: number, candidateId: number) {
		return firstValueFrom(this.http.delete<Meme>(`/api/memes/${id}/candidates/${candidateId}`));
	}

	remove(ids: number[]) {
		return firstValueFrom(this.http.post('/api/memes/delete', { ids }));
	}

	search(q: string) {
		return firstValueFrom(this.http.get<{ items: Meme[] }>('/api/search', { params: { q } }));
	}

	respond(kind: AskKind, text: string, image: File | null) {
		const form = new FormData();
		form.append('kind', kind);
		form.append('text', text);
		if (image) form.append('image', image, image.name || 'screenshot.png');
		return firstValueFrom(this.http.post<RespondResult>('/api/respond', form));
	}

	duplicates() {
		return firstValueFrom(this.http.get<DuplicateGroup[]>('/api/duplicates'));
	}

	mergeDuplicates(keepId: number, removeIds: number[]) {
		return firstValueFrom(this.http.post<Meme>('/api/duplicates/merge', { keepId, removeIds }));
	}

	ignoreDuplicates(ids: number[]) {
		return firstValueFrom(this.http.post('/api/duplicates/ignore', { ids }));
	}

	settings() {
		return firstValueFrom(this.http.get<Settings>('/api/settings'));
	}

	saveSettings(body: { apiKey?: string; model?: string; searchProvider?: string; searchApiKey?: string }) {
		return firstValueFrom(this.http.put<Settings>('/api/settings', body));
	}

	testSearch() {
		return firstValueFrom(this.http.post<{ ok: boolean; message?: string; error?: string }>('/api/settings/test-search', {}));
	}

	testSettings() {
		return firstValueFrom(this.http.post<{ ok: boolean; model?: string; error?: string }>('/api/settings/test', {}));
	}
}
