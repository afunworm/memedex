import { BadRequestException, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { UsersService } from '../users/users.service';
import { AiSuggestion } from '../memes/memes.service';

type ImageInput = { data: string; mediaType: 'image/jpeg' | 'image/png' };
type Effort = 'low' | 'medium' | 'high';

/** Models that accept server-side refusal fallbacks ("default" routing). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export class ClaudeError extends Error {}

const DESCRIBE_SYSTEM = `You catalogue reaction memes and reaction images so they can be found later when someone wants to reply to a message with one.

People search in two ways:
1. They type the reaction they want ("eye roll", "slow clap", "this is fine").
2. They paste a message they received and want an image that answers it.

So for each image, write:
- descriptions: 8-15 short lines, each a different way the image gets used. Most should be things a person would mean or say when they send it (e.g. a dog raising its eyebrows: "really?", "what did you just say", "excuse me?", "I'm going to pretend I didn't hear that"). Also include a few situations it replies to ("when someone says something wildly inappropriate at work") and one or two plain descriptions of what's shown, including the name of the meme or the people / characters if well known. Cover different moods and phrasings; don't repeat the same idea with small word changes. Keep each line under 15 words.
- tags: 5-15 single words or short phrases, lower case: emotions, reaction type, subject, meme name, source (movie / show / game) when known.
- title: a 2-6 word name for the image (the meme's common name if it has one).
- ocr_text: the text written on the image, exactly as written, or "" if none.

If the user already wrote descriptions or tags, they are shown to you; add new ideas rather than repeating theirs.`;

const DESCRIBE_SCHEMA = {
	type: 'object',
	properties: {
		title: { type: 'string' },
		ocr_text: { type: 'string' },
		descriptions: { type: 'array', items: { type: 'string' } },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['title', 'ocr_text', 'descriptions', 'tags'],
	additionalProperties: false,
};

const ANALYZE_SYSTEM = `Someone received a message (as text, a screenshot, or both) and wants to reply with a reaction meme or reaction image. Work out what a fitting reply would express.

Return:
- summary: one sentence on what the message says and its tone.
- reactions: 6-10 short lines a person might want their reply image to say or express, written the way a person would say it ("really?", "I'm so proud of you", "that's not how any of this works", "slow clap"). Cover several angles: sincere, sarcastic, funny, supportive, as fits the message.
- keywords: 3-8 single words useful for a keyword search (emotions, topics).

If the input is a screenshot of a conversation, reply to the most recent message from the other person.`;

const SITUATION_SYSTEM = `Someone describes a situation they're in, or something that happened, and wants a reaction meme or reaction image that fits it: to post, to send to a friend, or just to capture how it feels. Work out what a fitting reaction would express.

Return:
- summary: one sentence on the situation and the feelings it brings up.
- reactions: 6-10 short lines a person might say or feel in that situation, written the way a person would say it ("I'm fine. Everything is fine.", "why is this happening to me", "nailed it", "of course this happened"). Cover several angles: how they feel, what they'd say to the people involved, what an onlooker would think; funny and sincere, as fits.
- keywords: 3-8 single words useful for a keyword search (emotions, topics).

If an image is attached, it shows part of the situation.`;

export type AskKind = 'message' | 'situation';

const ANALYZE_SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string' },
		reactions: { type: 'array', items: { type: 'string' } },
		keywords: { type: 'array', items: { type: 'string' } },
	},
	required: ['summary', 'reactions', 'keywords'],
	additionalProperties: false,
};

const PICK_SYSTEM = `You pick reaction images. You get either a message someone received (pick images that make a good reply to it) or a situation someone described (pick images that capture a fitting reaction to it), plus numbered candidate images from the user's own collection, each with its descriptions. Choose up to 6 candidates that fit, best first, and give each a short reason (under 15 words) saying what sending it would convey. Only choose candidates that genuinely fit; it is fine to choose fewer, or none.`;

const PICK_SCHEMA = {
	type: 'object',
	properties: {
		picks: {
			type: 'array',
			items: {
				type: 'object',
				properties: { candidate: { type: 'integer' }, reason: { type: 'string' } },
				required: ['candidate', 'reason'],
				additionalProperties: false,
			},
		},
	},
	required: ['picks'],
	additionalProperties: false,
};

export interface MessageAnalysis {
	summary: string;
	reactions: string[];
	keywords: string[];
}

export interface PickCandidate {
	id: number;
	title: string | null;
	descriptions: string[];
	tags: string[];
	image: ImageInput | null;
}

@Injectable()
export class ClaudeService {
	constructor(private readonly users: UsersService) {}

	private client(sub: string): { client: Anthropic; model: string } {
		const apiKey = this.users.apiKey(sub);
		if (!apiKey) throw new BadRequestException('Add your Claude API key in Settings first');
		return { client: new Anthropic({ apiKey, maxRetries: 3 }), model: this.users.model(sub) };
	}

	/** One structured-output request; returns the parsed JSON. */
	private async ask<T>(
		sub: string,
		opts: { system: string; content: Anthropic.Beta.BetaContentBlockParam[]; schema: object; effort: Effort },
	): Promise<T> {
		const { client, model } = this.client(sub);
		const fallback = FALLBACK_MODELS.has(model);
		let res: Anthropic.Beta.BetaMessage;
		try {
			res = await client.beta.messages.create({
				model,
				max_tokens: 16000,
				system: opts.system,
				messages: [{ role: 'user', content: opts.content }],
				output_config: { effort: opts.effort, format: { type: 'json_schema', schema: opts.schema as any } },
				...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
			});
		} catch (e) {
			throw new ClaudeError(describeApiError(e));
		}
		if (res.stop_reason === 'refusal') throw new ClaudeError('Claude declined this request');
		if (res.stop_reason === 'max_tokens') throw new ClaudeError('Claude ran out of output space');
		const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text;
		if (!text) throw new ClaudeError('Claude returned no answer');
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new ClaudeError('Claude returned an unreadable answer');
		}
	}

	/** Quick check that the key and model work. */
	async test(sub: string): Promise<string> {
		const { client, model } = this.client(sub);
		try {
			await client.messages.create({
				model,
				max_tokens: 16,
				output_config: { effort: 'low' },
				messages: [{ role: 'user', content: 'Reply with OK.' }],
			});
			return model;
		} catch (e) {
			throw new ClaudeError(describeApiError(e));
		}
	}

	async describe(sub: string, image: ImageInput, existing: { descriptions: string[]; tags: string[] }): Promise<AiSuggestion> {
		const known =
			existing.descriptions.length || existing.tags.length
				? `Already written by the user:\nDescriptions:\n${existing.descriptions.map((d) => `- ${d}`).join('\n') || '(none)'}\nTags: ${existing.tags.join(', ') || '(none)'}`
				: 'Nothing has been written for this image yet.';
		const out = await this.ask<{ title: string; ocr_text: string; descriptions: string[]; tags: string[] }>(sub, {
			system: DESCRIBE_SYSTEM,
			effort: 'medium',
			schema: DESCRIBE_SCHEMA,
			content: [
				{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
				{ type: 'text', text: known },
			],
		});
		return { title: out.title, ocrText: out.ocr_text, descriptions: out.descriptions ?? [], tags: out.tags ?? [] };
	}

	/** What a reply (to a message) or a reaction (to a situation) should express. */
	async analyze(sub: string, kind: AskKind, text: string, image: ImageInput | null): Promise<MessageAnalysis> {
		const content: Anthropic.Beta.BetaContentBlockParam[] = [];
		if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
		content.push({
			type: 'text',
			text: text ? `<${kind}>\n${text}\n</${kind}>` : `The ${kind} is in the image above.`,
		});
		return this.ask<MessageAnalysis>(sub, {
			system: kind === 'situation' ? SITUATION_SYSTEM : ANALYZE_SYSTEM,
			effort: 'low',
			schema: ANALYZE_SCHEMA,
			content,
		});
	}

	async pick(
		sub: string,
		ask: { kind: AskKind; text: string; summary: string },
		candidates: PickCandidate[],
	): Promise<{ id: number; reason: string }[]> {
		const content: Anthropic.Beta.BetaContentBlockParam[] = [
			{
				type: 'text',
				text: `<${ask.kind}>\n${ask.text || '(see image)'}\n</${ask.kind}>\nIn short: ${ask.summary}\n\nCandidates:`,
			},
		];
		candidates.forEach((c, i) => {
			content.push({
				type: 'text',
				text: `Candidate ${i + 1}${c.title ? ` "${c.title}"` : ''}\nDescriptions: ${c.descriptions.slice(0, 12).join(' | ') || '(none)'}\nTags: ${c.tags.join(', ') || '(none)'}`,
			});
			if (c.image) content.push({ type: 'image', source: { type: 'base64', media_type: c.image.mediaType, data: c.image.data } });
		});
		const out = await this.ask<{ picks: { candidate: number; reason: string }[] }>(sub, {
			system: PICK_SYSTEM,
			effort: 'low',
			schema: PICK_SCHEMA,
			content,
		});
		const seen = new Set<number>();
		return (out.picks ?? [])
			.map((p) => ({ c: candidates[p.candidate - 1], reason: p.reason }))
			.filter((p) => p.c && !seen.has(p.c.id) && seen.add(p.c.id))
			.map((p) => ({ id: p.c.id, reason: p.reason }));
	}
}

function describeApiError(e: unknown): string {
	if (e instanceof Anthropic.AuthenticationError) return 'Your Claude API key was rejected. Check it in Settings.';
	if (e instanceof Anthropic.PermissionDeniedError) return 'Your Claude API key is not allowed to use this model.';
	if (e instanceof Anthropic.NotFoundError) return 'The selected Claude model is not available to your account.';
	if (e instanceof Anthropic.RateLimitError) return 'Claude rate limit reached. Try again in a minute.';
	if (e instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${e.message}`;
	if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API.';
	if (e instanceof Anthropic.APIError) return `Claude API error (${e.status ?? 'unknown'}): ${e.message}`;
	if (e instanceof Error) return e.message;
	return 'Unknown error calling Claude';
}
