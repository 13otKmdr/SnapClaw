import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Speech from 'expo-speech';

import { ApiService } from '../services/api';
import websocket from '../services/websocket';
import { applyInputTranscriptToMessages, VOICE_MESSAGE_PLACEHOLDER } from './voiceTranscriptUtils';

type SpeechRecognitionModule = {
  startRecognizing: (locale: string) => void;
  stopRecognizing: () => void;
};

const SpeechRecognition = NativeModules.SpeechRecognition as SpeechRecognitionModule | undefined;

type WebSpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: any) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: ((event: Event) => void) | null;
};

type WebSpeechRecognitionCtor = new () => WebSpeechRecognitionInstance;
type WebMediaStreamTrack = { stop: () => void };
type WebMediaStream = { getTracks: () => WebMediaStreamTrack[] };
type WebMediaDevices = {
  getUserMedia?: (constraints: { audio: boolean | Record<string, unknown> }) => Promise<WebMediaStream>;
};
type WebNavigator = {
  mediaDevices?: WebMediaDevices;
  onLine?: boolean;
  brave?: {
    isBrave?: () => Promise<boolean>;
  };
};

type WebWindow = {
  addEventListener?: (event: string, handler: () => void) => void;
  removeEventListener?: (event: string, handler: () => void) => void;
  isSecureContext?: boolean;
  location?: {
    hostname?: string;
  };
  navigator?: WebNavigator;
  speechSynthesis?: {
    cancel: () => void;
    speak: (utterance: unknown) => void;
  };
  AudioContext?: new () => any;
  webkitAudioContext?: new () => any;
  webkitSpeechRecognition?: WebSpeechRecognitionCtor;
  SpeechRecognition?: WebSpeechRecognitionCtor;
};

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

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
  connectionStatus: ConnectionStatus;
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
  retryConnection: () => void;
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
const WEB_SPEECH_FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed']);
const WEB_SPEECH_RESTARTABLE_ERRORS = new Set(['no-speech', 'audio-capture', 'network', 'speech_error']);
const WS_BACKOFF_BASE_MS = 900;
const WS_BACKOFF_MAX_MS = 20000;
const WS_MAX_RECONNECT_ATTEMPTS = 8;

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

function pcm16Base64FromFloat32(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  let offset = 0;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    const int16 = Math.round(value);
    bytes[offset++] = int16 & 0xff;
    bytes[offset++] = (int16 >> 8) & 0xff;
  }

  let binary = '';
  const chunkSize = 0x4000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    let chunk = '';
    for (let j = i; j < end; j++) {
      chunk += String.fromCharCode(bytes[j]);
    }
    binary += chunk;
  }
  return btoa(binary);
}

