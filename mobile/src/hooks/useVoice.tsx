import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, NativeEventEmitter, NativeModules } from 'react-native';
import { Audio } from 'expo-av';
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
  liveSessionActive: boolean;
  isConnected: boolean;
  transcript: string;
  streamingText: string;
  messages: Message[];
  sessionId: string;
  requiresConfirmation: boolean;
  confirmationPrompt: string | null;
}

interface RestoredChat {
  id: string;
  name: string;
}

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  created_at: string;
}

interface VoiceContextType extends VoiceState {
  canUseMicrophone: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  toggleLiveSession: () => Promise<void>;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  sendMessage: (text: string) => Promise<void>;
  confirmAction: (confirmed: boolean) => Promise<void>;
  restoreMessages: (chat: RestoredChat, messages: StoredMessage[]) => void;
  clearMessages: () => void;
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
const EXPO_FALLBACK_MAX_TURN_MS = 6500;
const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  ios: {
    extension: '.wav',
    audioQuality: Audio.IOSAudioQuality.MAX,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
  },
  android: {
    extension: '.mp3',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 128000,
  },
};

export const VoiceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const canUseMicrophone = true;

  const [state, setState] = useState<VoiceState>({
    isListening: false,
    isProcessing: false,
    isSpeaking: false,
    liveSessionActive: false,
    isConnected: false,
    transcript: '',
    streamingText: '',
    messages: [],
    sessionId: generateSessionId(),
    requiresConfirmation: false,
    confirmationPrompt: null,
  });

  const eventEmitterRef = useRef<NativeEventEmitter | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const stateRef = useRef(state);
  const startListeningRef = useRef<(() => Promise<void>) | null>(null);
  const voiceTurnInFlightRef = useRef(false);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressAutoRestartRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const clearTurnTimers = useCallback(() => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    if (autoRestartTimerRef.current) {
      clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
    }
  }, []);

  const appendMessage = useCallback((message: Message) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, message],
    }));
  }, []);

  const maybeRestartListeningAfterSpeech = useCallback(() => {
    if (suppressAutoRestartRef.current) {
      suppressAutoRestartRef.current = false;
      return;
    }
    if (!stateRef.current.liveSessionActive || stateRef.current.isListening || stateRef.current.isProcessing) {
      return;
    }
    if (autoRestartTimerRef.current) {
      clearTimeout(autoRestartTimerRef.current);
    }
    autoRestartTimerRef.current = setTimeout(() => {
      autoRestartTimerRef.current = null;
      if (!stateRef.current.liveSessionActive || stateRef.current.isListening || stateRef.current.isProcessing) {
        return;
      }
      void startListeningRef.current?.();
    }, 150);
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
      onDone: () => {
        setState((prev) => ({ ...prev, isSpeaking: false }));
        maybeRestartListeningAfterSpeech();
      },
      onError: () => {
        setState((prev) => ({ ...prev, isSpeaking: false }));
        maybeRestartListeningAfterSpeech();
      },
      onStop: () => {
        setState((prev) => ({ ...prev, isSpeaking: false }));
        maybeRestartListeningAfterSpeech();
      },
    });
  }, [maybeRestartListeningAfterSpeech]);

  const stopSpeaking = useCallback(() => {
    suppressAutoRestartRef.current = true;
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
        streamingText: '',
        requiresConfirmation: false,
        confirmationPrompt: null,
      }));

      speak(text).catch(() => undefined);
    },
    [appendMessage, speak],
  );

  useEffect(() => {
    let isMounted = true;
    const realtimeEnabled = websocket.isRealtimeEnabled();
    let healthPollTimer: ReturnType<typeof setInterval> | null = null;

    const connectWs = async () => {
      if (!realtimeEnabled) {
        const healthy = await ApiService.healthCheck();
        if (isMounted) {
          setState((prev) => ({ ...prev, isConnected: healthy }));
        }
        return;
      }

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
      const message = typeof event?.error === 'string' ? event.error : 'Connection error';
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

    connectWs();
    if (realtimeEnabled) {
      websocket.on('response', onResponse);
      websocket.on('task_update', onTaskUpdate);
      websocket.on('error', onError);
      websocket.on('connected', onConnected);
      websocket.on('disconnected', onDisconnected);
      websocket.on('response_done', onResponseDone);
    } else {
      healthPollTimer = setInterval(() => {
        ApiService.healthCheck()
          .then((healthy) => {
            if (isMounted) {
              setState((prev) => ({ ...prev, isConnected: healthy }));
            }
          })
          .catch(() => {
            if (isMounted) {
              setState((prev) => ({ ...prev, isConnected: false }));
            }
          });
      }, 10000);
    }

    return () => {
      isMounted = false;
      clearTurnTimers();
      if (healthPollTimer) {
        clearInterval(healthPollTimer);
      }
      if (realtimeEnabled) {
        websocket.off('response', onResponse);
        websocket.off('task_update', onTaskUpdate);
        websocket.off('error', onError);
        websocket.off('connected', onConnected);
        websocket.off('disconnected', onDisconnected);
        websocket.off('response_done', onResponseDone);
        websocket.disconnect();
      }
    };
  }, [state.sessionId, appendMessage, clearTurnTimers, handleAssistantText]);

  // sendMessage is defined before stopListening so stopListening can call it
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

      clearTurnTimers();
      setState((prev) => ({
        ...prev,
        isProcessing: true,
        transcript: '',
        streamingText: '',
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
    [appendMessage, clearTurnTimers, handleAssistantText, state.sessionId],
  );

  const stopListening = useCallback((processTurn = true) => {
    clearTurnTimers();

    if (SpeechRecognition) {
      try {
        SpeechRecognition.stopRecognizing();
      } catch {
        // noop
      }
      eventEmitterRef.current?.removeAllListeners('onSpeechResults');
      eventEmitterRef.current?.removeAllListeners('onSpeechError');
    }

    const recording = recordingRef.current;
    recordingRef.current = null;

    if (recording) {
      void (async () => {
        try {
          await recording.stopAndUnloadAsync();
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: false,
            playsInSilentModeIOS: true,
          });

          const uri = recording.getURI();
          if (!processTurn) {
            setState((prev) => ({ ...prev, isListening: false, transcript: '' }));
            return;
          }

          setState((prev) => ({
            ...prev,
            isListening: false,
            isProcessing: true,
            transcript: 'Processing voice...',
          }));

          if (!uri) {
            appendMessage({
              id: createMessageId(),
              type: 'system',
              text: 'Error: Recording failed. Try again.',
              timestamp: new Date(),
            });
            setState((prev) => ({ ...prev, isProcessing: false, transcript: '' }));
            return;
          }

          const response = await ApiService.processVoiceAudio(uri, state.sessionId);
          const transcript = typeof response.entities?.transcript === 'string'
            ? response.entities.transcript.trim()
            : '';
          const userText = transcript || '[Voice message]';
          appendMessage({
            id: createMessageId(),
            type: 'user',
            text: userText,
            timestamp: new Date(),
          });
          setState((prev) => ({ ...prev, transcript: '' }));

          handleAssistantText(response.text || 'No response text returned.');

          if (response.requires_confirmation) {
            setState((prev) => ({
              ...prev,
              requiresConfirmation: true,
              confirmationPrompt: 'Do you want me to continue?',
            }));
          }
        } catch {
          appendMessage({
            id: createMessageId(),
            type: 'system',
            text: 'Error: Voice capture failed. Please try again.',
            timestamp: new Date(),
          });
          setState((prev) => ({ ...prev, isProcessing: false, transcript: '' }));
        } finally {
          voiceTurnInFlightRef.current = false;
        }
      })();
      return;
    }

    voiceTurnInFlightRef.current = false;
    setState((prev) => ({ ...prev, isListening: false }));
  }, [appendMessage, clearTurnTimers, handleAssistantText, state.sessionId]);

  const startListening = useCallback(async () => {
    if (
      stateRef.current.isListening ||
      stateRef.current.isProcessing ||
      stateRef.current.isSpeaking ||
      voiceTurnInFlightRef.current
    ) {
      return;
    }

    try {
      setState((prev) => ({ ...prev, isListening: true, transcript: '' }));

      if (canUseMicrophone && SpeechRecognition) {
        voiceTurnInFlightRef.current = false;
        eventEmitterRef.current = new NativeEventEmitter(SpeechRecognition as any);

        eventEmitterRef.current.addListener('onSpeechResults', (event: any) => {
          const text = event?.value?.[0];
          if (voiceTurnInFlightRef.current) {
            return;
          }
          if (typeof text === 'string' && text.trim()) {
            voiceTurnInFlightRef.current = true;
            stopListening(false);
            setState((prev) => ({ ...prev, transcript: text }));
            sendMessage(text).catch(() => undefined);
          }
        });

        eventEmitterRef.current.addListener('onSpeechError', () => {
          voiceTurnInFlightRef.current = false;
          stopListening(false);
          if (stateRef.current.liveSessionActive && !autoRestartTimerRef.current) {
            autoRestartTimerRef.current = setTimeout(() => {
              autoRestartTimerRef.current = null;
              if (stateRef.current.liveSessionActive) {
                void startListeningRef.current?.();
              }
            }, 250);
          }
        });

        SpeechRecognition.startRecognizing('en-US');
        return;
      }

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setState((prev) => ({ ...prev, isListening: false, liveSessionActive: false }));
        Alert.alert('Microphone Permission Needed', 'Please allow microphone access to record voice input.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(RECORDING_OPTIONS);
      await recording.startAsync();
      recordingRef.current = recording;
      voiceTurnInFlightRef.current = true;
      autoStopTimerRef.current = setTimeout(() => {
        autoStopTimerRef.current = null;
        if (recordingRef.current) {
          stopListening(true);
        }
      }, EXPO_FALLBACK_MAX_TURN_MS);
      setState((prev) => ({ ...prev, transcript: 'Listening...' }));
    } catch {
      voiceTurnInFlightRef.current = false;
      setState((prev) => ({ ...prev, isListening: false, liveSessionActive: false }));
    }
  }, [canUseMicrophone, sendMessage, stopListening]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const toggleLiveSession = useCallback(async () => {
    if (stateRef.current.liveSessionActive) {
      clearTurnTimers();
      setState((prev) => ({ ...prev, liveSessionActive: false, transcript: '' }));
      stopSpeaking();
      stopListening(false);
      return;
    }

    if (stateRef.current.isProcessing) {
      return;
    }

    setState((prev) => ({ ...prev, liveSessionActive: true }));
    await startListening();
  }, [clearTurnTimers, startListening, stopListening, stopSpeaking]);

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
    clearTurnTimers();
    stopSpeaking();
    stopListening(false);
    websocket.disconnect();
    setState((prev) => ({
      ...prev,
      messages: [],
      transcript: '',
      streamingText: '',
      liveSessionActive: false,
      requiresConfirmation: false,
      confirmationPrompt: null,
      sessionId: generateSessionId(),
    }));
  }, [clearTurnTimers, stopListening, stopSpeaking]);

  const restoreMessages = useCallback((_: RestoredChat, storedMessages: StoredMessage[]) => {
    const mapped: Message[] = storedMessages.map((message) => ({
      id: message.id || createMessageId(),
      type: message.role,
      text: message.text,
      timestamp: new Date(message.created_at || Date.now()),
    }));

    setState((prev) => ({
      ...prev,
      messages: mapped,
      streamingText: '',
      transcript: '',
      requiresConfirmation: false,
      confirmationPrompt: null,
    }));
  }, []);

  const clearMessages = useCallback(() => {
    setState((prev) => ({
      ...prev,
      messages: [],
      transcript: '',
      streamingText: '',
      requiresConfirmation: false,
      confirmationPrompt: null,
    }));
  }, []);

  return (
    <VoiceContext.Provider
      value={{
        ...state,
        canUseMicrophone,
        startListening,
        stopListening,
        toggleLiveSession,
        speak,
        stopSpeaking,
        sendMessage,
        confirmAction,
        restoreMessages,
        clearMessages,
        clearHistory,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
};
