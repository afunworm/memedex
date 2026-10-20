import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, errorMessage, Settings } from '../api';
import { Toasts } from '../toast';

@Component({
	selector: 'app-settings',
	imports: [FormsModule],
	template: `
		<main class="mx-auto max-w-2xl px-4 py-10">
			<h1 class="font-display text-3xl font-extrabold tracking-tight">Settings</h1>
			<p class="mt-1 text-sm text-zinc-400">These are yours alone. Nobody else using MemeDex sees your key or your images.</p>

			@if (s(); as s) {
				<section class="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
					<h2 class="text-lg font-semibold">Claude API key</h2>
					<p class="mt-1 text-sm text-zinc-400">
						Used to write descriptions and tags, and to suggest replies. Create one at
						<a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener" class="text-amber-400 underline-offset-2 hover:underline">platform.claude.com</a>.
						It's stored encrypted on the server and is never sent back to your browser.
					</p>

					@if (s.encryptionProblem) {
						<p class="mt-4 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-200">
							Keys can't be saved: {{ s.encryptionProblem }}. Ask whoever runs MemeDex to set it.
						</p>
					}
					@if (s.apiKeyProblem) {
						<p class="mt-4 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">{{ s.apiKeyProblem }}</p>
					}

					<div class="mt-4 text-sm">
						@if (s.hasApiKey && !s.apiKeyProblem) {
							<span class="chip border-emerald-800 text-emerald-300">Saved · ends in …{{ s.apiKeyHint }}</span>
						} @else if (!s.hasApiKey) {
							<span class="chip">Not set</span>
						}
					</div>

					<form class="mt-4 flex flex-col gap-2 sm:flex-row" (ngSubmit)="saveKey()">
						<input
							class="input font-mono"
							type="password"
							name="apiKey"
							autocomplete="off"
							[placeholder]="s.hasApiKey ? 'Enter a new key to replace it' : 'sk-ant-…'"
							[(ngModel)]="apiKey"
						/>
						<button class="btn-primary shrink-0" type="submit" [disabled]="!apiKey.trim() || busy()">Save key</button>
					</form>

					@if (s.hasApiKey) {
						<div class="mt-4 flex flex-wrap gap-2">
							<button type="button" class="btn-secondary" (click)="test()" [disabled]="busy()">Test key</button>
							<button type="button" class="btn-danger" (click)="removeKey()" [disabled]="busy()">Remove key</button>
						</div>
					}
				</section>

				<section class="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
					<h2 class="text-lg font-semibold">Model</h2>
					<p class="mt-1 text-sm text-zinc-400">Billed to your key. Opus gives the best descriptions; Haiku is much cheaper for large libraries.</p>
					<div class="mt-4 grid gap-2">
						@for (m of s.models; track m.id) {
							<label
								class="flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm transition"
								[class]="m.id === s.model ? 'border-amber-400 bg-amber-400/5' : 'border-zinc-800 hover:border-zinc-600'"
							>
								<input type="radio" name="model" class="accent-amber-400" [checked]="m.id === s.model" (change)="saveModel(m.id)" />
								<span>{{ m.label }}</span>
								<code class="ml-auto text-xs text-zinc-500">{{ m.id }}</code>
							</label>
						}
					</div>
				</section>
			} @else {
				<p class="mt-8 text-zinc-500">Loading…</p>
			}
		</main>
	`,
})
export class SettingsPage implements OnInit {
	private readonly api = inject(Api);
	private readonly toasts = inject(Toasts);
	protected readonly s = signal<Settings | null>(null);
	protected readonly busy = signal(false);
	protected apiKey = '';

	async ngOnInit() {
		try {
			this.s.set(await this.api.settings());
		} catch (e) {
			this.toasts.error(errorMessage(e));
		}
	}

	private async run(fn: () => Promise<void>) {
		this.busy.set(true);
		try {
			await fn();
		} catch (e) {
			this.toasts.error(errorMessage(e));
		} finally {
			this.busy.set(false);
		}
	}

	saveKey() {
		return this.run(async () => {
			this.s.set(await this.api.saveSettings({ apiKey: this.apiKey.trim() }));
			this.apiKey = '';
			this.toasts.show('Key saved');
			const r = await this.api.testSettings();
			if (!r.ok) this.toasts.error(r.error ?? 'The key did not work');
		});
	}

	removeKey() {
		return this.run(async () => {
			this.s.set(await this.api.saveSettings({ apiKey: '' }));
			this.toasts.show('Key removed');
		});
	}

	test() {
		return this.run(async () => {
			const r = await this.api.testSettings();
			if (r.ok) this.toasts.show(`Works with ${r.model}`);
			else this.toasts.error(r.error ?? 'The key did not work');
		});
	}

	saveModel(model: string) {
		return this.run(async () => {
			this.s.set(await this.api.saveSettings({ model }));
		});
	}
}
