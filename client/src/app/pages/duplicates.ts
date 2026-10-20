import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, DuplicateGroup, errorMessage, Meme } from '../api';
import { Toasts } from '../toast';

interface Group extends DuplicateGroup {
	/** The one the user chose to keep (starts as the suggestion). */
	keep: number;
	busy: boolean;
}

/** Same picture at another size / format / compression: keep one, merge the rest into it. */
@Component({
	selector: 'app-duplicates',
	imports: [RouterLink],
	template: `
		<main class="mx-auto max-w-5xl px-4 pb-24 pt-10">
			<a routerLink="/" class="text-sm text-zinc-400 hover:text-zinc-100">← Library</a>
			<div class="mt-3 flex flex-wrap items-end gap-3">
				<div class="mr-auto">
					<h1 class="font-display text-3xl font-extrabold tracking-tight">Duplicates</h1>
					<p class="mt-1 max-w-2xl text-sm text-zinc-400">
						Images that are the same picture at another size, format or quality. The largest is picked to keep; click another to keep
						that one instead. Merging moves every description and tag onto the kept image, then deletes the others.
					</p>
				</div>
				@if (groups().length > 1) {
					<button type="button" class="btn-secondary" (click)="mergeAll()" [disabled]="working()">Merge all {{ groups().length }} groups</button>
				}
			</div>

			@if (loading()) {
				<p class="py-20 text-center text-zinc-500">Looking for look-alikes…</p>
			} @else if (!groups().length) {
				<div class="py-20 text-center">
					<p class="text-5xl">✨</p>
					<p class="mt-4 font-display text-2xl font-bold">No duplicates</p>
					<p class="mt-1 text-sm text-zinc-400">Every image in your library is one of a kind.</p>
				</div>
			} @else {
				<div class="mt-8 space-y-5">
					@for (g of groups(); track g.keepId) {
						<section class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4" [class.opacity-50]="g.busy">
							<div class="flex flex-wrap gap-3">
								@for (m of g.items; track m.id) {
									<button
										type="button"
										class="relative w-40 overflow-hidden rounded-xl border-2 bg-zinc-900 text-left transition sm:w-48"
										[class]="m.id === g.keep ? 'border-amber-400' : 'border-zinc-800 hover:border-zinc-600'"
										(click)="g.keep = m.id; refresh()"
										[disabled]="g.busy"
									>
										<div class="grid h-36 place-items-center bg-zinc-950">
											<img [src]="m.thumbUrl" [alt]="m.title ?? ''" class="max-h-36 max-w-full object-contain" loading="lazy" />
										</div>
										<span
											class="absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
											[class]="m.id === g.keep ? 'bg-amber-400 text-zinc-950' : 'bg-black/70 text-zinc-300'"
										>
											{{ m.id === g.keep ? 'Keep' : 'Remove' }}
										</span>
										<div class="space-y-0.5 px-3 py-2 text-xs">
											<div class="font-medium text-zinc-200">{{ m.width }}×{{ m.height }} · {{ format(m) }}</div>
											<div class="text-zinc-500">{{ size(m.bytes) }} · {{ m.descriptions.length }} description{{ m.descriptions.length === 1 ? '' : 's' }}</div>
											@if (m.title) {
												<div class="truncate text-zinc-400">{{ m.title }}</div>
											}
										</div>
									</button>
								}
							</div>
							<div class="mt-4 flex flex-wrap items-center gap-2">
								<button type="button" class="btn-primary" (click)="merge(g)" [disabled]="g.busy || working()">
									Merge &amp; delete {{ g.items.length - 1 }}
								</button>
								<button type="button" class="btn-ghost" (click)="ignore(g)" [disabled]="g.busy || working()">Not duplicates</button>
							</div>
						</section>
					}
				</div>
			}
		</main>
	`,
})
export class DuplicatesPage implements OnInit {
	private readonly api = inject(Api);
	private readonly toasts = inject(Toasts);
	protected readonly groups = signal<Group[]>([]);
	protected readonly loading = signal(true);
	protected readonly working = signal(false);

	async ngOnInit() {
		try {
			const found = await this.api.duplicates();
			this.groups.set(found.map((g) => ({ ...g, keep: g.keepId, busy: false })));
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.loading.set(false);
		}
	}

	/** Groups are mutated in place (keep / busy); hand the signal a new array so the view updates. */
	refresh() {
		this.groups.update((l) => [...l]);
	}

	private drop(g: Group) {
		this.groups.update((l) => l.filter((x) => x !== g));
	}

	private async doMerge(g: Group) {
		g.busy = true;
		this.refresh();
		try {
			await this.api.mergeDuplicates(
				g.keep,
				g.items.map((m) => m.id).filter((id) => id !== g.keep),
			);
			this.drop(g);
			return true;
		} catch (e) {
			g.busy = false;
			this.refresh();
			this.toasts.error(errorMessage(e));
			return false;
		}
	}

	async merge(g: Group) {
		if (await this.doMerge(g)) this.toasts.show(`Merged; ${g.items.length - 1} removed`);
	}

	async mergeAll() {
		const all = this.groups();
		const removing = all.reduce((n, g) => n + g.items.length - 1, 0);
		if (!confirm(`Merge all ${all.length} groups? ${removing} images will be deleted (their descriptions and tags are kept).`)) return;
		this.working.set(true);
		let ok = 0;
		for (const g of all) if (await this.doMerge(g)) ok++;
		this.working.set(false);
		this.toasts.show(`Merged ${ok} group${ok === 1 ? '' : 's'}`);
	}

	async ignore(g: Group) {
		try {
			await this.api.ignoreDuplicates(g.items.map((m) => m.id));
			this.drop(g);
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	format(m: Meme) {
		return m.mime.replace('image/', '').replace('jpeg', 'jpg').toUpperCase();
	}

	size(bytes: number) {
		return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}
}
