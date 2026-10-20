import { Component, computed, HostListener, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api, errorMessage, Me, Meme, RespondResult } from '../api';
import { copyImage } from '../clipboard';
import { Toasts } from '../toast';
import { MemeDetail } from './meme-detail';

type Mode = 'find' | 'message' | 'situation';
const PAGE = 60;

@Component({
	selector: 'app-library',
	imports: [FormsModule, RouterLink, NgTemplateOutlet, MemeDetail],
	templateUrl: './library.html',
})
export class LibraryPage implements OnInit, OnDestroy {
	private readonly api = inject(Api);
	private readonly toasts = inject(Toasts);

	protected readonly tabs: { mode: Mode; label: string; short: string }[] = [
		{ mode: 'find', label: 'Find a reaction', short: 'Find' },
		{ mode: 'message', label: '✨ Reply to a message', short: '✨ Reply' },
		{ mode: 'situation', label: '✨ Describe a situation', short: '✨ Situation' },
	];

	protected readonly me = signal<Me | null>(null);
	protected readonly mode = signal<Mode>('find');

	// Library (no search)
	protected readonly items = signal<Meme[]>([]);
	protected readonly total = signal(0);
	protected readonly loading = signal(true);
	protected readonly tags = signal<{ tag: string; count: number }[]>([]);
	protected readonly tag = signal<string | null>(null);
	protected readonly undescribed = signal(false);

	// Find a reaction
	protected query = '';
	protected readonly searched = signal<string | null>(null);
	protected readonly results = signal<Meme[]>([]);
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private searchSeq = 0;

	// Respond to a message
	protected message = '';
	protected readonly shot = signal<File | null>(null);
	protected readonly shotUrl = computed(() => {
		const f = this.shot();
		return f ? URL.createObjectURL(f) : null;
	});
	protected readonly responding = signal(false);
	protected readonly reply = signal<RespondResult | null>(null);

	// Selection, upload, detail
	protected readonly selected = signal<Set<number>>(new Set());
	protected readonly uploading = signal(0);
	protected readonly dragging = signal(false);
	protected readonly openId = signal<number | null>(null);
	private dragDepth = 0;

	/** Memes with AI work in progress, polled until done. */
	private readonly watching = new Set<number>();
	private pollTimer: ReturnType<typeof setInterval> | undefined;

	/** What the grid shows right now. */
	protected readonly grid = computed<Meme[]>(() => {
		if (this.asking()) {
			const r = this.reply();
			return r ? r.picks : [];
		}
		return this.searched() ? this.results() : this.items();
	});

	protected readonly openMeme = computed(() => {
		const id = this.openId();
		if (id == null) return null;
		const r = this.reply();
		const all = [...this.items(), ...this.results(), ...(r ? [...r.picks, ...r.more] : [])];
		return all.find((m) => m.id === id) ?? null;
	});

	protected readonly selecting = computed(() => this.selected().size > 0);

	async ngOnInit() {
		this.api.me().then((m) => this.me.set(m), () => undefined);
		await Promise.all([this.load(), this.loadTags()]);
	}

	ngOnDestroy() {
		clearInterval(this.pollTimer);
		clearTimeout(this.searchTimer);
	}

	// ── Library ──────────────────────────────────────────────

	async load(more = false) {
		this.loading.set(true);
		try {
			const r = await this.api.list({
				offset: more ? this.items().length : 0,
				limit: PAGE,
				tag: this.tag() ?? undefined,
				undescribed: this.undescribed(),
			});
			this.items.set(more ? [...this.items(), ...r.items] : r.items);
			this.total.set(r.total);
			this.watchBusy(r.items);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.loading.set(false);
		}
	}

	async loadTags() {
		try {
			this.tags.set(await this.api.tags());
		} catch {
			/* not essential */
		}
	}

	setTag(t: string | null) {
		this.tag.set(this.tag() === t ? null : t);
		this.undescribed.set(false);
		this.load();
	}

	toggleUndescribed() {
		this.undescribed.update((v) => !v);
		this.tag.set(null);
		this.load();
	}

	// ── Find a reaction ──────────────────────────────────────

	setMode(m: Mode) {
		// Picks for a message don't answer a situation, and the other way round
		if (m !== this.mode() && m !== 'find' && this.mode() !== 'find') this.reply.set(null);
		this.mode.set(m);
		this.selected.set(new Set());
	}

