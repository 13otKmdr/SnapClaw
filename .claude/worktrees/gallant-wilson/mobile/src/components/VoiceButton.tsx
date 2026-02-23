import React from 'react';
import { View, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useVoice } from '../hooks/useVoice';

export const VoiceButton: React.FC = () => {
  const { isListening, isProcessing, isSpeaking, startListening, stopListening, stopSpeaking } = useVoice();
  const [scale] = React.useState(new Animated.Value(1));

  React.useEffect(() => {
    if (isListening || isSpeaking) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.1, duration: 500, useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      ).start();
    } else {
      scale.setValue(1);
    }
  }, [isListening, isSpeaking]);

  const handlePress = () => {
    if (isSpeaking) {
      stopSpeaking();
    } else if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  const getIcon = () => {
    if (isProcessing) return 'hourglass';
    if (isSpeaking) return 'stop';
    if (isListening) return 'mic';
    return 'mic-outline';
  };

  const getColor = () => {
    if (isProcessing) return '#FFA500';
    if (isSpeaking) return '#FF4444';
    if (isListening) return '#00FF00';
    return '#FFFFFF';
  };

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        style={[styles.button, isListening && styles.buttonActive]}
        onPress={handlePress}
        disabled={isProcessing}
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
