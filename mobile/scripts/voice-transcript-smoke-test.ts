import assert from 'node:assert/strict';

import {
  extractTranscriptFromRealtimePayload,
  extractUserAudioTranscriptFromItem,
  isInputAudioTranscriptEvent,
} from '../src/services/realtimeEventUtils';
import {
  applyInputTranscriptToMessages,
  VOICE_MESSAGE_PLACEHOLDER,
} from '../src/hooks/voiceTranscriptUtils';

type Message = {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
};

const createUserMessage = (id: string, text: string): Message => ({
  id,
  type: 'user',
  text,
  timestamp: new Date('2026-03-03T00:00:00.000Z'),
});

const realtimeEvents = [
  {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'show me the weather in sf',
  },
  {
    type: 'conversation.item.input_audio_transcription.done',
    text: 'what meetings do I have?',
  },
  {
    type: 'conversation.item.input_audio_transcription.completed',
    item: {
      content: [{ type: 'input_audio', transcript: 'book a table for two' }],
    },
    content_index: 0,
  },
];

for (const event of realtimeEvents) {
  console.log('[ws-event]', event.type, JSON.stringify(event));
}

assert.equal(
  isInputAudioTranscriptEvent('conversation.item.input_audio_transcription.completed'),
  true,
  'completed event should be recognized',
);
assert.equal(
  isInputAudioTranscriptEvent('conversation.item.input_audio_transcription.done'),
  true,
  'done event should be recognized',
);
assert.equal(
  extractTranscriptFromRealtimePayload(realtimeEvents[0]),
  'show me the weather in sf',
  'transcript should be read from payload.transcript',
);
assert.equal(
  extractTranscriptFromRealtimePayload(realtimeEvents[1]),
  'what meetings do I have?',
  'transcript should fall back to payload.text',
);
assert.equal(
  extractTranscriptFromRealtimePayload(realtimeEvents[2]),
  'book a table for two',
  'transcript should be read from item.content when direct fields are missing',
);

const userAudioItemTranscript = extractUserAudioTranscriptFromItem({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_audio', transcript: 'send this to team' }],
});
assert.equal(
  userAudioItemTranscript,
  'send this to team',
  'user audio transcript should be extracted from conversation.item.created payloads',
);

const pendingMatchResult = applyInputTranscriptToMessages<Message>(
  [createUserMessage('pending-1', VOICE_MESSAGE_PLACEHOLDER)],
  'pending id transcript',
  'pending-1',
  (text) => createUserMessage('new-1', text),
);
assert.equal(pendingMatchResult.strategy, 'pending_id');
assert.equal(pendingMatchResult.messages[0].text, 'pending id transcript');

const fallbackResult = applyInputTranscriptToMessages<Message>(
  [createUserMessage('placeholder-1', VOICE_MESSAGE_PLACEHOLDER)],
  'fallback transcript',
  'missing-id',
  (text) => createUserMessage('new-2', text),
);
assert.equal(fallbackResult.strategy, 'placeholder_fallback');
assert.equal(fallbackResult.messages[0].text, 'fallback transcript');

const appendResult = applyInputTranscriptToMessages<Message>(
  [createUserMessage('plain-user', 'typed text')],
  'new transcript',
  'missing-id',
  (text) => createUserMessage('new-3', text),
);
assert.equal(appendResult.strategy, 'appended');
assert.equal(appendResult.messages[1].text, 'new transcript');
assert.equal(appendResult.messages[1].id, 'new-3');

console.log('voice-transcript-smoke-test passed');
