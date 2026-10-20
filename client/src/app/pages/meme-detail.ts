import { Component, computed, effect, HostListener, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, Candidate, errorMessage, ImproveMode, Meme, SimilarBy } from '../api';
import { copyImage, downloadImage, extensionFor } from '../clipboard';
import { Toasts } from '../toast';

/** The big view of one meme: copy it, and edit its descriptions and tags. */
@Component({
	selector: 'app-meme-detail',
	imports: [FormsModule],
	template: `
		<div class="fixed inset-0 z-40 bg-black/75 backdrop-blur-sm" (click)="close()"></div>
		<div
			class="fixed inset-x-0 bottom-0 top-6 z-50 mx-auto flex max-w-6xl flex-col overflow-hidden rounded-t-2xl border border-zinc-800 bg-zinc-950 shadow-2xl sm:inset-x-4 sm:top-10 sm:bottom-10 sm:rounded-2xl lg:flex-row"
			role="dialog"
			aria-modal="true"
		>
			<div class="relative flex min-h-56 flex-1 flex-col bg-[repeating-conic-gradient(#18181b_0%_25%,#111113_0%_50%)] bg-[length:24px_24px] lg:min-h-0">
				@if (candidates().length) {
					<div class="flex flex-wrap justify-center gap-1 border-b border-zinc-800 bg-zinc-950/80 p-2 text-xs">
						<button type="button" class="rounded-md px-3 py-1.5 font-medium" [class]="viewing() === null ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-100'" (click)="viewing.set(null)">
							Current · {{ meme().width }}×{{ meme().height }}
						</button>
						@for (c of candidates(); track c.id) {
							<button type="button" class="rounded-md px-3 py-1.5 font-medium" [class]="viewing() === c.id ? 'bg-amber-400 text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'" (click)="viewing.set(c.id)">
								New ({{ c.kind === 'web' ? 'online' : 'AI' }}) · {{ c.width }}×{{ c.height }}
							</button>
						}
					</div>
				}
				<div class="relative flex min-h-0 flex-1 items-center justify-center p-4">
					@if (hasPrev()) {
						<button type="button" class="absolute left-2 top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-2xl text-white backdrop-blur transition hover:bg-amber-400 hover:text-zinc-950" (click)="go(-1)" aria-label="Previous image (Left arrow)" title="Previous (←)">‹</button>
					}
					@if (hasNext()) {
						<button type="button" class="absolute right-2 top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-2xl text-white backdrop-blur transition hover:bg-amber-400 hover:text-zinc-950" (click)="go(1)" aria-label="Next image (Right arrow)" title="Next (→)">›</button>
					}
					<img [src]="shownUrl()" [alt]="meme().title ?? ''" class="max-h-full max-w-full rounded-lg object-contain shadow-xl" />
				</div>
				<div class="flex flex-wrap items-center justify-center gap-2 border-t border-zinc-800 bg-zinc-950/80 p-3">
					<button type="button" class="btn-primary" (click)="copy()">Copy image</button>
					<button type="button" class="btn-secondary" (click)="download()">Download</button>
					@if (meme().animated) {
						<span class="text-xs text-zinc-500">Copy pastes a still frame; Download keeps the animation.</span>
					}
				</div>
			</div>

			<div class="flex w-full flex-col border-zinc-800 lg:w-[26rem] lg:border-l">
				<div class="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
					<input class="input border-transparent bg-transparent px-0 text-lg font-semibold focus:ring-0" placeholder="Untitled" [(ngModel)]="title" (ngModelChange)="dirty.set(true)" />
					@if (position()) {
						<span class="shrink-0 text-xs tabular-nums text-zinc-500">{{ position() }}</span>
					}
					<button type="button" class="btn-ghost -mr-2 shrink-0 px-2 text-xl leading-none" (click)="close()" aria-label="Close">×</button>
				</div>

				<div class="flex-1 space-y-6 overflow-y-auto px-5 py-4">
					@if (candidates().length) {
						<section class="rounded-xl border border-amber-500/40 bg-amber-400/5 p-3">
							<h3 class="text-sm font-semibold text-amber-200">Better version ready to review</h3>
							<p class="mt-0.5 text-xs text-zinc-400">Compare with the tabs above the image. Your current image stays until you choose to use a new one.</p>
							@for (c of candidates(); track c.id) {
								<div class="mt-3 flex gap-3">
									<button type="button" class="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900" (click)="viewing.set(c.id)" aria-label="Show this version">
										<img [src]="c.url" alt="" class="h-full w-full object-cover" />
									</button>
									<div class="min-w-0 flex-1 text-xs">
										<div class="font-medium text-zinc-200">
											{{ c.kind === 'web' ? 'Found online' : 'AI enhanced' }} · {{ c.width }}×{{ c.height }} · {{ size(c.bytes) }}
										</div>
										@if (c.sourcePage || c.sourceUrl) {
											<a [href]="c.sourcePage || c.sourceUrl" target="_blank" rel="noopener noreferrer" class="block truncate text-zinc-500 hover:text-zinc-300">{{ host(c.sourcePage || c.sourceUrl) }}</a>
										} @else if (c.kind === 'enhance') {
											<div class="text-zinc-500">Check any text on the image: AI can warp letters.</div>
										}
										<div class="mt-2 flex gap-2">
											<button type="button" class="btn-primary px-2.5 py-1 text-xs" (click)="accept(c)" [disabled]="reviewing()">Use this version</button>
											<button type="button" class="btn-ghost px-2.5 py-1 text-xs" (click)="discard(c)" [disabled]="reviewing()">Discard</button>
										</div>
									</div>
								</div>
							}
						</section>
					}

					<section>
						<div class="flex items-center justify-between gap-2">
							<h3 class="text-sm font-semibold text-zinc-200">More like this</h3>
							<div class="flex rounded-full border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
								@for (t of similarTabs; track t.by) {
									<button
										type="button"
										class="rounded-full px-2.5 py-1 font-medium transition"
										[class]="similarBy() === t.by ? 'bg-amber-400 text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'"
										(click)="similarBy.set(t.by)"
										[title]="t.hint"
									>
										{{ t.label }}
									</button>
								}
							</div>
						</div>
						@if (similarLoading()) {
							<p class="mt-3 text-xs text-zinc-500">Looking…</p>
						} @else {
							@if (similar().length) {
								<div class="-mx-5 mt-3 flex gap-2 overflow-x-auto px-5 pb-1">
									@for (s of similar(); track s.id) {
										<div class="group relative shrink-0">
											<button
												type="button"
												class="block size-24 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 transition hover:border-amber-400"
												(click)="openOther.emit({ meme: s, list: similar() })"
												[title]="s.matched ? '“' + s.matched + '”' : (s.title ?? '')"
											>
												<img [src]="s.thumbUrl" [alt]="s.title ?? ''" loading="lazy" class="size-full object-cover" />
											</button>
											<button
												type="button"
												class="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur hover:bg-amber-400 hover:text-zinc-950"
												[class.!bg-emerald-500]="copiedId() === s.id"
												(click)="copyOther(s)"
											>
												{{ copiedId() === s.id ? 'Copied' : 'Copy' }}
											</button>
										</div>
									}
								</div>
							}
							@if (similarNote()) {
								<p class="mt-2 text-xs text-zinc-500">{{ similarNote() }}</p>
							}
						}
					</section>

					<section>
						<div class="flex items-center justify-between">
							<h3 class="text-sm font-semibold text-zinc-200">Image quality</h3>
							<span class="text-xs" [class]="meme().lowRes ? 'text-amber-300' : 'text-zinc-500'">
								{{ meme().width }}×{{ meme().height }}{{ meme().lowRes ? ' · low-res' : '' }}
							</span>
						</div>
						@if (improveBusy()) {
							<p class="mt-2 flex items-center gap-2 text-xs text-violet-200">
								<span class="size-3 animate-spin rounded-full border-2 border-violet-900 border-t-violet-300"></span>
								{{ meme().improveStatus === 'queued' ? 'Waiting…' : 'Looking for a better version…' }}
							</p>
						} @else {
							<div class="mt-2 flex flex-wrap gap-2">
								<button
									type="button"
									class="btn-secondary px-2.5 py-1.5 text-xs"
									(click)="improve('web')"
									[disabled]="!canSearch()"
									[title]="canSearch() ? 'Search the internet for a bigger copy of this exact image' : 'Set up reverse image search in Settings first'"
								>
									🔎 Find better copy online
								</button>
								<button
									type="button"
									class="btn-secondary px-2.5 py-1.5 text-xs"
									(click)="improve('enhance')"
									[disabled]="meme().animated"
									[title]="meme().animated ? 'Not available for animated GIFs' : 'Upscale 4x with AI, on this server'"
								>
									✨ AI enhance
								</button>
							</div>
							@if (meme().improveStatus === 'error' && meme().improveError) {
								<p class="mt-2 text-xs text-zinc-400">Last try: {{ meme().improveError }}</p>
							}
						}
					</section>

					<section>
						<div class="flex items-center justify-between">
							<h3 class="text-sm font-semibold text-zinc-200">Descriptions</h3>
							<span class="text-xs text-zinc-500">{{ lineCount() }} lines</span>
						</div>
						<p class="mt-1 text-xs text-zinc-500">One per line. What you'd mean or say by sending it, and when you'd use it.</p>
						<textarea
							class="input mt-2 min-h-56 resize-y font-mono text-[13px] leading-6"
							[(ngModel)]="descriptions"
							(ngModelChange)="dirty.set(true)"
							placeholder="really?&#10;what did you just say&#10;when someone replies-all to the whole company"
						></textarea>
					</section>

					<section>
						<h3 class="text-sm font-semibold text-zinc-200">Tags</h3>
						<div class="mt-2 flex flex-wrap gap-1.5">
							@for (t of tags(); track t) {
								<span class="chip">
									{{ t }}
									<button type="button" class="-mr-1 px-0.5 text-zinc-500 hover:text-zinc-100" (click)="removeTag(t)" [attr.aria-label]="'Remove ' + t">×</button>
								</span>
							}
						</div>
						<input
							class="input mt-2"
							placeholder="Add tags (Enter or comma)"
							[(ngModel)]="tagDraft"
							(keydown.enter)="$event.preventDefault(); addTags()"
							(keydown.backspace)="tagDraft === '' && removeTag(tags()[tags().length - 1])"
							(ngModelChange)="tagDraft.includes(',') && addTags()"
							(blur)="addTags()"
						/>
					</section>

					@if (meme().ocrText) {
						<section>
							<h3 class="text-sm font-semibold text-zinc-200">Text on the image</h3>
							<p class="mt-1 whitespace-pre-line text-sm text-zinc-400">{{ meme().ocrText }}</p>
						</section>
					}

					@if (meme().aiStatus === 'error') {
						<p class="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-200">AI: {{ meme().aiError }}</p>
					}
				</div>

				<div class="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-5 py-3">
					<button type="button" class="btn-secondary" (click)="generate()" [disabled]="aiBusy()">
						@if (aiBusy()) {
							<span class="size-3.5 animate-spin rounded-full border-2 border-zinc-500 border-t-amber-400"></span> Writing…
						} @else {
							✨ AI describe
						}
					</button>
					<button type="button" class="btn-danger" (click)="remove()">Delete</button>
					<button type="button" class="btn-primary ml-auto" (click)="save()" [disabled]="!dirty() || saving()">
						{{ saving() ? 'Saving…' : dirty() ? 'Save' : 'Saved' }}
					</button>
				</div>
			</div>
		</div>
	`,
})
export class MemeDetail {
	private readonly api = inject(Api);
	private readonly toasts = inject(Toasts);

