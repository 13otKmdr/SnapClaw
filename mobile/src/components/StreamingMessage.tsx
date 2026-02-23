/**
 * StreamingMessage — shows Agent Zero's live log lines as they arrive,
 * then transitions to the final response text.
 * A pulsing cursor indicates the agent is still working.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

interface StreamingMessageProps {
  text: string;         // accumulated text so far
  isStreaming: boolean; // true while agent_update events are arriving
}

export const StreamingMessage: React.FC<StreamingMessageProps> = ({ text, isStreaming }) => {
  const opacity = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (isStreaming) {
      animRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.2, duration: 500, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        ]),
      );
      animRef.current.start();
    } else {
      animRef.current?.stop();
      opacity.setValue(1);
    }
    return () => animRef.current?.stop();
  }, [isStreaming, opacity]);

  return (
    <View style={styles.bubble}>
      <Text style={styles.text}>{text}</Text>
      {isStreaming && (
        <Animated.Text style={[styles.cursor, { opacity }]}>▌</Animated.Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  bubble: {
    backgroundColor: '#1e1e2e',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    padding: 12,
    maxWidth: '85%',
    alignSelf: 'flex-start',
    marginVertical: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  text: {
    color: '#e0e0e0',
    fontSize: 16,
    lineHeight: 22,
    flexShrink: 1,
  },
  cursor: {
    color: '#7c7cff',
    fontSize: 16,
    marginLeft: 2,
  },
});

export default StreamingMessage;
