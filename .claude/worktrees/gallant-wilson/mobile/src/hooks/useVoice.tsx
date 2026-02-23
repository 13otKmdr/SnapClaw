/**
 * useVoice — the core relay hook.
 *
 * VAD flow (no button pressing):
 *   1. startListening() → expo-av records with metering enabled
 *   2. Every 100 ms, check audio level (dBFS)
 *   3. Once speech is detected (level > SPEECH_THRESHOLD):
 *      - set speechDetected = true
 *      - stream each recorded segment as base64 to backend
 *   4. Once 1.5 s of silence after speech:
 *      - stopListening() → send audio_end → backend transcribes via Whisper
 *
 * Response flow:
 *   transcript   → show in transcript bar
 *   agent_update → append to streaming bubble
 *   agent_done   → finalize bubble
 *   audio_chunk  → decode MP3, queue for playback
 *   audio_end    → play queued audio via expo-av
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import ws from '../services/websocket';
import type { Chat, StoredMessage } from './useChats';

// ── VAD thresholds ────────────────────────────────────────────────────
const SPEECH_THRESHOLD_DB = -40;   // above this = speech
const SILENCE_DURATION_MS = 1500;  // silence after speech triggers send
const METERING_INTERVAL_MS = 100;

// ── Types ─────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  isStreaming?: boolean;
  timestamp: Date;
}

interface VoiceState {
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
  isConnected: boolean;
  transcript: string;
  messages: Message[];
  streamingText: string;   // live text as agent_update events arrive
}

interface VoiceContextType extends VoiceState {
  startListening: () => Promise<void>;
  stopListening: () => void;
  sendMessage: (text: string) => void;
  restoreMessages: (chat: Chat, stored: StoredMessage[]) => void;
  clearMessages: () => void;
}

const VoiceContext = createContext<VoiceContextType | null>(null);

export const useVoice = (): VoiceContextType => {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice must be used inside VoiceProvider');
  return ctx;
};

// ── Provider ──────────────────────────────────────────────────────────

export const VoiceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<VoiceState>({
    isListening: false,
    isProcessing: false,
    isSpeaking: false,
    isConnected: false,
    transcript: '',
    messages: [],
    streamingText: '',
  });

  // Recording refs
  const recordingRef = useRef<Audio.Recording | null>(null);
  const speechDetectedRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Audio playback queue
  const audioQueueRef = useRef<Uint8Array[]>([]);
  const soundRef = useRef<Audio.Sound | null>(null);
  const playingRef = useRef(false);

  // ── WebSocket setup ────────────────────────────────────────────────

  useEffect(() => {
    ws.connect();

    ws.on('auth_ok', () => setState(s => ({ ...s, isConnected: true })));
    ws.on('auth_error', () => setState(s => ({ ...s, isConnected: false })));
    ws.on('disconnected', () => setState(s => ({ ...s, isConnected: false })));

    ws.on('transcript', (data: unknown) => {
      const d = data as { text: string };
      setState(s => ({ ...s, transcript: d.text, isProcessing: true }));
    });

    ws.on('agent_update', (data: unknown) => {
      const d = data as { text: string };
      setState(s => ({ ...s, streamingText: s.streamingText + d.text + '\n' }));
    });

    ws.on('agent_done', (data: unknown) => {
      const d = data as { text: string };
      setState(s => ({
        ...s,
        isProcessing: false,
        streamingText: '',
        transcript: '',
        messages: [
          ...s.messages,
          { id: uid(), role: 'assistant', text: d.text, timestamp: new Date() },
        ],
      }));
    });

    ws.on('audio_chunk', (data: unknown) => {
      const d = data as { data: string };
      const bytes = base64ToUint8Array(d.data);
      audioQueueRef.current.push(bytes);
    });

    ws.on('audio_end', () => {
      _playQueuedAudio();
    });

    ws.on('error', (data: unknown) => {
      const d = data as { message: string };
      setState(s => ({
        ...s,
        isProcessing: false,
        streamingText: '',
        messages: [
          ...s.messages,
          { id: uid(), role: 'system', text: `Error: ${d.message}`, timestamp: new Date() },
        ],
      }));
    });

    // Audio permissions — default to speaker/playback mode
    Audio.requestPermissionsAsync();
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      playThroughEarpieceAndroid: false,
    });

    return () => {
      ws.disconnect();
    };
  }, []);

  // ── VAD recording ─────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    if (recordingRef.current) return;

    speechDetectedRef.current = false;

    try {
      // Switch to recording mode (iOS routes mic through earpiece during recording — unavoidable)
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      await rec.startAsync();
      recordingRef.current = rec;

      setState(s => ({ ...s, isListening: true, transcript: '' }));

      // Poll metering
      meteringIntervalRef.current = setInterval(async () => {
        if (!recordingRef.current) return;
        const status = await recordingRef.current.getStatusAsync();
        if (!status.isRecording) return;

        const db = status.metering ?? -160;

        if (db > SPEECH_THRESHOLD_DB) {
          // Speech detected
          if (!speechDetectedRef.current) {
            console.log('[VAD] Speech detected, dB:', db.toFixed(1));
            speechDetectedRef.current = true;
          }
          // Clear any pending silence timer
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        } else if (speechDetectedRef.current) {
          // Silence after speech — start countdown
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              stopListening();
            }, SILENCE_DURATION_MS);
          }
        }
      }, METERING_INTERVAL_MS);

    } catch (err) {
      console.error('[Voice] startListening error:', err);
      setState(s => ({ ...s, isListening: false }));
    }
  }, []);

  const stopListening = useCallback(async () => {
    if (!recordingRef.current) return;

    // Clear timers
    if (meteringIntervalRef.current) {
      clearInterval(meteringIntervalRef.current);
      meteringIntervalRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    setState(s => ({ ...s, isListening: false }));

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (!uri || !speechDetectedRef.current) {
        // No speech — discard
        return;
      }

      speechDetectedRef.current = false;
      setState(s => ({ ...s, isProcessing: true }));

      // Switch back to speaker mode for playback
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
      });

      // Read the audio file and send to backend as base64
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      ws.sendAudioChunk(base64);
      ws.sendAudioEnd();

      // Add placeholder user message — transcript will arrive shortly
      setState(s => ({
        ...s,
        transcript: '…',
        messages: [
          ...s.messages,
          { id: uid(), role: 'user', text: '🎙 …', timestamp: new Date() },
        ],
      }));

    } catch (err) {
      console.error('[Voice] stopListening error:', err);
      setState(s => ({ ...s, isProcessing: false, isListening: false }));
      recordingRef.current = null;
    }
  }, []);

  // When transcript arrives, update the placeholder message
  useEffect(() => {
    if (!state.transcript || state.transcript === '…') return;
    setState(s => {
      const msgs = [...s.messages];
      // Find the last user placeholder and replace it
      const idx = [...msgs].reverse().findIndex(
        m => m.role === 'user' && m.text === '🎙 …',
      );
      if (idx !== -1) {
        const realIdx = msgs.length - 1 - idx;
        msgs[realIdx] = { ...msgs[realIdx], text: s.transcript };
      }
      return { ...s, messages: msgs };
    });
  }, [state.transcript]);

  // ── Text message ──────────────────────────────────────────────────

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setState(s => ({
      ...s,
      isProcessing: true,
      messages: [
        ...s.messages,
        { id: uid(), role: 'user', text: trimmed, timestamp: new Date() },
      ],
    }));
    ws.sendText(trimmed);
  }, []);

  // ── Chat restore ──────────────────────────────────────────────────

  const restoreMessages = useCallback((_chat: Chat, stored: StoredMessage[]) => {
    const msgs: Message[] = stored.map(m => ({
      id: m.id,
      role: m.role as Message['role'],
      text: m.text,
      timestamp: new Date(m.created_at),
    }));
    setState(s => ({ ...s, messages: msgs, transcript: '', streamingText: '' }));
  }, []);

  const clearMessages = useCallback(() => {
    setState(s => ({ ...s, messages: [], transcript: '', streamingText: '' }));
  }, []);

  // ── Audio playback ────────────────────────────────────────────────

  const _playQueuedAudio = useCallback(async () => {
    if (playingRef.current || audioQueueRef.current.length === 0) return;
    playingRef.current = true;
    setState(s => ({ ...s, isSpeaking: true }));

    try {
      // Merge all queued chunks into one buffer
      const chunks = audioQueueRef.current.splice(0);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }

      // Write to a temp file and play
      const tmpUri = FileSystem.cacheDirectory + `tts_${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(tmpUri, uint8ArrayToBase64(merged), {
        encoding: FileSystem.EncodingType.Base64,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri: tmpUri },
        { shouldPlay: true },
      );
      soundRef.current = sound;

      await new Promise<void>((resolve) => {
        sound.setOnPlaybackStatusUpdate(status => {
          if (status.isLoaded && status.didJustFinish) resolve();
        });
      });

      await sound.unloadAsync();
      await FileSystem.deleteAsync(tmpUri, { idempotent: true });
    } catch (err) {
      console.error('[Voice] Audio playback error:', err);
    } finally {
      playingRef.current = false;
      setState(s => ({ ...s, isSpeaking: false }));
    }
  }, []);

  // ── Context value ─────────────────────────────────────────────────

  return (
    <VoiceContext.Provider
      value={{
        ...state,
        startListening,
        stopListening,
        sendMessage,
        restoreMessages,
        clearMessages,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
};

// ── Utilities ─────────────────────────────────────────────────────────

let _uidCounter = 0;
const uid = () => `${Date.now()}-${++_uidCounter}`;

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}
