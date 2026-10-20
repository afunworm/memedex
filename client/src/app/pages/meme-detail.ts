import { Component, computed, effect, HostListener, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, errorMessage, Meme } from '../api';
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
				<div class="flex min-h-0 flex-1 items-center justify-center p-4">
					<img [src]="meme().url" [alt]="meme().title ?? ''" class="max-h-full max-w-full rounded-lg object-contain shadow-xl" />
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
					<button type="button" class="btn-ghost -mr-2 shrink-0 px-2 text-xl leading-none" (click)="close()" aria-label="Close">×</button>
				</div>

				<div class="flex-1 space-y-6 overflow-y-auto px-5 py-4">
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
	readonly closed = output<void>();

	protected title = '';
	protected descriptions = '';
	protected tagDraft = '';
	protected readonly tags = signal<string[]>([]);
	protected readonly dirty = signal(false);
	protected readonly saving = signal(false);
	protected readonly aiBusy = computed(() => ['queued', 'running'].includes(this.meme().aiStatus));
	protected lineCount = () => this.lines().length;

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