	/** Reply to a message / describe a situation: both ask Claude. */
	protected readonly asking = computed(() => this.mode() !== 'find');
	protected readonly askPlaceholder = computed(() =>
		this.mode() === 'situation'
			? "Describe what's going on, e.g. my coworker presented my idea as his own in the meeting…"
			: 'Paste the message you got, or paste / drop a screenshot of it…',
	);

	onQuery() {
		clearTimeout(this.searchTimer);
		this.searchTimer = setTimeout(() => this.runSearch(), 250);
	}

	async runSearch() {
		clearTimeout(this.searchTimer);
		const q = this.query.trim();
		const seq = ++this.searchSeq;
		if (!q) {
			this.searched.set(null);
			this.results.set([]);
			return;
		}
		try {
			const r = await this.api.search(q);
			if (seq !== this.searchSeq) return; // a newer search is on its way
			this.results.set(r.items);
			this.searched.set(q);
			this.watchBusy(r.items);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	clearSearch() {
		this.query = '';
		this.runSearch();
	}

	// ── Reply to a message / describe a situation ────────────

	async respond() {
		const kind = this.mode();
		if (kind === 'find' || (!this.message.trim() && !this.shot())) return;
		this.responding.set(true);
		this.reply.set(null);
		try {
			const r = await this.api.respond(kind, this.message.trim(), this.shot());
			this.reply.set(r);
			if (!r.picks.length && !r.more.length) this.toasts.show('Nothing in your library fits yet');
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.responding.set(false);
		}
	}

	attachShot(files: FileList | null) {
		const f = files?.[0];
		if (f && f.type.startsWith('image/')) this.shot.set(f);
	}

	clearShot() {
		const url = this.shotUrl();
		if (url) URL.revokeObjectURL(url);
		this.shot.set(null);
	}

	onMessageKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			this.respond();
		}
	}

	// ── Upload (button, drag & drop, paste) ──────────────────

	async upload(files: File[]) {
		const images = files.filter((f) => /^image\/(jpeg|png|webp|gif)$/.test(f.type));
		if (!images.length) {
			if (files.length) this.toasts.error('Only JPG, PNG, WebP and GIF images');
			return;
		}
		this.uploading.update((n) => n + images.length);
		try {
			// A few at a time keeps requests small and shows progress
			for (let i = 0; i < images.length; i += 10) {
				const batch = images.slice(i, i + 10);
				const r = await this.api.upload(batch);
				this.uploading.update((n) => n - batch.length);
				if (r.created.length) {
					this.items.update((l) => [...r.created, ...l.filter((m) => !r.created.some((c) => c.id === m.id))]);
					this.total.update((t) => t + r.created.length);
				}
				if (r.duplicates.length) this.toasts.show(`${r.duplicates.length} already in your library`);
				for (const err of r.errors) this.toasts.error(`${err.name}: ${err.error}`);
				if (r.created.length && this.me()?.hasApiKey) {
					// New images get descriptions straight away
					await this.generate(r.created.map((m) => m.id), true);
				}
			}
			if (this.searched() || this.asking() || this.tag() || this.undescribed()) {
				this.toasts.show('Uploaded. Showing your library.');
				this.mode.set('find');
				this.query = '';
				this.searched.set(null);
				this.tag.set(null);
				this.undescribed.set(false);
				await this.load();
			}
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.uploading.set(0);
		}
	}

	pick(input: HTMLInputElement) {
		this.upload([...(input.files ?? [])]);
		input.value = '';
	}

	@HostListener('document:paste', ['$event'])
	onPaste(e: ClipboardEvent) {
		const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
		if (!files.length || this.openId() != null) return;
		e.preventDefault();
		// When asking Claude, a pasted screenshot goes with the question; otherwise it's a new meme
		if (this.asking()) this.shot.set(files[0]);
		else this.upload(files);
	}

	@HostListener('document:dragenter', ['$event'])
	onDragEnter(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		this.dragDepth++;
		this.dragging.set(true);
	}

	@HostListener('document:dragleave')
	onDragLeave() {
		if (--this.dragDepth <= 0) {
			this.dragDepth = 0;
			this.dragging.set(false);
		}
	}

	@HostListener('document:dragover', ['$event'])
	onDragOver(e: DragEvent) {
		if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
	}

