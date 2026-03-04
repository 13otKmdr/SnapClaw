import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useVoice } from '../hooks/useVoice';
import { useChats } from '../hooks/useChats';
import { VoiceButton, MessageBubble, StreamingMessage, ChatListModal, ProcessingIndicator } from '../components';

type RootStackParamList = { Home: undefined; Settings: undefined };
type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

export const HomeScreen: React.FC<{ navigation: Nav }> = ({ navigation }) => {
  const {
    isListening, isProcessing, isSpeaking, liveSessionActive, connectionStatus,
    connectionError, canUseMicrophone, retryConnection,
    transcript, messages, streamingText,
    sendMessage,
    restoreMessages, clearMessages,
  } = useVoice();

  const { chats, activeChat, selectChat, createChat, refreshChats, setChatSelectedCallback } = useChats();

  const [textInput, setTextInput] = useState('');
  const [chatModalVisible, setChatModalVisible] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When the user picks a chat, restore its messages
  useEffect(() => {
    setChatSelectedCallback((chat, stored) => {
      restoreMessages(chat, stored);
    });
  }, [setChatSelectedCallback, restoreMessages]);

  useEffect(() => {
    if (scrollDebounceRef.current) {
      clearTimeout(scrollDebounceRef.current);
    }
    scrollDebounceRef.current = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
      scrollDebounceRef.current = null;
    }, 80);

    return () => {
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
        scrollDebounceRef.current = null;
      }
    };
  }, [messages.length, streamingText]);

  const handleClearMessages = useCallback(() => {
    Alert.alert(
      'Clear Messages',
      'Are you sure you want to clear all messages in this chat?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: clearMessages }
      ]
    );
  }, [clearMessages]);

  const handleSend = useCallback(() => {
    const t = textInput.trim();
    if (t) { sendMessage(t); setTextInput(''); }
  }, [textInput, sendMessage]);

  // ── Status ──────────────────────────────────────────────────────────

  const connectionLabel = connectionStatus === 'connecting'
    ? 'Connecting'
    : connectionStatus === 'connected'
      ? 'Connected'
      : 'Disconnected';

  const statusLabel = isProcessing ? 'Processing your request…'
    : isSpeaking   ? 'Speaking…'
    : isListening  ? 'Listening…'
    : connectionError ? `${connectionLabel}: ${connectionError}`
    : liveSessionActive ? `Live session on · ${connectionLabel}`
    : connectionLabel;

  const statusColor = isProcessing ? '#FFA500'
    : isSpeaking   ? '#ff6b6b'
    : isListening  ? '#00e676'
    : connectionError ? '#ff9f43'
    : liveSessionActive ? '#00e676'
    : connectionStatus === 'connected' ? '#7c7cff'
    : connectionStatus === 'connecting' ? '#f8b64c'
    : '#555';

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => { refreshChats(); setChatModalVisible(true); }}
          style={styles.chatBtn}
          accessibilityRole="button"
          accessibilityHint="Double tap to open chat list"
        >
          <Ionicons name="chatbubbles-outline" size={22} color="#7c7cff" />
          <Text style={styles.chatBtnLabel} numberOfLines={1}>
            {activeChat?.name ?? 'Chats'}
          </Text>
          <Ionicons name="chevron-down" size={14} color="#555" />
        </TouchableOpacity>

        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={handleClearMessages}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Clear messages"
            accessibilityHint="Double tap to clear all messages in current chat"
          >
            <Ionicons name="trash-outline" size={20} color="#555" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('Settings')}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            accessibilityHint="Double tap to open settings"
          >
            <Ionicons name="settings-outline" size={20} color="#555" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Status strip ── */}
      <View style={styles.statusStrip}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusLabel, { color: statusColor }]} numberOfLines={1}>
          {statusLabel}
        </Text>
        {connectionStatus === 'disconnected' && (
          <TouchableOpacity
            onPress={retryConnection}
            style={styles.retryBtn}
            accessibilityRole="button"
            accessibilityLabel="Retry connection"
          >
            <Ionicons name="refresh" size={14} color="#fff" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Transcript bar ── */}
      {(isListening || (transcript && transcript !== '…')) && (
        <View style={styles.transcriptBar}>
          <Ionicons name="mic" size={12} color="#00e676" style={{ marginRight: 6 }} />
          <Text style={styles.transcriptText} numberOfLines={1}>
            {transcript || 'Listening…'}
          </Text>
        </View>
      )}

      {/* ── Messages ── */}
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
      >
        {messages.length === 0 && !streamingText && (
          <View style={styles.empty}>
            <Ionicons name="mic-outline" size={56} color="#222" />
            <Text style={styles.emptyTitle}>Tap once to start a live voice session</Text>
            <Text style={styles.emptySub}>SnapClaw orchestrates agents while you keep talking</Text>
            {!canUseMicrophone && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>
                  Microphone is unavailable in this browser/device configuration.
                </Text>
              </View>
            )}
          </View>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Live streaming text from Agent Zero */}
        {streamingText ? (
          <StreamingMessage text={streamingText} isStreaming={true} />
        ) : null}
        {isProcessing && !streamingText ? (
          <View style={styles.loadingRow}>
            <ProcessingIndicator label="Thinking…" />
          </View>
        ) : null}
      </ScrollView>

      {/* ── Input row ── */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={90}
      >
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="Type a message…"
            placeholderTextColor="#444"
            value={textInput}
            onChangeText={setTextInput}
            onSubmitEditing={handleSend}
            returnKeyType="send"
            editable={!isProcessing}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendBtn, !textInput.trim() && styles.sendBtnOff]}
            onPress={handleSend}
            disabled={!textInput.trim() || isProcessing}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !textInput.trim() || isProcessing }}
          >
            {isProcessing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="send" size={18} color={textInput.trim() ? '#fff' : '#333'} />
            )}
          </TouchableOpacity>
          <VoiceButton />
        </View>
      </KeyboardAvoidingView>

      {/* ── Chat list modal ── */}
      <ChatListModal
        visible={chatModalVisible}
        chats={chats}
        activeChat={activeChat}
        onSelect={selectChat}
        onCreate={createChat}
        onClose={() => setChatModalVisible(false)}
      />

    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#0a0a0a' },

  header:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    paddingHorizontal: 14, paddingVertical: 10,
                    borderBottomWidth: 1, borderBottomColor: '#151515' },
  chatBtn:        { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, maxWidth: '70%' },
  chatBtnLabel:   { color: '#ccc', fontSize: 15, fontWeight: '500', flexShrink: 1 },
  headerRight:    { flexDirection: 'row', gap: 8 },
  iconBtn:        { padding: 6 },

  statusStrip:    { flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#0f0f0f' },
  dot:            { width: 7, height: 7, borderRadius: 4, marginRight: 7 },
  statusLabel:    { fontSize: 12, flex: 1 },
  retryBtn:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#2a2a34',
                    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, gap: 4 },
  retryText:      { color: '#fff', fontSize: 12, fontWeight: '600' },

  transcriptBar:  { flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#0d1a10' },
  transcriptText: { color: '#00e676', fontSize: 13, fontStyle: 'italic', flex: 1 },

  messages:       { flex: 1 },
  messagesContent:{ padding: 14, paddingBottom: 20 },

  empty:          { alignItems: 'center', paddingVertical: 80 },
  emptyTitle:     { color: '#444', fontSize: 16, marginTop: 16 },
  emptySub:       { color: '#2a2a2a', fontSize: 13, marginTop: 6 },
  errorBox:       { marginTop: 16, backgroundColor: '#2f1416', borderRadius: 10, padding: 10, maxWidth: 320 },
  errorText:      { color: '#ffb4b8', fontSize: 12, textAlign: 'center' },
  loadingRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 8 },
  loadingText:    { color: '#8f8fff', fontSize: 13 },

  inputRow:       { flexDirection: 'row', alignItems: 'flex-end', gap: 8,
                    paddingHorizontal: 10, paddingVertical: 8,
                    backgroundColor: '#0f0f0f', borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  input:          { flex: 1, backgroundColor: '#161616', borderRadius: 18,
                    paddingHorizontal: 14, paddingVertical: 9, color: '#fff',
                    fontSize: 16, maxHeight: 120 },
  sendBtn:        { backgroundColor: '#7c7cff', width: 38, height: 38,
                    borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
  sendBtnOff:     { backgroundColor: '#161616' },
});

export default HomeScreen;