	readonly meme = input.required<Meme>();
	readonly changed = output<Meme>();
	readonly deleted = output<number>();
	readonly generateRequested = output<number>();
	readonly improveRequested = output<{ id: number; mode: ImproveMode }>();
	/** Whether a reverse image search service is set up. */
	readonly canSearch = input(false);
	/** Previous / next in the list the image was opened from. */
	readonly hasPrev = input(false);
	readonly hasNext = input(false);
	/** e.g. "3 / 40". */
	readonly position = input<string | null>(null);
	readonly navigate = output<-1 | 1>();
	/** Open another meme (from "More like this"); its list becomes the one next / previous move through. */
	readonly openOther = output<{ meme: Meme; list: Meme[] }>();
	readonly closed = output<void>();

	protected title = '';
	protected descriptions = '';
	protected tagDraft = '';
	protected readonly tags = signal<string[]>([]);
	protected readonly dirty = signal(false);
	protected readonly saving = signal(false);
	protected readonly aiBusy = computed(() => ['queued', 'running'].includes(this.meme().aiStatus));
	protected lineCount = () => this.lines().length;

	protected readonly similarTabs: { by: SimilarBy; label: string; hint: string }[] = [
		{ by: 'meaning', label: 'Same vibe', hint: 'Says something similar (from the descriptions)' },
		{ by: 'look', label: 'Same look', hint: 'Same template, character or scene' },
	];
	protected readonly similarBy = signal<SimilarBy>('meaning');
	protected readonly similar = signal<Meme[]>([]);
	protected readonly similarNote = signal<string | null>(null);
	protected readonly similarLoading = signal(false);
	protected readonly copiedId = signal<number | null>(null);
	private similarSeq = 0;

