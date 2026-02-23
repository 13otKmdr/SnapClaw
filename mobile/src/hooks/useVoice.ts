import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import * as Speech from 'expo-speech';

import { ApiService } from '../services/api';
import websocket from '../services/websocket';

type SpeechRecognitionModule = {
  startRecognizing: (locale: string) => void;
  stopRecognizing: () => void;
};

const SpeechRecognition = NativeModules.SpeechRecognition as SpeechRecognitionModule | undefined;

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
  actionTaken?: boolean;
  actionResult?: string;
}

interface VoiceState {
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
  isConnected: boolean;
  transcript: string;
  messages: Message[];
  sessionId: string;
  requiresConfirmation: boolean;
  confirmationPrompt: string | null;
}

interface VoiceContextType extends VoiceState {
  startListening: () => Promise<void>;
  stopListening: () => void;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  sendMessage: (text: string) => Promise<void>;
  confirmAction: (confirmed: boolean) => Promise<void>;
  clearHistory: () => void;
}

const VoiceContext = createContext<VoiceContextType | null>(null);

export const useVoice = (): VoiceContextType => {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error('useVoice must be used within VoiceProvider');
  }
  return context;
};

const generateSessionId = () => `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

export const VoiceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<VoiceState>({
    isListening: false,
    isProcessing: false,
    isSpeaking: false,
    isConnected: false,
    transcript: '',
    messages: [],
    sessionId: generateSessionId(),
    requiresConfirmation: false,
    confirmationPrompt: null,
  });

  const eventEmitterRef = useRef<NativeEventEmitter | null>(null);

  const appendMessage = useCallback((message: Message) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, message],
    }));
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) {
      return;
    }

    setState((prev) => ({ ...prev, isSpeaking: true }));

    Speech.speak(text, {
      language: 'en-US',
      rate: 1.0,
      pitch: 1.0,
      onDone: () => setState((prev) => ({ ...prev, isSpeaking: false })),
      onError: () => setState((prev) => ({ ...prev, isSpeaking: false })),
      onStop: () => setState((prev) => ({ ...prev, isSpeaking: false })),
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    Speech.stop();
    setState((prev) => ({ ...prev, isSpeaking: false }));
  }, []);

  const handleAssistantText = useCallback(
    (text: string) => {
      if (!text.trim()) {
        setState((prev) => ({ ...prev, isProcessing: false }));
        return;
      }

      appendMessage({
        id: createMessageId(),
        type: 'assistant',
        text,
        timestamp: new Date(),
      });

      setState((prev) => ({
        ...prev,
        isProcessing: false,
        requiresConfirmation: false,
        confirmationPrompt: null,
      }));

      speak(text).catch(() => undefined);
    },
    [appendMessage, speak],
  );

  useEffect(() => {
    let isMounted = true;

    const connectWs = async () => {
      try {
        await websocket.connect(state.sessionId);
        if (isMounted) {
          setState((prev) => ({ ...prev, isConnected: true }));
        }
      } catch (error) {
        if (isMounted) {
          setState((prev) => ({ ...prev, isConnected: false }));
        }
      }
    };

    const onResponse = (data: { text?: string }) => {
      if (data?.text) {
        handleAssistantText(data.text);
      }
    };

    const onTaskUpdate = (event: any) => {
      const task = event?.task;
      if (!task?.task_id || !task?.status) {
        return;
      }

      const statusText = `Task ${task.task_id}: ${task.status}`;
      appendMessage({
        id: createMessageId(),
        type: 'system',
        text: statusText,
        timestamp: new Date(),
      });
    };

    const onError = (event: any) => {
      const message = typeof event?.error === 'string' ? event.error : 'Realtime connection error';
      appendMessage({
        id: createMessageId(),
        type: 'system',
        text: `Error: ${message}`,
        timestamp: new Date(),
      });
      setState((prev) => ({ ...prev, isProcessing: false }));
    };

    const onDisconnected = () => {
      if (isMounted) {
        setState((prev) => ({ ...prev, isConnected: false }));
      }
    };

    const onConnected = () => {
      if (isMounted) {
        setState((prev) => ({ ...prev, isConnected: true }));
      }
    };

    const onResponseDone = () => {
      if (isMounted) {
        setState((prev) => ({ ...prev, isProcessing: false }));
      }
    };

    websocket.on('response', onResponse);
    websocket.on('task_update', onTaskUpdate);
    websocket.on('error', onError);
    websocket.on('connected', onConnected);
    websocket.on('disconnected', onDisconnected);
    websocket.on('response_done', onResponseDone);

    connectWs();

    return () => {
      isMounted = false;
      websocket.off('response', onResponse);
      websocket.off('task_update', onTaskUpdate);
      websocket.off('error', onError);
      websocket.off('connected', onConnected);
      websocket.off('disconnected', onDisconnected);
      websocket.off('response_done', onResponseDone);
      websocket.disconnect();
    };
  }, [state.sessionId, appendMessage, handleAssistantText]);

  const stopListening = useCallback(() => {
    if (Platform.OS === 'ios' && SpeechRecognition) {
      try {
        SpeechRecognition.stopRecognizing();
      } catch {
        // noop
      }
      eventEmitterRef.current?.removeAllListeners('onSpeechResults');
      eventEmitterRef.current?.removeAllListeners('onSpeechError');
    }
    setState((prev) => ({ ...prev, isListening: false }));
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      appendMessage({
        id: createMessageId(),
        type: 'user',
        text: trimmed,
        timestamp: new Date(),
      });

      setState((prev) => ({
        ...prev,
        isProcessing: true,
        transcript: '',
        isListening: false,
      }));

      try {
        if (websocket.isConnected()) {
          websocket.sendVoice(trimmed);
          return;
        }

        const response = await ApiService.processVoice(trimmed, state.sessionId);
        handleAssistantText(response.text || 'No response text returned.');

        if (response.requires_confirmation) {
          setState((prev) => ({
            ...prev,
            requiresConfirmation: true,
            confirmationPrompt: 'Do you want me to continue?',
          }));
        }
      } catch (error) {
        appendMessage({
          id: createMessageId(),
          type: 'system',
          text: 'Error: Could not connect to server. Please check your connection.',
          timestamp: new Date(),
        });
        setState((prev) => ({ ...prev, isProcessing: false }));
      }
    },
    [appendMessage, handleAssistantText, state.sessionId],
  );

  const startListening = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, isListening: true, transcript: '' }));

      if (Platform.OS === 'ios' && SpeechRecognition) {
        eventEmitterRef.current = new NativeEventEmitter(SpeechRecognition as any);

        eventEmitterRef.current.addListener('onSpeechResults', (event: any) => {
          const text = event?.value?.[0];
          if (typeof text === 'string' && text.trim()) {
            setState((prev) => ({ ...prev, transcript: text }));
            sendMessage(text).catch(() => undefined);
          }
        });

        eventEmitterRef.current.addListener('onSpeechError', () => {
          stopListening();
        });

        SpeechRecognition.startRecognizing('en-US');
        return;
      }

      setState((prev) => ({ ...prev, isListening: false }));
      Alert.alert('Voice Input Unavailable', 'Use the text input field to send messages in this build.');
    } catch {
      setState((prev) => ({ ...prev, isListening: false }));
    }
  }, [sendMessage, stopListening]);

  const confirmAction = useCallback(
    async (confirmed: boolean) => {
      setState((prev) => ({
        ...prev,
        requiresConfirmation: false,
        confirmationPrompt: null,
      }));
      await sendMessage(confirmed ? 'Yes, continue.' : 'No, cancel that.');
    },
    [sendMessage],
  );

  const clearHistory = useCallback(() => {
    websocket.disconnect();
    setState((prev) => ({
      ...prev,
      messages: [],
      transcript: '',
      requiresConfirmation: false,
      confirmationPrompt: null,
      sessionId: generateSessionId(),
    }));
  }, []);

  return (
    <VoiceContext.Provider
      value={{
        ...state,
        startListening,
        stopListening,
        speak,
        stopSpeaking,
        sendMessage,
        confirmAction,
        clearHistory,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
};
