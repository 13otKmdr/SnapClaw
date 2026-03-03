const INPUT_AUDIO_TRANSCRIPTION_EVENT_TYPES = new Set([
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.done',
]);

const extractString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const extractTranscriptFromPart = (part: any): string | null => (
  extractString(part?.transcript)
  || extractString(part?.text)
  || extractString(part?.input_text)
  || extractString(part?.output_text)
);

export const isInputAudioTranscriptEvent = (eventType: unknown): boolean => (
  typeof eventType === 'string' && INPUT_AUDIO_TRANSCRIPTION_EVENT_TYPES.has(eventType)
);

export const extractTranscriptFromRealtimePayload = (payload: any): string | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const directTranscript = extractString(payload.transcript) || extractString(payload.text);
  if (directTranscript) {
    return directTranscript;
  }

  const item = payload.item;
  const parts = Array.isArray(item?.content) ? item.content : [];
  const contentIndex = typeof payload.content_index === 'number' ? payload.content_index : null;

  if (contentIndex !== null && contentIndex >= 0 && contentIndex < parts.length) {
    const indexedTranscript = extractTranscriptFromPart(parts[contentIndex]);
    if (indexedTranscript) {
      return indexedTranscript;
    }
  }

  for (const part of parts) {
    const transcript = extractTranscriptFromPart(part);
    if (transcript) {
      return transcript;
    }
  }

  return null;
};

export const extractUserAudioTranscriptFromItem = (item: any): string | null => {
  if (!item || item.type !== 'message' || item.role !== 'user') {
    return null;
  }

  const parts = Array.isArray(item.content) ? item.content : [];
  for (const part of parts) {
    const partType = typeof part?.type === 'string' ? part.type : '';
    const isAudioInputPart = partType === 'input_audio' || partType === 'audio' || partType === 'input_audio_transcription';
    if (!isAudioInputPart) {
      continue;
    }

    const transcript = extractTranscriptFromPart(part);
    if (transcript) {
      return transcript;
    }
  }

  return null;
};
