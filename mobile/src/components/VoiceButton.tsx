import React from 'react';
import { View, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useVoice } from '../hooks/useVoice';

export const VoiceButton: React.FC = () => {
  const { isListening, isProcessing, isSpeaking, liveSessionActive, toggleLiveSession, canUseMicrophone } = useVoice();
  const [scale] = React.useState(new Animated.Value(1));
  const pulseRef = React.useRef<Animated.CompositeAnimation | null>(null);

  React.useEffect(() => {
    if (liveSessionActive || isListening || isSpeaking) {
      pulseRef.current?.stop();
      pulseRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.1, duration: 500, useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      );
      pulseRef.current.start();
    } else {
      pulseRef.current?.stop();
      pulseRef.current = null;
      scale.setValue(1);
    }
    return () => {
      pulseRef.current?.stop();
      pulseRef.current = null;
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
