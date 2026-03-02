import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
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
  connectionError: string | null;
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
const TTS_RATE = 0.92;
const TTS_PITCH = 1.0;
const PREFERRED_VOICE_HINTS = ['enhanced', 'premium', 'neural', 'natural', 'samantha', 'ava', 'victoria'];

// OpenAI Realtime expects PCM16 at 24kHz. Record at 24kHz on iOS for a clean match.
const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  ios: {
    extension: '.wav',
    audioQuality: Audio.IOSAudioQuality.MAX,
    sampleRate: 24000,
    numberOfChannels: 1,
    bitRate: 384000,
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

/**
 * Strip the 44-byte WAV header from a base64-encoded WAV file
 * to get raw PCM16 data for OpenAI Realtime API.
 */
function stripWavHeader(wavBase64: string): string {
  const binary = atob(wavBase64);
  const pcmBinary = binary.substring(44);
  return btoa(pcmBinary);
}

/**
 * Build a WAV file from raw PCM16 base64 data.
 * Returns the base64-encoded complete WAV file.
 */
function buildWavFromPcm16(pcm16Base64: string, sampleRate: number = 24000): string {
  const pcmBinary = atob(pcm16Base64);
  const dataLength = pcmBinary.length;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const fileSize = 36 + dataLength;

  // Build 44-byte WAV header
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  // RIFF chunk descriptor
  header[0] = 0x52; header[1] = 0x49; header[2] = 0x46; header[3] = 0x46; // "RIFF"
  view.setUint32(4, fileSize, true);
  header[8] = 0x57; header[9] = 0x41; header[10] = 0x56; header[11] = 0x45; // "WAVE"

  // fmt sub-chunk
  header[12] = 0x66; header[13] = 0x6d; header[14] = 0x74; header[15] = 0x20; // "fmt "
  view.setUint32(16, 16, true); // subchunk1 size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  header[36] = 0x64; header[37] = 0x61; header[38] = 0x74; header[39] = 0x61; // "data"
  view.setUint32(40, dataLength, true);

  let headerBinary = '';
  for (let i = 0; i < header.length; i++) {
    headerBinary += String.fromCharCode(header[i]);
  }

  return btoa(headerBinary + pcmBinary);
}

export const VoiceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const canUseMicrophone = true;

  const [state, setState] = useState<VoiceState>({
    isListening: false,
    isProcessing: false,
    isSpeaking: false,
    liveSessionActive: false,
    isConnected: false,
    connectionError: null,
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
  const preferredVoiceIdRef = useRef<string | undefined>(undefined);
  const voiceResolutionAttemptedRef = useRef(false);
  const audioPlaybackRef = useRef<Audio.Sound | null>(null);
  const wsReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsReconnectAttemptsRef = useRef(0);

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

  const resolvePreferredVoice = useCallback(async (): Promise<string | undefined> => {
    if (voiceResolutionAttemptedRef.current) {
      return preferredVoiceIdRef.current;
    }

    voiceResolutionAttemptedRef.current = true;

    try {
      const voices = await Speech.getAvailableVoicesAsync?.();
      if (!Array.isArray(voices) || voices.length === 0) {
        return undefined;
      }

      const englishVoices = voices.filter((voice: any) => {
        const language = String(voice?.language || '').toLowerCase();
        return language.startsWith('en');
      });

      const candidates = englishVoices.length ? englishVoices : voices;
      const scoreVoice = (voice: any) => {
        const descriptor = `${voice?.name || ''} ${voice?.identifier || ''} ${voice?.quality || ''}`.toLowerCase();
        let score = 0;
        if (descriptor.includes('en-us')) score += 2;
        for (const hint of PREFERRED_VOICE_HINTS) {
          if (descriptor.includes(hint)) score += 3;
        }
        return score;
      };

      const sorted = [...candidates].sort((a: any, b: any) => scoreVoice(b) - scoreVoice(a));
      const selected = sorted[0];
      preferredVoiceIdRef.current = (selected?.identifier || selected?.id || undefined) as string | undefined;
      return preferredVoiceIdRef.current;
    } catch {
      return undefined;
    }
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

  /** Fallback TTS using device speech (expo-speech). Used only when no audio comes from Realtime. */
  const speak = useCallback(async (text: string) => {
    if (!text.trim()) {
      return;
    }

    setState((prev) => ({ ...prev, isSpeaking: true }));
    const preferredVoice = await resolvePreferredVoice();

    Speech.speak(text, {
      language: 'en-US',
      voice: preferredVoice,
      rate: TTS_RATE,
      pitch: TTS_PITCH,
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
  }, [maybeRestartListeningAfterSpeech, resolvePreferredVoice]);

  const stopSpeaking = useCallback(() => {
    suppressAutoRestartRef.current = true;
    Speech.stop();
    // Also stop any audio playback
    if (audioPlaybackRef.current) {
      audioPlaybackRef.current.stopAsync().catch(() => undefined);
      audioPlaybackRef.current.unloadAsync().catch(() => undefined);
      audioPlaybackRef.current = null;
    }
    setState((prev) => ({ ...prev, isSpeaking: false }));
  }, []);

  /** Play base64 PCM16 audio response from OpenAI Realtime via expo-av. */
  const playAudioResponse = useCallback(async (pcm16Base64: string) => {
    try {
      // Build a WAV file from raw PCM16 data
      const wavBase64 = buildWavFromPcm16(pcm16Base64, 24000);
      const tempUri = (FileSystem.cacheDirectory || '') + `response_${Date.now()}.wav`;

      await FileSystem.writeAsStringAsync(tempUri, wavBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Configure audio for playback
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri: tempUri },
        { shouldPlay: true },
      );

      audioPlaybackRef.current = sound;
      setState((prev) => ({ ...prev, isSpeaking: true, isProcessing: false }));

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync().catch(() => undefined);
          FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => undefined);
          audioPlaybackRef.current = null;
          setState((prev) => ({ ...prev, isSpeaking: false }));
          maybeRestartListeningAfterSpeech();
        }
      });
    } catch (err) {
      console.warn('Audio playback failed:', err);
      setState((prev) => ({ ...prev, isSpeaking: false, isProcessing: false }));
      maybeRestartListeningAfterSpeech();
    }
  }, [maybeRestartListeningAfterSpeech]);

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
    const MAX_WS_RETRIES = 2;
    const WS_RETRY_DELAY_MS = 4000;

    const startHealthPolling = () => {
      if (healthPollTimer) return;
      healthPollTimer = setInterval(() => {
        ApiService.healthCheck()
          .then((healthy) => {
            if (isMounted) {
              setState((prev) => ({
                ...prev,
                isConnected: healthy,
                connectionError: healthy ? null : prev.connectionError,
              }));
            }
          })
          .catch(() => {
            if (isMounted) setState((prev) => ({ ...prev, isConnected: false }));
          });
      }, 10000);
    };

    const connectWs = async () => {
      if (!realtimeEnabled) {
        const healthy = await ApiService.healthCheck();
        if (isMounted) {
          setState((prev) => ({
            ...prev,
            isConnected: healthy,
            connectionError: healthy ? null : 'Server unreachable — check Settings',
          }));
          if (!healthy) startHealthPolling();
        }
        return;
      }

      try {
        await websocket.connect(state.sessionId);
        if (isMounted) {
          wsReconnectAttemptsRef.current = 0;
          setState((prev) => ({ ...prev, isConnected: true, connectionError: null }));
        }
      } catch {
        if (!isMounted) return;
        wsReconnectAttemptsRef.current += 1;
        const attempt = wsReconnectAttemptsRef.current;
        if (attempt <= MAX_WS_RETRIES) {
          setState((prev) => ({
            ...prev,
            isConnected: false,
            connectionError: `Reconnecting… (${attempt}/${MAX_WS_RETRIES})`,
          }));
          wsReconnectTimerRef.current = setTimeout(() => {
            wsReconnectTimerRef.current = null;
            if (isMounted && !websocket.isConnected()) void connectWs();
          }, WS_RETRY_DELAY_MS * attempt);
        } else {
          setState((prev) => ({
            ...prev,
            isConnected: false,
            connectionError: 'Voice server offline — using text mode',
          }));
          startHealthPolling();
        }
      }
    };

    const onResponse = (data: { text?: string; hasAudio?: boolean }) => {
      if (data?.text) {
        if (data.hasAudio) {
          // Audio will play separately via onAudioResponse. Just add text to chat.
          appendMessage({
            id: createMessageId(),
            type: 'assistant',
            text: data.text,
            timestamp: new Date(),
          });
          setState((prev) => ({
            ...prev,
            isProcessing: false,
            streamingText: '',
          }));
        } else {
          // Text-only response — use device TTS as fallback
          handleAssistantText(data.text);
        }
      }
    };

    /** Play audio response from OpenAI Realtime. */
    const onAudioResponse = (data: { audio: string }) => {
      if (data?.audio) {
        playAudioResponse(data.audio).catch(() => undefined);
      }
    };

    /** Show the assistant's response text in chat (from audio transcript). */
    const onAudioTranscript = (data: { text: string }) => {
      if (data?.text && isMounted) {
        appendMessage({
          id: createMessageId(),
          type: 'assistant',
          text: data.text,
          timestamp: new Date(),
        });
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          streamingText: '',
        }));
      }
    };

    /** Update user's placeholder message with actual transcript from OpenAI. */
    const onInputTranscript = (data: { text: string }) => {
      if (data?.text && isMounted) {
        setState((prev) => {
          const msgs = [...prev.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].type === 'user' && msgs[i].text === '[Voice message]') {
              msgs[i] = { ...msgs[i], text: data.text };
              break;
            }
          }
          return { ...prev, messages: msgs, transcript: '' };
        });
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
      const message =
        typeof event?.message === 'string' ? event.message
        : typeof event?.error === 'string' ? event.error
        : 'Connection error';
      appendMessage({
        id: createMessageId(),
        type: 'system',
        text: `Connection error: ${message}`,
        timestamp: new Date(),
      });
      setState((prev) => ({ ...prev, isProcessing: false }));
    };

    const onDisconnected = () => {
      if (!isMounted) return;
      setState((prev) => ({ ...prev, isConnected: false }));
      // Attempt one silent reconnect after unexpected disconnect
      if (realtimeEnabled && wsReconnectAttemptsRef.current < MAX_WS_RETRIES) {
        wsReconnectTimerRef.current = setTimeout(() => {
          wsReconnectTimerRef.current = null;
          if (isMounted && !websocket.isConnected()) void connectWs();
        }, WS_RETRY_DELAY_MS);
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
      websocket.on('audio_response', onAudioResponse);
      websocket.on('audio_transcript', onAudioTranscript);
      websocket.on('input_transcript', onInputTranscript);
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
      if (healthPollTimer) clearInterval(healthPollTimer);
      if (wsReconnectTimerRef.current) {
        clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
      if (realtimeEnabled) {
        websocket.off('response', onResponse);
        websocket.off('audio_response', onAudioResponse);
        websocket.off('audio_transcript', onAudioTranscript);
        websocket.off('input_transcript', onInputTranscript);
        websocket.off('task_update', onTaskUpdate);
        websocket.off('error', onError);
        websocket.off('connected', onConnected);
        websocket.off('disconnected', onDisconnected);
        websocket.off('response_done', onResponseDone);
        websocket.disconnect();
      }
    };
  }, [state.sessionId, appendMessage, clearTurnTimers, handleAssistantText, playAudioResponse]);

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

          // --- REALTIME PATH: send audio through WebSocket ---
          if (Platform.OS === 'ios' && websocket.isConnected()) {
            const base64Audio = await FileSystem.readAsStringAsync(uri, {
              encoding: FileSystem.EncodingType.Base64,
            });

            // Strip 44-byte WAV header to get raw PCM16
            const pcm16Base64 = stripWavHeader(base64Audio);

            // Add a placeholder user message (will be updated by input_transcript)
            appendMessage({
              id: createMessageId(),
              type: 'user',
              text: '[Voice message]',
              timestamp: new Date(),
            });
            setState((prev) => ({ ...prev, transcript: '' }));

            // Send audio to OpenAI Realtime via WebSocket
            websocket.sendAudioBuffer(pcm16Base64);
            return;
          }

          // --- FALLBACK PATH: REST API for Android or when WS disconnected ---
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
    wsReconnectAttemptsRef.current = 0;
    if (wsReconnectTimerRef.current) {
      clearTimeout(wsReconnectTimerRef.current);
      wsReconnectTimerRef.current = null;
    }
    setState((prev) => ({
      ...prev,
      messages: [],
      transcript: '',
      streamingText: '',
      liveSessionActive: false,
      requiresConfirmation: false,
      confirmationPrompt: null,
      connectionError: null,
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
