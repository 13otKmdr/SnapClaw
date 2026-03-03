import React from 'react';
import { TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useVoice } from '../hooks/useVoice';

type WebMediaStreamTrack = { stop: () => void };
type WebMediaStream = { getTracks: () => WebMediaStreamTrack[] };
type WebAudioAnalyser = {
  fftSize: number;
  smoothingTimeConstant: number;
  getByteTimeDomainData: (array: Uint8Array) => void;
  disconnect?: () => void;
};
type WebAudioSource = {
  connect: (node: unknown) => void;
  disconnect?: () => void;
};
type WebAudioContext = {
  state?: string;
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
  createAnalyser: () => WebAudioAnalyser;
  createMediaStreamSource: (stream: WebMediaStream) => WebAudioSource;
};
type WebWindow = {
  navigator?: {
    mediaDevices?: {
      getUserMedia?: (constraints: { audio: Record<string, unknown> | boolean }) => Promise<WebMediaStream>;
    };
  };
  AudioContext?: new () => WebAudioContext;
  webkitAudioContext?: new () => WebAudioContext;
};

export const VoiceButton: React.FC = () => {
  const { isListening, isProcessing, isSpeaking, liveSessionActive, toggleLiveSession, canUseMicrophone } = useVoice();
  const scale = React.useRef(new Animated.Value(1)).current;
  const meterEnabled = canUseMicrophone && (liveSessionActive || isListening);
  const meterStreamRef = React.useRef<WebMediaStream | null>(null);
  const meterAudioCtxRef = React.useRef<WebAudioContext | null>(null);
  const meterSourceRef = React.useRef<WebAudioSource | null>(null);
  const meterAnalyserRef = React.useRef<WebAudioAnalyser | null>(null);
  const meterFrameRef = React.useRef<number | null>(null);
  const smoothedScaleRef = React.useRef(1);

  const stopVolumeMeter = React.useCallback(() => {
    if (meterFrameRef.current !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }

    meterSourceRef.current?.disconnect?.();
    meterSourceRef.current = null;
    meterAnalyserRef.current?.disconnect?.();
    meterAnalyserRef.current = null;

    if (meterStreamRef.current) {
      for (const track of meterStreamRef.current.getTracks()) {
        track.stop();
      }
      meterStreamRef.current = null;
    }

    if (meterAudioCtxRef.current) {
      meterAudioCtxRef.current.close?.().catch(() => undefined);
      meterAudioCtxRef.current = null;
    }

    smoothedScaleRef.current = 1;
    Animated.spring(scale, {
      toValue: 1,
      friction: 7,
      tension: 90,
      useNativeDriver: true,
    }).start();
  }, [scale]);

  React.useEffect(() => {
    let cancelled = false;

    const startVolumeMeter = async () => {
      if (Platform.OS !== 'web' || !meterEnabled) {
        stopVolumeMeter();
        return;
      }

      const runtimeWindow = (typeof globalThis !== 'undefined'
        ? (globalThis as any).window
        : undefined) as WebWindow | undefined;
      const mediaDevices = runtimeWindow?.navigator?.mediaDevices;
      const getUserMedia = mediaDevices?.getUserMedia;
      const AudioContextCtor = runtimeWindow?.AudioContext || runtimeWindow?.webkitAudioContext;

      if (!getUserMedia || !AudioContextCtor) {
        stopVolumeMeter();
        return;
      }

      try {
        stopVolumeMeter();
        const stream = await getUserMedia.call(mediaDevices, {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }

        const audioCtx = new AudioContextCtor();
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
          try {
            await audioCtx.resume();
          } catch {
            // noop
          }
        }

        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.85;
        source.connect(analyser);

        const sampleBuffer = new Uint8Array(analyser.fftSize);
        meterStreamRef.current = stream;
        meterAudioCtxRef.current = audioCtx;
        meterSourceRef.current = source;
        meterAnalyserRef.current = analyser;

        const updateScale = () => {
          if (!meterAnalyserRef.current) {
            return;
          }
          meterAnalyserRef.current.getByteTimeDomainData(sampleBuffer);
          let energy = 0;
          for (let i = 0; i < sampleBuffer.length; i++) {
            const normalized = (sampleBuffer[i] - 128) / 128;
            energy += normalized * normalized;
          }
          const rms = Math.sqrt(energy / sampleBuffer.length);
          const boostedLevel = Math.min(1, rms * 5);
          const targetScale = 1 + boostedLevel * 0.22;
          const nextScale = smoothedScaleRef.current * 0.7 + targetScale * 0.3;
          smoothedScaleRef.current = nextScale;
          scale.setValue(nextScale);

          if (typeof globalThis.requestAnimationFrame === 'function') {
            meterFrameRef.current = globalThis.requestAnimationFrame(updateScale);
          }
        };

        if (typeof globalThis.requestAnimationFrame === 'function') {
          meterFrameRef.current = globalThis.requestAnimationFrame(updateScale);
        } else {
          scale.setValue(1);
        }
      } catch {
        stopVolumeMeter();
      }
    };

    void startVolumeMeter();
    return () => {
      cancelled = true;
      stopVolumeMeter();
    };
  }, [meterEnabled, scale, stopVolumeMeter]);

  React.useEffect(() => {
    if (Platform.OS !== 'web' && (liveSessionActive || isListening || isSpeaking)) {
      Animated.timing(scale, {
        toValue: 1.06,
        duration: 120,
        useNativeDriver: true,
      }).start();
      return;
    }

    if (Platform.OS !== 'web') {
      Animated.timing(scale, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
    }

    return () => {
      // noop
    };
  }, [isListening, isSpeaking, liveSessionActive, scale]);

  const handlePress = () => {
    toggleLiveSession().catch(() => undefined);
  };

  const getIcon = () => {
    if (isProcessing && !liveSessionActive) return 'hourglass';
    if (isSpeaking || liveSessionActive) return 'stop';
    if (isListening) return 'mic';
    return 'mic-outline';
  };

  const getColor = () => {
    if (!canUseMicrophone) return '#666';
    if (isProcessing && !liveSessionActive) return '#FFA500';
    if (isSpeaking) return '#FF4444';
    if (isListening || liveSessionActive) return '#00FF00';
    return '#FFFFFF';
  };

  const getAccessibilityLabel = () => {
    if (!canUseMicrophone) return 'Microphone unavailable';
    if (liveSessionActive) return 'End live voice session';
    if (isProcessing) return 'Voice Assistant processing';
    return 'Start live voice session';
  };

  const getAccessibilityHint = () => {
    if (!canUseMicrophone) return 'Enable microphone permissions and supported browser features';
    if (liveSessionActive) return 'Double tap to interrupt and end live voice session';
    if (isProcessing) return 'Please wait for the process to complete';
    return 'Double tap to start live voice session';
  };

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        style={[styles.button, liveSessionActive && styles.buttonActive]}
        onPress={handlePress}
        activeOpacity={0.85}
        delayPressIn={0}
        disabled={!canUseMicrophone || (isProcessing && !liveSessionActive)}
        accessibilityRole="button"
        accessibilityLabel={getAccessibilityLabel()}
        accessibilityHint={getAccessibilityHint()}
        accessibilityState={{ disabled: !canUseMicrophone || (isProcessing && !liveSessionActive), busy: isProcessing }}
      >
        <Ionicons name={getIcon() as any} size={40} color={getColor()} />
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  button: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#333',
  },
  buttonActive: {
    borderColor: '#00FF00',
    backgroundColor: '#0a2a0a',
  },
});

export default VoiceButton;
