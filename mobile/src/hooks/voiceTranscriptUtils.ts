export const VOICE_MESSAGE_PLACEHOLDER = '[Voice message]';

type MessageLike = {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
};

export type ApplyInputTranscriptResult<TMessage extends MessageLike> = {
  messages: TMessage[];
  strategy: 'pending_id' | 'placeholder_fallback' | 'appended';
  appliedMessageId: string;
};

export const applyInputTranscriptToMessages = <TMessage extends MessageLike>(
  messages: TMessage[],
  transcriptText: string,
  pendingVoiceMessageId: string | null,
  createMessage: (text: string) => TMessage,
): ApplyInputTranscriptResult<TMessage> => {
  let messageIndex = -1;
  let strategy: ApplyInputTranscriptResult<TMessage>['strategy'] = 'appended';

  if (pendingVoiceMessageId) {
    messageIndex = messages.findIndex((message) => message.id === pendingVoiceMessageId);
    if (messageIndex >= 0) {
      strategy = 'pending_id';
    }
  }

  if (messageIndex < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.type === 'user' && message.text === VOICE_MESSAGE_PLACEHOLDER) {
        messageIndex = index;
        strategy = 'placeholder_fallback';
        break;
      }
    }
  }

  if (messageIndex >= 0) {
    const nextMessages = [...messages];
    const target = nextMessages[messageIndex];
    nextMessages[messageIndex] = { ...target, text: transcriptText };
    return {
      messages: nextMessages,
      strategy,
      appliedMessageId: nextMessages[messageIndex].id,
    };
  }

  const appended = createMessage(transcriptText);
  return {
    messages: [...messages, appended],
    strategy: 'appended',
    appliedMessageId: appended.id,
  };
};
