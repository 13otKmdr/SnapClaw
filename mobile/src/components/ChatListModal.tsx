/**
 * ChatListModal — bottom sheet for selecting or creating chats.
 */
import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Chat } from '../hooks/useChats';

interface ChatListModalProps {
  visible: boolean;
  chats: Chat[];
  activeChat: Chat | null;
  onSelect: (chatId: string) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}

export const ChatListModal: React.FC<ChatListModalProps> = ({
  visible,
  chats,
  activeChat,
  onSelect,
  onCreate,
  onClose,
}) => {
  const [newName, setNewName] = useState('');

  const handleCreate = () => {
    const name = newName.trim() || 'New Chat';
    onCreate(name);
    setNewName('');
    onClose();
  };

  const handleSelect = (chatId: string) => {
    onSelect(chatId);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity
          style={styles.backdrop}
          onPress={onClose}
          activeOpacity={1}
          accessibilityRole="button"
          accessibilityLabel="Close chat list"
        />

        <View style={styles.sheet}>
          {/* Handle bar */}
          <View style={styles.handle} />

          <Text style={styles.title}>Chats</Text>

          {/* Chat list */}
          <FlatList
            data={chats}
            keyExtractor={(c) => c.id}
            style={styles.list}
            renderItem={({ item }) => {
              const isActive = item.id === activeChat?.id;
              return (
                <TouchableOpacity
                  style={[styles.chatItem, isActive && styles.chatItemActive]}
                  onPress={() => handleSelect(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Chat: ${item.name}`}
                  accessibilityState={{ selected: isActive }}
                >
                  <Ionicons
                    name="chatbubble-outline"
                    size={18}
                    color={isActive ? '#7c7cff' : '#888'}
                    style={styles.chatIcon}
                  />
                  <View style={styles.chatInfo}>
                    <Text style={[styles.chatName, isActive && styles.chatNameActive]}>
                      {item.name}
                    </Text>
                    {item.has_summary && (
                      <Text style={styles.chatMeta}>Has memory</Text>
                    )}
                  </View>
                  {isActive && (
                    <Ionicons name="checkmark" size={18} color="#7c7cff" />
                  )}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>No chats yet. Create one below.</Text>
            }
          />

          {/* New chat input */}
          <View style={styles.newChatRow}>
            <TextInput
              style={styles.input}
              placeholder="New chat name…"
              placeholderTextColor="#555"
              value={newName}
              onChangeText={setNewName}
              onSubmitEditing={handleCreate}
              returnKeyType="done"
              accessibilityLabel="New chat name"
            />
            <TouchableOpacity
              style={styles.createBtn}
              onPress={handleCreate}
              accessibilityRole="button"
              accessibilityLabel="Create chat"
            >
              <Ionicons name="add" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 32,
    maxHeight: '70%',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#333',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  list: {
    flexGrow: 0,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  chatItemActive: {
    backgroundColor: '#1a1a2e',
  },
  chatIcon: {
    marginRight: 12,
  },
  chatInfo: {
    flex: 1,
  },
  chatName: {
    color: '#ccc',
    fontSize: 16,
  },
  chatNameActive: {
    color: '#fff',
    fontWeight: '600',
  },
  chatMeta: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
  },
  empty: {
    color: '#555',
    textAlign: 'center',
    padding: 24,
    fontSize: 14,
  },
  newChatRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
  createBtn: {
    backgroundColor: '#7c7cff',
    borderRadius: 10,
    width: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default ChatListModal;
