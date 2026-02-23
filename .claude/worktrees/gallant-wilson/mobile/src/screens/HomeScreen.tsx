import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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
import { VoiceButton, MessageBubble, StreamingMessage, ChatListModal } from '../components';

type RootStackParamList = { Home: undefined; Settings: undefined };
type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

export const HomeScreen: React.FC<{ navigation: Nav }> = ({ navigation }) => {
  const {
    isListening, isProcessing, isSpeaking, isConnected,
    transcript, messages, streamingText,
    startListening, stopListening, sendMessage,
    restoreMessages, clearMessages,
  } = useVoice();

  const { chats, activeChat, selectChat, createChat, refreshChats, setChatSelectedCallback } = useChats();

  const [textInput, setTextInput] = useState('');
  const [chatModalVisible, setChatModalVisible] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // When the user picks a chat, restore its messages
  useEffect(() => {
    setChatSelectedCallback((chat, stored) => {
      restoreMessages(chat, stored);
    });
  }, [setChatSelectedCallback, restoreMessages]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages, streamingText]);

  const handleSend = useCallback(() => {
    const t = textInput.trim();
    if (t) { sendMessage(t); setTextInput(''); }
  }, [textInput, sendMessage]);

  // ── Status ──────────────────────────────────────────────────────────

  const statusLabel = isProcessing ? 'Thinking…'
    : isSpeaking   ? 'Speaking…'
    : isListening  ? 'Listening…'
    : isConnected  ? 'Connected'
    : 'Offline';

  const statusColor = isProcessing ? '#FFA500'
    : isSpeaking   ? '#ff6b6b'
    : isListening  ? '#00e676'
    : isConnected  ? '#7c7cff'
    : '#555';

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { refreshChats(); setChatModalVisible(true); }} style={styles.chatBtn}>
          <Ionicons name="chatbubbles-outline" size={22} color="#7c7cff" />
          <Text style={styles.chatBtnLabel} numberOfLines={1}>
            {activeChat?.name ?? 'Chats'}
          </Text>
          <Ionicons name="chevron-down" size={14} color="#555" />
        </TouchableOpacity>

        <View style={styles.headerRight}>
          <TouchableOpacity onPress={clearMessages} style={styles.iconBtn}>
            <Ionicons name="trash-outline" size={20} color="#555" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={styles.iconBtn}>
            <Ionicons name="settings-outline" size={20} color="#555" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Status strip ── */}
      <View style={styles.statusStrip}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
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
            <Text style={styles.emptyTitle}>Hold to speak or type below</Text>
            <Text style={styles.emptySub}>Agent Zero will respond in real-time</Text>
          </View>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Live streaming text from Agent Zero */}
        {streamingText ? (
          <StreamingMessage text={streamingText} isStreaming={true} />
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
          >
            <Ionicons name="send" size={18} color={textInput.trim() ? '#fff' : '#333'} />
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
  statusLabel:    { fontSize: 12 },

  transcriptBar:  { flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#0d1a10' },
  transcriptText: { color: '#00e676', fontSize: 13, fontStyle: 'italic', flex: 1 },

  messages:       { flex: 1 },
  messagesContent:{ padding: 14, paddingBottom: 20 },

  empty:          { alignItems: 'center', paddingVertical: 80 },
  emptyTitle:     { color: '#444', fontSize: 16, marginTop: 16 },
  emptySub:       { color: '#2a2a2a', fontSize: 13, marginTop: 6 },

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
