import { describe, expect, it } from 'vitest';

import { ChatProcessingStore } from '#lib/stores/chat/processing.svelte.ts';

describe('processing status', () => {
	it('moves to generating when prompt processing completes at 100%', () => {
		const store = new ChatProcessingStore();
		const conversationId = 'conv';

		store.setActiveConversation(conversationId);
		store.applyStreamTimings(
			{ cache_n: 0, predicted_n: 0, prompt_n: 100 },
			{ cache: 0, processed: 100, time_ms: 1000, total: 100 },
			conversationId
		);

		expect(store.getState(conversationId)?.status).toBe('generating');
		expect(store.getState(conversationId)?.progressPercent).toBe(100);
	});

	it('leaves preparing when the first output chunk arrives', () => {
		const store = new ChatProcessingStore();
		const conversationId = 'conv';

		store.setActiveConversation(conversationId);
		store.applyStreamTimings(
			{ cache_n: 0, predicted_n: 0, prompt_n: 100 },
			{ cache: 0, processed: 50, time_ms: 1000, total: 100 },
			conversationId
		);

		expect(store.getState(conversationId)?.status).toBe('preparing');

		store.markGenerating(conversationId);

		expect(store.getState(conversationId)?.status).toBe('generating');
		expect(store.getState(conversationId)?.progressPercent).toBe(50);
	});
});
