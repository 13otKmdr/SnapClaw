import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useVoice } from '../hooks/useVoice';
import { VoiceButton, MessageBubble, ConfirmationModal } from '../components';

type RootStackParamList = {
  Home: undefined;
  Settings: undefined;
};

type HomeScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Home'>;

interface Props {
  navigation: HomeScreenNavigationProp;
}

export const HomeScreen: React.FC<Props> = ({ navigation }) => {
  const {
    isListening,
    isProcessing,
    isSpeaking,
    isConnected,
    transcript,
    messages,
    requiresConfirmation,
    confirmationPrompt,
    startListening,
    stopListening,
    sendMessage,
    confirmAction,
    clearHistory,
  } = useVoice();

  const scrollViewRef = useRef<ScrollView>(null);
  const [textInput, setTextInput] = React.useState('');

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const handleSendText = () => {
    if (textInput.trim()) {
      sendMessage(textInput.trim());
      setTextInput('');
    }
  };

  const statusText = () => {
    if (isProcessing) return 'Processing...';
    if (isSpeaking) return 'Speaking...';
    if (isListening) return 'Listening...';
    if (isConnected) return 'Connected';
    return 'Ready (Offline Mode)';
  };

  const statusColor = () => {
    if (isProcessing) return '#FFA500';
    if (isSpeaking) return '#FF4444';
    if (isListening) return '#00FF00';
    if (isConnected) return '#007AFF';
    return '#666';
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Voice AI</Text>
        <View style={styles.headerButtons}>
          <TouchableOpacity onPress={clearHistory} style={styles.headerButton}>
            <Ionicons name="trash-outline" size={24} color="#666" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={styles.headerButton}>
            <Ionicons name="settings-outline" size={24} color="#666" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Status Bar */}
      <View style={styles.statusBar}>
        <View style={[styles.statusDot, { backgroundColor: statusColor() }]} />
        <Text style={[styles.statusText, { color: statusColor() }]}>{statusText()}</Text>
      </View>

      {/* Transcript Preview */}
      {(isListening || transcript) && (
        <View style={styles.transcriptBar}>
          <Text style={styles.transcriptText} numberOfLines={1}>
            {transcript || 'Listening...'}
          </Text>
        </View>
      )}

      {/* Messages */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.messagesContainer}
        contentContainerStyle={styles.messagesContent}
      >
        {messages.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="mic-outline" size={64} color="#333" />
            <Text style={styles.emptyText}>
              Tap the microphone button below to start talking
            </Text>
            <Text style={styles.emptySubtext}>
              Or type a message in the text field
            </Text>
          </View>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
      </ScrollView>

      {/* Input Area */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={90}
      >
        <View style={styles.inputArea}>
          <TextInput
            style={styles.textInput}
            placeholder="Type a message..."
            placeholderTextColor="#666"
            value={textInput}
            onChangeText={setTextInput}
            onSubmitEditing={handleSendText}
            returnKeyType="send"
            editable={!isProcessing}
          />
          <TouchableOpacity
            style={[styles.sendButton, !textInput.trim() && styles.sendButtonDisabled]}
            onPress={handleSendText}
            disabled={!textInput.trim() || isProcessing}
          >
            <Ionicons name="send" size={20} color={textInput.trim() ? '#fff' : '#333'} />
          </TouchableOpacity>
          <VoiceButton />
        </View>
      </KeyboardAvoidingView>

      {/* Confirmation Modal */}
      <ConfirmationModal
        visible={requiresConfirmation}
        prompt={confirmationPrompt || 'Do you want to proceed?'}
        onConfirm={() => confirmAction(true)}
        onCancel={() => confirmAction(false)}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 16,
  },
  headerButton: {
    padding: 4,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#111',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 12,
  },
  transcriptBar: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1a1a1a',
  },
  transcriptText: {
    color: '#00FF00',
    fontSize: 14,
    fontStyle: 'italic',
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 16,
    paddingBottom: 24,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 100,
  },
  emptyText: {
    color: '#666',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
    maxWidth: 250,
  },
  emptySubtext: {
    color: '#444',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#111',
    borderTopWidth: 1,
    borderTopColor: '#222',
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 16,
  },
  sendButton: {
    backgroundColor: '#007AFF',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#1a1a1a',
  },
});

export default HomeScreen;
