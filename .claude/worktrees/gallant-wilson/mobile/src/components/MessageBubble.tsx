import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
  actionTaken?: boolean;
  actionResult?: string;
}

interface MessageBubbleProps {
  message: Message;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.type === 'user';
  const isSystem = message.type === 'system';

  return (
    <View style={[styles.container, isUser ? styles.userContainer : isSystem ? styles.systemContainer : styles.assistantContainer]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : isSystem ? styles.systemBubble : styles.assistantBubble]}>
        <Text style={styles.text}>{message.text}</Text>
        {message.actionTaken && (
          <View style={styles.actionBadge}>
            <Text style={styles.actionText}>✓ {message.actionResult || 'Action completed'}</Text>
          </View>
        )}
      </View>
      <Text style={styles.time}>
        {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
    maxWidth: '85%',
  },
  userContainer: {
    alignSelf: 'flex-end',
  },
  assistantContainer: {
    alignSelf: 'flex-start',
  },
  systemContainer: {
    alignSelf: 'center',
  },
  bubble: {
    padding: 12,
    borderRadius: 16,
  },
  userBubble: {
    backgroundColor: '#007AFF',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: '#2a2a2a',
    borderBottomLeftRadius: 4,
  },
  systemBubble: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
  },
  text: {
    color: '#fff',
    fontSize: 16,
  },
  time: {
    color: '#666',
    fontSize: 10,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  actionBadge: {
    marginTop: 8,
    padding: 6,
    backgroundColor: '#0a3a0a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#00FF00',
  },
  actionText: {
    color: '#00FF00',
    fontSize: 12,
  },
});

export default MessageBubble;
