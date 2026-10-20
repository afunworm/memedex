import { Injectable, signal } from '@angular/core';

export interface Toast {
	id: number;
	text: string;
	tone: 'ok' | 'error';
}

/** Short messages in the corner ("Copied!", errors). */
@Injectable({ providedIn: 'root' })
export class Toasts {
	readonly items = signal<Toast[]>([]);
	private next = 1;

	show(text: string, tone: Toast['tone'] = 'ok', ms = tone === 'error' ? 6000 : 2500) {
		const id = this.next++;
		this.items.update((l) => [...l, { id, text, tone }]);
		setTimeout(() => this.dismiss(id), ms);
	}

	error(text: string) {
		this.show(text, 'error');
	}

	dismiss(id: number) {
		this.items.update((l) => l.filter((t) => t.id !== id));
	}
}