	protected readonly candidates = signal<Candidate[]>([]);
	/** Which version the big image shows: null = current, else a candidate id. */
	protected readonly viewing = signal<number | null>(null);
	protected readonly reviewing = signal(false);
	protected readonly improveBusy = computed(() => ['queued', 'running'].includes(this.meme().improveStatus));
	protected readonly shownUrl = computed(() => {
		const id = this.viewing();
		return (id != null && this.candidates().find((c) => c.id === id)?.url) || this.meme().url;
	});

	constructor() {
		// Refresh the fields when the meme changes (e.g. AI finished), unless the user is editing
		effect(() => {
			const m = this.meme();
			untracked(() => {
				if (this.dirty()) return;
				this.title = m.title ?? '';
				this.descriptions = m.descriptions.map((d) => d.text).join('\n');
				this.tags.set([...m.tags]);
			});
		});

		// "More like this" for the meme on screen and the chosen tab
		effect(() => {
			const id = this.meme().id;
			const by = this.similarBy();
			untracked(() => this.loadSimilar(id, by));
		});

		// (Re)load better versions when the meme or its count of them changes
		effect(() => {
			const { id, candidates } = this.meme();
			untracked(() => this.loadCandidates(id, candidates));
		});
	}

	private async loadCandidates(id: number, count: number) {
		if (!count) {
			this.candidates.set([]);
			this.viewing.set(null);
			return;
		}
		try {
			const list = await this.api.candidates(id);
			this.candidates.set(list);
			// Show the newest suggestion straight away, for comparing
			if (list.length && !list.some((c) => c.id === this.viewing())) this.viewing.set(list[0].id);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	private async loadSimilar(id: number, by: SimilarBy) {
		const seq = ++this.similarSeq;
		this.similarLoading.set(true);
		try {
			const r = await this.api.similar(id, by);
			if (seq !== this.similarSeq) return; // moved on to another image
			this.similar.set(r.items);
			this.similarNote.set(r.note);
		} catch (e) {
			if (seq === this.similarSeq) this.similarNote.set(errorMessage(e));
		} finally {
			if (seq === this.similarSeq) this.similarLoading.set(false);
		}
	}

	async copyOther(m: Meme) {
		try {
			await copyImage(m.url);
			this.copiedId.set(m.id);
			setTimeout(() => this.copiedId.update((v) => (v === m.id ? null : v)), 1800);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	/** Next / previous image; unsaved edits are saved first. */
	async go(dir: -1 | 1) {
		if (dir === -1 ? !this.hasPrev() : !this.hasNext()) return;
		if (this.dirty()) await this.save();
		this.navigate.emit(dir);
	}

	@HostListener('document:keydown', ['$event'])
	onKey(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		const t = e.target as HTMLElement | null;
		// Arrow keys move the cursor while typing
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		this.go(e.key === 'ArrowLeft' ? -1 : 1);
	}

	improve(mode: ImproveMode) {
		this.improveRequested.emit({ id: this.meme().id, mode });
	}

	/** Replacing the image only ever happens here, after the user confirms. */
	async accept(c: Candidate) {
		const m = this.meme();
		const question = `Replace the current image (${m.width}×${m.height}) with this version (${c.width}×${c.height})? Descriptions and tags stay.`;
		if (!confirm(question)) return;
		this.reviewing.set(true);
		try {
			const updated = await this.api.acceptCandidate(m.id, c.id);
			this.viewing.set(null);
			this.changed.emit(updated);
			this.toasts.show('Image replaced');
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.reviewing.set(false);
		}
	}

	async discard(c: Candidate) {
		this.reviewing.set(true);
		try {
			const updated = await this.api.discardCandidate(this.meme().id, c.id);
			this.candidates.update((l) => l.filter((x) => x.id !== c.id));
			if (this.viewing() === c.id) this.viewing.set(null);
			this.changed.emit(updated);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.reviewing.set(false);
		}
	}

	size(bytes: number) {
		return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}

	host(url: string | null) {
		try {
			return url ? new URL(url).hostname.replace(/^www\./, '') : '';
		} catch {
			return '';
		}
	}

	private lines() {
		return this.descriptions
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
	}

	@HostListener('document:keydown.escape')
	close() {
		if (this.dirty()) this.save().finally(() => this.closed.emit());
		else this.closed.emit();
	}

	addTags() {
		const add = this.tagDraft
			.split(',')
			.map((t) => t.trim().toLowerCase().replace(/^#/, ''))
			.filter(Boolean);
		this.tagDraft = '';
		if (!add.length) return;
		this.tags.update((l) => [...new Set([...l, ...add])]);
		this.dirty.set(true);
	}

	removeTag(t: string | undefined) {
		if (!t) return;
		this.tags.update((l) => l.filter((x) => x !== t));
		this.dirty.set(true);
	}

	async save() {
		this.addTags();
		this.saving.set(true);
		try {
			const m = await this.api.update(this.meme().id, {
				title: this.title.trim() || null,
				descriptions: this.lines(),
				tags: this.tags(),
			});
			this.dirty.set(false);
			this.changed.emit(m);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.saving.set(false);
		}
	}

	async generate() {
		if (this.dirty()) await this.save();
		this.generateRequested.emit(this.meme().id);
	}

	async copy() {
		try {
			await copyImage(this.meme().url);
			this.toasts.show('Copied! Paste it anywhere.');
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	download() {
		const m = this.meme();
		const base = (m.title || m.originalName?.replace(/\.[^.]+$/, '') || `meme-${m.id}`).replace(/[^\w\- ]+/g, '').trim();
		downloadImage(m.url, `${base || 'meme'}.${extensionFor(m.mime)}`).catch((e) => this.toasts.error(errorMessage(e)));
	}

	async remove() {
		if (!confirm('Delete this image? This cannot be undone.')) return;
		try {
			await this.api.remove([this.meme().id]);
			this.deleted.emit(this.meme().id);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}
}
