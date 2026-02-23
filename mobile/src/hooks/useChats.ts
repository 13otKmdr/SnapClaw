/**
 * useChats — manages the list of chat sessions.
 * Communicates with the backend via the shared WebSocket service.
 */
import { useState, useEffect, useCallback } from 'react';
import ws from '../services/websocket';

export interface Chat {
  id: string;
  name: string;
  agent_context_id: string | null;
  has_summary: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  created_at: string;
}

interface UseChatsReturn {
  chats: Chat[];
  activeChat: Chat | null;
  loading: boolean;
  selectChat: (chatId: string) => void;
  createChat: (name?: string) => void;
  refreshChats: () => void;
  onChatSelected: ((chat: Chat, messages: StoredMessage[]) => void) | null;
  setChatSelectedCallback: (cb: (chat: Chat, messages: StoredMessage[]) => void) => void;
}

export function useChats(): UseChatsReturn {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [loading, setLoading] = useState(false);
  const [onChatSelected, setOnChatSelected] =
    useState<((chat: Chat, messages: StoredMessage[]) => void) | null>(null);

  // ── WebSocket event listeners ─────────────────────────────────────

  useEffect(() => {
    const handleChatList = (data: unknown) => {
      const d = data as { chats: Chat[] };
      setChats(d.chats ?? []);
      setLoading(false);
    };

    const handleChatCreated = (data: unknown) => {
      const d = data as { chat: Chat };
      setActiveChat(d.chat);
      setChats((prev) => [d.chat, ...prev.filter((c) => c.id !== d.chat.id)]);
    };

    const handleChatSelected = (data: unknown) => {
      const d = data as { chat: Chat; messages: StoredMessage[] };
      setActiveChat(d.chat);
      onChatSelected?.(d.chat, d.messages);
    };

    const handleAuthOk = () => {
      // Fetch chat list once authenticated
      ws.listChats();
    };

    ws.on('chat_list', handleChatList);
    ws.on('chat_created', handleChatCreated);
    ws.on('chat_selected', handleChatSelected);
    ws.on('auth_ok', handleAuthOk);

    return () => {
      ws.off('chat_list', handleChatList);
      ws.off('chat_created', handleChatCreated);
      ws.off('chat_selected', handleChatSelected);
      ws.off('auth_ok', handleAuthOk);
    };
  }, [onChatSelected]);

  // ── Actions ───────────────────────────────────────────────────────

  const selectChat = useCallback((chatId: string) => {
    ws.selectChat(chatId);
  }, []);

  const createChat = useCallback((name = 'New Chat') => {
    ws.newChat(name);
  }, []);

  const refreshChats = useCallback(() => {
    setLoading(true);
    ws.listChats();
  }, []);

  const setChatSelectedCallback = useCallback(
    (cb: (chat: Chat, messages: StoredMessage[]) => void) => {
      setOnChatSelected(() => cb);
    },
    [],
  );

  return {
    chats,
    activeChat,
    loading,
    selectChat,
    createChat,
    refreshChats,
    onChatSelected,
    setChatSelectedCallback,
  };
}