async function convertWebRecordingToPcm16Base64(uri: string, targetSampleRate: number = 24000): Promise<string> {
  const runtimeWindow = (typeof globalThis !== 'undefined'
    ? (globalThis as any).window
    : undefined) as WebWindow | undefined;
  const AudioContextCtor = runtimeWindow?.AudioContext || runtimeWindow?.webkitAudioContext;
  const OfflineAudioContextCtor = (typeof globalThis !== 'undefined'
    ? (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext
    : undefined) as (new (channels: number, length: number, sampleRate: number) => any) | undefined;

  if (!AudioContextCtor || typeof fetch !== 'function') {
    throw new Error('Web Audio API unavailable');
  }

  const sourceResponse = await fetch(uri);
  if (!sourceResponse.ok) {
    throw new Error(`Failed to read recording (${sourceResponse.status})`);
  }
  const sourceBytes = await sourceResponse.arrayBuffer();

  const decodeCtx = new AudioContextCtor();
  let decoded: any;
  try {
    // Some engines detach the buffer during decode, so pass a copy.
    decoded = await decodeCtx.decodeAudioData(sourceBytes.slice(0));
  } finally {
    try {
      await decodeCtx.close();
    } catch {
      // noop
    }
  }

  const channels = Math.max(1, decoded.numberOfChannels || 1);
  const mono = new Float32Array(decoded.length);
  for (let ch = 0; ch < channels; ch++) {
    const channelData = decoded.getChannelData(ch);
    for (let i = 0; i < decoded.length; i++) {
      mono[i] += channelData[i] / channels;
    }
  }

  let renderedMono: Float32Array = mono;
  if (decoded.sampleRate !== targetSampleRate) {
    if (!OfflineAudioContextCtor) {
      throw new Error('OfflineAudioContext unavailable for resampling');
    }

    const renderedLength = Math.max(
      1,
      Math.ceil((decoded.length / decoded.sampleRate) * targetSampleRate),
    );
    const offline = new OfflineAudioContextCtor(1, renderedLength, targetSampleRate);
    const monoBuffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
    if (typeof monoBuffer.copyToChannel === 'function') {
      monoBuffer.copyToChannel(mono, 0);
    } else {
      monoBuffer.getChannelData(0).set(mono);
    }
    const source = offline.createBufferSource();
    source.buffer = monoBuffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    renderedMono = rendered.getChannelData(0);
  }

  return pcm16Base64FromFloat32(renderedMono);
}

export const VoiceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [retryToken, setRetryToken] = useState(0);
  const webWindow = (typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined) as WebWindow | undefined;
  const canUseMicrophone = Platform.OS !== 'web'
    || !webWindow
    || !!webWindow.navigator?.mediaDevices?.getUserMedia
    || !!(webWindow.webkitSpeechRecognition || webWindow.SpeechRecognition);

  const [state, setState] = useState<VoiceState>({
    isListening: false,
    isProcessing: false,
    isSpeaking: false,
    liveSessionActive: false,
    isConnected: false,
    connectionStatus: 'connecting',
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
  const webRecognitionRef = useRef<WebSpeechRecognitionInstance | null>(null);
  const webSpeechHadResultRef = useRef(false);
  const webSpeechLastErrorRef = useRef<string | null>(null);
  const webSpeechLatestTranscriptRef = useRef('');
  const webSpeechFallbackToRecorderRef = useRef(false);
  const webAudioContextRef = useRef<any>(null);
  const webAudioSourceRef = useRef<any>(null);
  const webAudioUnlockHandlerRef = useRef<(() => void) | null>(null);
  const pendingVoiceMessageIdRef = useRef<string | null>(null);

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

  const clearWsReconnectTimer = useCallback(() => {
    if (wsReconnectTimerRef.current) {
      clearTimeout(wsReconnectTimerRef.current);
      wsReconnectTimerRef.current = null;
    }
  }, []);

  const stopWebAudioSource = useCallback(() => {
    if (!webAudioSourceRef.current) {
      return;
    }
    try {
      webAudioSourceRef.current.stop?.(0);
    } catch {
      // noop
    }
    try {
      webAudioSourceRef.current.disconnect?.();
    } catch {
      // noop
    }
    webAudioSourceRef.current = null;
  }, []);

  const clearWebAudioUnlockHandler = useCallback(() => {
    if (Platform.OS !== 'web' || !webAudioUnlockHandlerRef.current) {
      return;
    }
    const runtimeWindow = (typeof globalThis !== 'undefined'
      ? (globalThis as any).window
      : undefined) as WebWindow | undefined;
    if (!runtimeWindow?.removeEventListener) {
      webAudioUnlockHandlerRef.current = null;
      return;
    }
    const handler = webAudioUnlockHandlerRef.current;
    runtimeWindow.removeEventListener('touchstart', handler);
    runtimeWindow.removeEventListener('touchend', handler);
    runtimeWindow.removeEventListener('click', handler);
    runtimeWindow.removeEventListener('keydown', handler);
    webAudioUnlockHandlerRef.current = null;
  }, []);

  const ensureWebAudioContextActive = useCallback(async (): Promise<any | null> => {
    if (Platform.OS !== 'web') {
      return null;
    }

    const runtimeWindow = (typeof globalThis !== 'undefined'
      ? (globalThis as any).window
      : undefined) as WebWindow | undefined;
    const AudioContextCtor = runtimeWindow?.AudioContext || runtimeWindow?.webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }

    if (!webAudioContextRef.current) {
      webAudioContextRef.current = new AudioContextCtor();
    }

    const audioCtx = webAudioContextRef.current;
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      try {
        await audioCtx.resume();
      } catch {
        // noop
      }
    }

    if (
      audioCtx.state !== 'running'
      && !webAudioUnlockHandlerRef.current
      && runtimeWindow?.addEventListener
    ) {
      const unlock = () => {
        void ensureWebAudioContextActive();
      };
      webAudioUnlockHandlerRef.current = unlock;
      runtimeWindow.addEventListener('touchstart', unlock);
      runtimeWindow.addEventListener('touchend', unlock);
      runtimeWindow.addEventListener('click', unlock);
      runtimeWindow.addEventListener('keydown', unlock);
    }

    if (audioCtx.state === 'running') {
      clearWebAudioUnlockHandler();
    }

    return audioCtx;
  }, [clearWebAudioUnlockHandler]);

  const scheduleLiveSessionRestart = useCallback((delayMs: number = 400) => {
    if (autoRestartTimerRef.current) {
      return;
    }
    autoRestartTimerRef.current = setTimeout(() => {
      autoRestartTimerRef.current = null;
      if (
        !stateRef.current.liveSessionActive ||
        stateRef.current.isListening ||
        stateRef.current.isProcessing ||
        stateRef.current.isSpeaking ||
        voiceTurnInFlightRef.current
      ) {
        return;
      }
      void startListeningRef.current?.();
    }, delayMs);
  }, []);

  const ensureWebMicrophonePermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'web') {
      return true;
    }

    const runtimeWindow = (typeof globalThis !== 'undefined'
      ? (globalThis as any).window
      : undefined) as WebWindow | undefined;
    const secureContextFlag = (typeof globalThis !== 'undefined'
      ? (globalThis as any).isSecureContext
      : undefined) as boolean | undefined;
    const isSecureContext = typeof secureContextFlag === 'boolean'
      ? secureContextFlag
      : !!runtimeWindow?.isSecureContext;
    const host = runtimeWindow?.location?.hostname?.toLowerCase() || '';
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!isSecureContext && !isLocalhost) {
      setState((prev) => ({
        ...prev,
        isListening: false,
        liveSessionActive: false,
        transcript: '',
        connectionError: 'Microphone capture requires HTTPS (or localhost).',
      }));
      return false;
    }

    const mediaDevices = runtimeWindow?.navigator?.mediaDevices;
    const getUserMedia = mediaDevices?.getUserMedia;
    if (typeof getUserMedia !== 'function') {
      return true;
    }

    try {
      // Keep the original mediaDevices receiver to avoid "Illegal invocation"
      // in browsers that require getUserMedia to be called as a bound method.
      const stream = await getUserMedia.call(mediaDevices, { audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return true;
    } catch (error: any) {
      const name = typeof error?.name === 'string' ? error.name : '';
      const details = typeof error?.message === 'string' ? error.message : '';
      const message =
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Microphone permission denied in browser settings.'
        : name === 'NotFoundError'
            ? 'No microphone detected on this device.'
        : name === 'NotReadableError'
              ? 'Microphone is busy in another app.'
        : name === 'TypeError'
                ? 'Browser could not start microphone capture. Check Brave Shields and mic permissions for this site.'
              : name === 'SecurityError'
                ? 'Microphone capture requires HTTPS (or localhost).'
                : 'Unable to access microphone from the browser.';
      setState((prev) => ({
        ...prev,
        isListening: false,
        liveSessionActive: false,
        transcript: '',
        connectionError: details ? `${message} (${details})` : message,
      }));
      return false;
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

  const speakWebTts = useCallback((text: string): boolean => {
    const runtimeWindow = (typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined) as WebWindow | undefined;
    if (Platform.OS !== 'web' || !runtimeWindow?.speechSynthesis) {
      return false;
    }

    try {
      const UtteranceCtor = (globalThis as any).SpeechSynthesisUtterance;
      if (!UtteranceCtor) {
        return false;
      }
      const utterance = new UtteranceCtor(text);
      utterance.lang = 'en-US';
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = () => {
        setState((prev) => ({ ...prev, isSpeaking: false }));
        maybeRestartListeningAfterSpeech();
      };
      utterance.onerror = () => {
        setState((prev) => ({ ...prev, isSpeaking: false }));
        maybeRestartListeningAfterSpeech();
      };
      runtimeWindow.speechSynthesis.cancel();
      runtimeWindow.speechSynthesis.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }, [maybeRestartListeningAfterSpeech]);

  /** Fallback TTS using Web Speech API on web or expo-speech on native. */
  const speak = useCallback(async (text: string) => {
    if (!text.trim()) {
      return;
    }

    setState((prev) => ({ ...prev, isSpeaking: true }));
    if (speakWebTts(text)) {
      return;
    }
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
  }, [maybeRestartListeningAfterSpeech, resolvePreferredVoice, speakWebTts]);

  const stopSpeaking = useCallback(() => {
    suppressAutoRestartRef.current = true;
    const runtimeWindow = (typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined) as WebWindow | undefined;
    if (Platform.OS === 'web' && runtimeWindow?.speechSynthesis) {
      runtimeWindow.speechSynthesis.cancel();
    }
    stopWebAudioSource();
    Speech.stop();
    // Also stop any audio playback
    if (audioPlaybackRef.current) {
      audioPlaybackRef.current.stopAsync().catch(() => undefined);
      audioPlaybackRef.current.unloadAsync().catch(() => undefined);
      audioPlaybackRef.current = null;
    }
    setState((prev) => ({ ...prev, isSpeaking: false }));
  }, [stopWebAudioSource]);

  /** Play base64 PCM16 audio response from OpenAI Realtime via expo-av. */
  const playAudioResponse = useCallback(async (pcm16Base64: string) => {
    try {
      if (Platform.OS === 'web') {
        const audioCtx = await ensureWebAudioContextActive();
        if (!audioCtx) {
          throw new Error('AudioContext unavailable');
        }

        if (audioCtx.state !== 'running' && typeof audioCtx.resume === 'function') {
          await audioCtx.resume();
        }
        if (audioCtx.state !== 'running') {
          throw new Error('AudioContext is suspended');
        }

        stopWebAudioSource();
        const binary = atob(pcm16Base64);
        const pcm = new Int16Array(binary.length / 2);
        for (let i = 0; i < pcm.length; i++) {
          const lo = binary.charCodeAt(i * 2);
          const hi = binary.charCodeAt(i * 2 + 1);
          let sample = (hi << 8) | lo;
          if (sample >= 0x8000) sample -= 0x10000;
          pcm[i] = sample;
        }

        const audioBuffer = audioCtx.createBuffer(1, pcm.length, 24000);
        const channel = audioBuffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) {
          channel[i] = pcm[i] / 32768;
        }

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        webAudioSourceRef.current = source;

        setState((prev) => ({ ...prev, isSpeaking: true, isProcessing: false }));
        source.onended = () => {
          if (webAudioSourceRef.current === source) {
            webAudioSourceRef.current = null;
          }
          setState((prev) => ({ ...prev, isSpeaking: false }));
          maybeRestartListeningAfterSpeech();
        };

        source.start(0);
        return;
      }

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
  }, [ensureWebAudioContextActive, maybeRestartListeningAfterSpeech, stopWebAudioSource]);

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

    const isBrowserOffline = () =>
      Platform.OS === 'web' && webWindow?.navigator?.onLine === false;

    const stopHealthPolling = () => {
      if (healthPollTimer) {
        clearInterval(healthPollTimer);
        healthPollTimer = null;
      }
    };

    const startHealthPolling = () => {
      if (healthPollTimer) return;
      healthPollTimer = setInterval(() => {
        ApiService.healthCheck()
          .then((healthy) => {
            if (isMounted) {
              setState((prev) => ({
                ...prev,
                isConnected: healthy,
                connectionStatus: healthy ? 'connected' : 'disconnected',
                connectionError: healthy ? null : prev.connectionError || 'Server unreachable — check Settings',
              }));
            }
          })
          .catch(() => {
            if (isMounted) {
              setState((prev) => ({
                ...prev,
                isConnected: false,
                connectionStatus: 'disconnected',
              }));
            }
          });
      }, 10000);
    };

    const scheduleReconnect = (reason: string) => {
      if (!isMounted || !realtimeEnabled || websocket.isConnected()) {
        return;
      }

      if (isBrowserOffline()) {
        clearWsReconnectTimer();
        setState((prev) => ({
          ...prev,
          isConnected: false,
          connectionStatus: 'disconnected',
          connectionError: 'No network connection. Waiting to reconnect…',
        }));
        return;
      }

      if (wsReconnectTimerRef.current) {
        return;
      }

      wsReconnectAttemptsRef.current += 1;
      const attempt = wsReconnectAttemptsRef.current;
      if (attempt > WS_MAX_RECONNECT_ATTEMPTS) {
        setState((prev) => ({
          ...prev,
          isConnected: false,
          connectionStatus: 'disconnected',
          connectionError: `${reason}. Voice server offline — using text mode`,
        }));
        startHealthPolling();
        return;
      }

      const baseDelay = Math.min(
        WS_BACKOFF_MAX_MS,
        WS_BACKOFF_BASE_MS * (2 ** (attempt - 1)),
      );
      const jitter = Math.floor(Math.random() * Math.max(220, baseDelay * 0.25));
      const delay = baseDelay + jitter;
      const seconds = Math.max(1, Math.round(delay / 1000));
      setState((prev) => ({
        ...prev,
        isConnected: false,
        connectionStatus: 'connecting',
        connectionError: `${reason}. Reconnecting in ${seconds}s (${attempt}/${WS_MAX_RECONNECT_ATTEMPTS})`,
      }));

      wsReconnectTimerRef.current = setTimeout(() => {
        wsReconnectTimerRef.current = null;
        if (isMounted && !websocket.isConnected()) {
          void connectWs();
        }
      }, delay);
    };

    const connectWs = async () => {
      if (!realtimeEnabled) {
        const healthy = await ApiService.healthCheck();
        if (isMounted) {
          setState((prev) => ({
            ...prev,
            isConnected: healthy,
            connectionStatus: healthy ? 'connected' : 'disconnected',
            connectionError: healthy ? null : 'Server unreachable — check Settings',
          }));
          if (!healthy) startHealthPolling();
        }
        return;
      }

      if (isBrowserOffline()) {
        setState((prev) => ({
          ...prev,
          isConnected: false,
          connectionStatus: 'disconnected',
          connectionError: 'No network connection. Waiting to reconnect…',
        }));
        return;
      }

      clearWsReconnectTimer();
      setState((prev) => ({
        ...prev,
        connectionStatus: 'connecting',
      }));

      try {
        await websocket.connect(state.sessionId);
        if (isMounted) {
          wsReconnectAttemptsRef.current = 0;
          stopHealthPolling();
          setState((prev) => ({
            ...prev,
            isConnected: true,
            connectionStatus: 'connected',
            connectionError: null,
          }));
        }
      } catch (err: any) {
        if (!isMounted) return;
        const errorMessage = typeof err?.message === 'string'
          ? err.message
          : 'Unable to connect to voice server';
        setState((prev) => ({
          ...prev,
          isConnected: false,
          connectionStatus: 'disconnected',
          connectionError: errorMessage,
        }));
        scheduleReconnect(errorMessage);
      }
    };

    const onResponse = (data: { text?: string; hasAudio?: boolean }) => {
      if (data?.text) {
        if (data.hasAudio) {
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
          handleAssistantText(data.text);
        }
      }
    };

    const onAudioResponse = (data: { audio: string }) => {
      if (data?.audio) {
        playAudioResponse(data.audio).catch(() => undefined);
      }
    };

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

    const onInputTranscript = (data: { text: string }) => {
      const transcriptText = typeof data?.text === 'string' ? data.text.trim() : '';
      const pendingVoiceMessageId = pendingVoiceMessageIdRef.current;
      console.debug('[Voice] input_transcript callback', {
        transcriptText,
        pendingVoiceMessageId,
        raw: data,
      });

      if (!transcriptText || !isMounted) {
        console.debug('[Voice] input_transcript ignored', {
          reason: !transcriptText ? 'empty_transcript' : 'unmounted',
        });
        return;
      }

      setState((prev) => {
        const result = applyInputTranscriptToMessages(
          prev.messages,
          transcriptText,
          pendingVoiceMessageId,
          (text) => ({
            id: createMessageId(),
            type: 'user',
            text,
            timestamp: new Date(),
          }),
        );

        console.debug('[Voice] input_transcript applied', {
          strategy: result.strategy,
          appliedMessageId: result.appliedMessageId,
        });
        pendingVoiceMessageIdRef.current = null;
        return { ...prev, messages: result.messages, transcript: '' };
      });
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
      setState((prev) => ({
        ...prev,
        isProcessing: false,
        connectionError: message,
        isConnected: false,
        connectionStatus: 'disconnected',
      }));
      scheduleReconnect(message);
    };

    const onDisconnected = () => {
      if (!isMounted) return;
      setState((prev) => ({
        ...prev,
        isConnected: false,
        connectionStatus: 'disconnected',
      }));
      scheduleReconnect('Connection dropped');
    };

    const onConnected = () => {
      if (isMounted) {
        wsReconnectAttemptsRef.current = 0;
        clearWsReconnectTimer();
        setState((prev) => ({
          ...prev,
          isConnected: true,
          connectionStatus: 'connected',
          connectionError: null,
        }));
      }
    };

    const onResponseDone = () => {
      if (isMounted) {
        setState((prev) => ({ ...prev, isProcessing: false }));
      }
    };

    const handleOnline = () => {
      if (!isMounted || !realtimeEnabled) {
        return;
      }
      wsReconnectAttemptsRef.current = 0;
      clearWsReconnectTimer();
      void connectWs();
    };

    const handleOffline = () => {
      if (!isMounted || !realtimeEnabled) {
        return;
      }
      clearWsReconnectTimer();
      setState((prev) => ({
        ...prev,
        isConnected: false,
        connectionStatus: 'disconnected',
        connectionError: 'No network connection. Waiting to reconnect…',
      }));
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
      if (Platform.OS === 'web' && webWindow?.addEventListener) {
        webWindow.addEventListener('online', handleOnline);
        webWindow.addEventListener('offline', handleOffline);
      }
    } else {
      startHealthPolling();
    }

    return () => {
      isMounted = false;
      clearTurnTimers();
      if (webRecognitionRef.current) {
        try {
          webRecognitionRef.current.abort();
        } catch {
          // noop
        }
        webRecognitionRef.current = null;
      }
      stopHealthPolling();
      clearWsReconnectTimer();
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
        if (Platform.OS === 'web' && webWindow?.removeEventListener) {
          webWindow.removeEventListener('online', handleOnline);
          webWindow.removeEventListener('offline', handleOffline);
        }
        websocket.disconnect();
      }
    };
  }, [
    appendMessage,
    clearTurnTimers,
    clearWsReconnectTimer,
    handleAssistantText,
    playAudioResponse,
    retryToken,
    state.sessionId,
    webWindow,
  ]);

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
          voiceTurnInFlightRef.current = false;
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
        voiceTurnInFlightRef.current = false;
      } catch (error: any) {
        const message = typeof error?.message === 'string'
          ? error.message
          : 'Could not connect to server';
        appendMessage({
          id: createMessageId(),
          type: 'system',
          text: `Error: ${message}. Please check your connection and retry.`,
          timestamp: new Date(),
        });
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          connectionError: message,
          isConnected: false,
          connectionStatus: 'disconnected',
        }));
        voiceTurnInFlightRef.current = false;
      }
    },
    [appendMessage, clearTurnTimers, handleAssistantText, state.sessionId],
  );

  const stopListening = useCallback((processTurn = true) => {
    clearTurnTimers();

    if (Platform.OS === 'web' && webRecognitionRef.current) {
      try {
        if (processTurn) {
          webRecognitionRef.current.stop();
        } else {
          webRecognitionRef.current.abort();
        }
      } catch {
        // noop
      }
    }

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
            const pendingVoiceMessageId = createMessageId();
            pendingVoiceMessageIdRef.current = pendingVoiceMessageId;
            appendMessage({
              id: pendingVoiceMessageId,
              type: 'user',
              text: VOICE_MESSAGE_PLACEHOLDER,
              timestamp: new Date(),
            });
            setState((prev) => ({ ...prev, transcript: '' }));

            // Send audio to OpenAI Realtime via WebSocket
            websocket.sendAudioBuffer(pcm16Base64);
            return;
          }

          // --- WEB REALTIME PATH: convert recording to PCM16 and send via Realtime WS ---
          if (Platform.OS === 'web' && websocket.isConnected()) {
            try {
              const pcm16Base64 = await convertWebRecordingToPcm16Base64(uri);
              const pendingVoiceMessageId = createMessageId();
              pendingVoiceMessageIdRef.current = pendingVoiceMessageId;
              appendMessage({
                id: pendingVoiceMessageId,
                type: 'user',
                text: VOICE_MESSAGE_PLACEHOLDER,
                timestamp: new Date(),
              });
              setState((prev) => ({ ...prev, transcript: '' }));
              websocket.sendAudioBuffer(pcm16Base64);
              return;
            } catch {
              // Fall back to server-side transcription if browser decode/resample fails.
            }

            const transcript = (await ApiService.transcribeAudio(uri)).trim();
            if (!transcript) {
              appendMessage({
                id: createMessageId(),
                type: 'system',
                text: 'I could not hear any speech. Please try again.',
                timestamp: new Date(),
              });
              setState((prev) => ({ ...prev, isProcessing: false, transcript: '' }));
              return;
            }
            await sendMessage(transcript);
            return;
          }

          // --- FALLBACK PATH: REST API for Android or when WS disconnected ---
          const response = await ApiService.processVoiceAudio(uri, state.sessionId);
          const transcript = typeof response.entities?.transcript === 'string'
            ? response.entities.transcript.trim()
            : '';
          const userText = transcript || VOICE_MESSAGE_PLACEHOLDER;
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
        } catch (error: any) {
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message.trim()
            : 'Voice capture failed. Please try again.';
          appendMessage({
            id: createMessageId(),
            type: 'system',
            text: `Error: ${detail}`,
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
  }, [appendMessage, clearTurnTimers, handleAssistantText, sendMessage, state.sessionId]);

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

      if (Platform.OS === 'web') {
        const webWindow = (typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined) as WebWindow | undefined;
        const RecognitionCtor = webWindow?.webkitSpeechRecognition || webWindow?.SpeechRecognition;
        const isBraveBrowser = !!webWindow?.navigator?.brave;
        if (RecognitionCtor && !isBraveBrowser && !webSpeechFallbackToRecorderRef.current) {
          const recognition = new RecognitionCtor();
          webRecognitionRef.current = recognition;
          webSpeechHadResultRef.current = false;
          webSpeechLastErrorRef.current = null;
          webSpeechLatestTranscriptRef.current = '';

          recognition.lang = 'en-US';
          recognition.continuous = false;
          recognition.interimResults = true;
          recognition.maxAlternatives = 1;

          recognition.onstart = () => {
            webSpeechLastErrorRef.current = null;
            setState((prev) => ({
              ...prev,
              isListening: true,
              transcript: 'Listening...',
              connectionError: prev.connectionError?.startsWith('Speech recognition error')
                ? null
                : prev.connectionError,
            }));
          };

          recognition.onresult = (event: any) => {
            let finalText = '';
            let interimText = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const chunk = String(event.results[i]?.[0]?.transcript || '').trim();
              if (!chunk) continue;
              if (event.results[i].isFinal) {
                finalText = `${finalText} ${chunk}`.trim();
              } else {
                interimText = `${interimText} ${chunk}`.trim();
              }
            }

            if (interimText) {
              webSpeechLatestTranscriptRef.current = interimText;
              setState((prev) => ({ ...prev, transcript: interimText }));
            }

            if (finalText && !voiceTurnInFlightRef.current) {
              webSpeechHadResultRef.current = true;
              webSpeechLatestTranscriptRef.current = finalText;
              voiceTurnInFlightRef.current = true;
              setState((prev) => ({ ...prev, transcript: finalText, isListening: false }));
              recognition.stop();
              sendMessage(finalText).catch(() => undefined);
            }
          };

          recognition.onerror = (event) => {
            const err = typeof event?.error === 'string' ? event.error : 'speech_error';
            webSpeechLastErrorRef.current = err;
            if (err === 'network' || err === 'audio-capture') {
              // Some browsers (notably Brave) expose SpeechRecognition but fail to
              // produce transcripts reliably. Switch to recorder mode for stability.
              webSpeechFallbackToRecorderRef.current = true;
              setState((prev) => ({
                ...prev,
                isListening: false,
                transcript: '',
                connectionError: 'Browser speech recognition unavailable. Switching to recorder mode.',
              }));
              try {
                recognition.abort();
              } catch {
                // noop
              }
              return;
            }
            if (WEB_SPEECH_FATAL_ERRORS.has(err)) {
              setState((prev) => ({
                ...prev,
                isListening: false,
                transcript: '',
                connectionError: err === 'not-allowed'
                  ? 'Microphone blocked. Allow mic access and use an HTTPS page (or localhost).'
                  : 'Speech recognition unavailable in this browser/session',
              }));
              return;
            }
            if (WEB_SPEECH_RESTARTABLE_ERRORS.has(err)) {
              setState((prev) => ({ ...prev, isListening: true, transcript: 'Listening...' }));
              return;
            }
            if (err !== 'aborted') {
              setState((prev) => ({
                ...prev,
                isListening: false,
                transcript: '',
                connectionError: err === 'not-allowed'
                  ? 'Microphone blocked. Allow mic access and use an HTTPS page (or localhost).'
                  : `Speech recognition error: ${err}`,
              }));
            }
          };

          recognition.onend = () => {
            webRecognitionRef.current = null;
            const latestTranscript = webSpeechLatestTranscriptRef.current.trim();
            const lastError = webSpeechLastErrorRef.current;
            const canRestart = !lastError || WEB_SPEECH_RESTARTABLE_ERRORS.has(lastError);
            const shouldSendLatestTranscript =
              !webSpeechHadResultRef.current &&
              !voiceTurnInFlightRef.current &&
              !lastError &&
              latestTranscript.length > 0;
            if (shouldSendLatestTranscript) {
              webSpeechHadResultRef.current = true;
              voiceTurnInFlightRef.current = true;
              setState((prev) => ({ ...prev, isListening: false, transcript: latestTranscript }));
              sendMessage(latestTranscript).catch(() => undefined);
            }
            const shouldRestart =
              stateRef.current.liveSessionActive &&
              !stateRef.current.isProcessing &&
              !stateRef.current.isSpeaking &&
              !voiceTurnInFlightRef.current &&
              !webSpeechHadResultRef.current &&
              canRestart;
            if (shouldRestart) {
              // Keep the UI in a listening state while restarting recognition to avoid pulse flicker.
              setState((prev) => ({ ...prev, isListening: true, transcript: 'Listening...' }));
            } else {
              setState((prev) => ({ ...prev, isListening: false, transcript: '' }));
            }
            if (shouldRestart) {
              autoRestartTimerRef.current = setTimeout(() => {
                autoRestartTimerRef.current = null;
                if (stateRef.current.liveSessionActive) {
                  void startListeningRef.current?.();
                }
              }, 250);
            }
            webSpeechLastErrorRef.current = null;
            webSpeechLatestTranscriptRef.current = '';
          };

          recognition.start();
          return;
        }
      }

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
        setState((prev) => ({
          ...prev,
          isListening: false,
          transcript: '',
          connectionError: 'Microphone permission is required to start live voice.',
        }));
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
    } catch (error: any) {
      voiceTurnInFlightRef.current = false;
      const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'Microphone startup failed';
      setState((prev) => ({
        ...prev,
        isListening: false,
        transcript: '',
        connectionError: `Voice startup issue: ${message}`,
      }));
      if (stateRef.current.liveSessionActive) {
        scheduleLiveSessionRestart(700);
      }
    }
  }, [canUseMicrophone, scheduleLiveSessionRestart, sendMessage, stopListening]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  useEffect(() => (
    () => {
      clearWebAudioUnlockHandler();
      stopWebAudioSource();
      if (webAudioContextRef.current) {
        webAudioContextRef.current.close?.().catch(() => undefined);
        webAudioContextRef.current = null;
      }
    }
  ), [clearWebAudioUnlockHandler, stopWebAudioSource]);

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

    const micReady = await ensureWebMicrophonePermission();
    if (!micReady) {
      return;
    }

    if (Platform.OS === 'web') {
      const runtimeWindow = (typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined) as WebWindow | undefined;
      if (runtimeWindow?.navigator?.brave) {
        webSpeechFallbackToRecorderRef.current = true;
      }
      void ensureWebAudioContextActive();
    }

    setState((prev) => ({ ...prev, liveSessionActive: true }));
    await startListening();
  }, [clearTurnTimers, ensureWebAudioContextActive, ensureWebMicrophonePermission, startListening, stopListening, stopSpeaking]);

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
    pendingVoiceMessageIdRef.current = null;
    wsReconnectAttemptsRef.current = 0;
    clearWsReconnectTimer();
    setState((prev) => ({
      ...prev,
      messages: [],
      transcript: '',
      streamingText: '',
      liveSessionActive: false,
      requiresConfirmation: false,
      confirmationPrompt: null,
      connectionError: null,
      connectionStatus: 'connecting',
      sessionId: generateSessionId(),
    }));
  }, [clearTurnTimers, clearWsReconnectTimer, stopListening, stopSpeaking]);

  const restoreMessages = useCallback((_: RestoredChat, storedMessages: StoredMessage[]) => {
    const mapped: Message[] = storedMessages.map((message) => ({
      id: message.id || createMessageId(),
      type: message.role,
      text: message.text,
      timestamp: new Date(message.created_at || Date.now()),
    }));

    pendingVoiceMessageIdRef.current = null;
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
    pendingVoiceMessageIdRef.current = null;
    setState((prev) => ({
      ...prev,
      messages: [],
      transcript: '',
      streamingText: '',
      requiresConfirmation: false,
      confirmationPrompt: null,
    }));
  }, []);

  const retryConnection = useCallback(() => {
    wsReconnectAttemptsRef.current = 0;
    clearWsReconnectTimer();
    websocket.disconnect();
    setState((prev) => ({
      ...prev,
      isConnected: false,
      connectionStatus: 'connecting',
      connectionError: 'Retrying connection…',
    }));
    setRetryToken((prev) => prev + 1);
  }, [clearWsReconnectTimer]);

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
        retryConnection,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
};