	@HostListener('document:drop', ['$event'])
	onDrop(e: DragEvent) {
		if (!e.dataTransfer?.files.length) return;
		e.preventDefault();
		this.dragDepth = 0;
		this.dragging.set(false);
		const files = [...e.dataTransfer.files];
		if (this.asking()) this.attachShot(e.dataTransfer.files);
		else this.upload(files);
	}

	// ── Selection & bulk actions ─────────────────────────────

	toggle(id: number, e?: Event) {
		e?.stopPropagation();
		this.selected.update((s) => {
			const n = new Set(s);
			if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
	}

	selectAll() {
		this.selected.set(new Set(this.grid().map((m) => m.id)));
	}

	clearSelection() {
		this.selected.set(new Set());
	}

	open(m: Meme) {
		if (this.selecting()) this.toggle(m.id);
		else this.openId.set(m.id);
	}

	async generate(ids: number[], quiet = false) {
		if (!this.me()?.hasApiKey) {
			this.toasts.error('Add your Claude API key in Settings first');
			return;
		}
		try {
			const r = await this.api.generate(ids);
			this.patch(ids.map((id) => ({ id, aiStatus: r.queued.includes(id) ? 'queued' : undefined })));
			r.queued.forEach((id) => this.watching.add(id));
			this.startPolling();
			if (!quiet) this.toasts.show(`Describing ${r.queued.length} image${r.queued.length === 1 ? '' : 's'}…`);
			this.clearSelection();
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	async removeSelected() {
		const ids = [...this.selected()];
		if (!confirm(`Delete ${ids.length} image${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
		try {
			await this.api.remove(ids);
			this.dropIds(ids);
			this.clearSelection();
			this.loadTags();
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	async quickCopy(m: Meme, e: Event) {
		e.stopPropagation();
		try {
			await copyImage(m.url);
			this.toasts.show('Copied! Paste it anywhere.');
		} catch (err) {
			this.toasts.error(errorMessage(err));
		}
	}

	// ── Keeping lists in sync ────────────────────────────────

	/** Replaces memes (by id) in every list on the page. */
	private replace(updated: Meme[]) {
		const byId = new Map(updated.map((m) => [m.id, m]));
		const swap = (l: Meme[]) => l.map((m) => (byId.has(m.id) ? { ...byId.get(m.id)!, matched: m.matched, reason: m.reason } : m));
		this.items.update(swap);
		this.results.update(swap);
		this.reply.update((r) => (r ? { ...r, picks: swap(r.picks), more: swap(r.more) } : r));
	}

	private patch(changes: { id: number; aiStatus?: Meme['aiStatus'] }[]) {
		const map = new Map(changes.filter((c) => c.aiStatus).map((c) => [c.id, c.aiStatus!]));
		const upd = (l: Meme[]) => l.map((m) => (map.has(m.id) ? { ...m, aiStatus: map.get(m.id)! } : m));
		this.items.update(upd);
		this.results.update(upd);
		this.reply.update((r) => (r ? { ...r, picks: upd(r.picks), more: upd(r.more) } : r));
	}

	private dropIds(ids: number[]) {
		const gone = (l: Meme[]) => l.filter((m) => !ids.includes(m.id));
		this.items.update(gone);
		this.results.update(gone);
		this.reply.update((r) => (r ? { ...r, picks: gone(r.picks), more: gone(r.more) } : r));
		this.total.update((t) => Math.max(0, t - ids.length));
	}

	onChanged(m: Meme) {
		this.replace([m]);
		this.loadTags();
	}

	onDeleted(id: number) {
		this.openId.set(null);
		this.dropIds([id]);
		this.loadTags();
	}

	private watchBusy(list: Meme[]) {
		for (const m of list) if (m.aiStatus === 'queued' || m.aiStatus === 'running') this.watching.add(m.id);
		if (this.watching.size) this.startPolling();
	}

	private startPolling() {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => this.poll(), 2000);
	}

	private async poll() {
		if (!this.watching.size) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
			return;
		}
		try {
			const fresh = await this.api.lookup([...this.watching]);
			this.replace(fresh);
			let finished = 0;
			for (const m of fresh) {
				if (m.aiStatus !== 'queued' && m.aiStatus !== 'running') {
					this.watching.delete(m.id);
					finished++;
				}
			}
			// Deleted meanwhile
			for (const id of [...this.watching]) if (!fresh.some((m) => m.id === id)) this.watching.delete(id);
			if (finished) this.loadTags();
		} catch {
			/* try again next tick */
		}
	}

	protected busyCount = () => this.watching.size;
}
