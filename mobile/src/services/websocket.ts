const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000';
const RAW_WS_BASE_URL = process.env.EXPO_PUBLIC_WS_URL || API_URL;
const REALTIME_ENABLED = ['1', 'true', 'yes'].includes(
  (process.env.EXPO_PUBLIC_REALTIME_ENABLED || '').toLowerCase(),
);

const normalizeBaseUrl = (value: string): string => value.replace(/\/$/, '');

const buildWebSocketBaseUrl = (): string => {
  const base = normalizeBaseUrl(RAW_WS_BASE_URL);
  if (base.startsWith('wss://') || base.startsWith('ws://')) {
    return base;
  }
  if (base.startsWith('https://')) {
    return `wss://${base.slice('https://'.length)}`;
  }
  if (base.startsWith('http://')) {
    return `ws://${base.slice('http://'.length)}`;
  }
  return `ws://${base}`;
};

const WS_BASE_URL = buildWebSocketBaseUrl();

type Listener = (data: any) => void;

type LocalChat = {
  id: string;
  name: string;
  agent_context_id: string | null;
  has_summary: boolean;
  created_at: string;
  updated_at: string;
};

class WebSocketService {
  private socket: WebSocket | null = null;
  private listeners: Map<string, Set<Listener>> = new Map();
  private assistantMessageIds: Set<string> = new Set();
  private currentConversationId: string | null = null;
  private localChats: LocalChat[] = [];

  connect(conversationId: string): Promise<void> {
    if (!REALTIME_ENABLED) {
      this.disconnect();
      return Promise.reject(new Error('Realtime disabled'));
    }

    return new Promise((resolve, reject) => {
      this.disconnect();

      this.currentConversationId = conversationId;
      this.assistantMessageIds.clear();

      const url = `${WS_BASE_URL}/ws/realtime/${encodeURIComponent(conversationId)}`;
      const socket = new WebSocket(url);
      this.socket = socket;

      const onOpen = () => {
        this.emit('connected', { conversationId });
        resolve();
      };

      const onError = (event: Event) => {
        this.emit('error', {
          type: 'connection_error',
          message: 'WebSocket connection failed',
          raw: event,
        });
        reject(new Error('WebSocket connection failed'));
      };

      const onClose = () => {
        this.emit('disconnected', { conversationId });
      };

      const onMessage = (event: MessageEvent) => {
        const data = this.parseMessage(event.data);
        if (!data) {
          return;
        }

        this.emit('event', data);
        this.handleRealtimeEvent(data);
      };

      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('close', onClose);
      socket.addEventListener('message', onMessage);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.currentConversationId = null;
  }

  sendVoice(text: string) {
    this.sendUserText(text);
  }

  sendUserText(text: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const userMessage = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    };

    this.socket.send(JSON.stringify(userMessage));
    this.socket.send(JSON.stringify({ type: 'response.create' }));
  }

  confirmAction(confirmed: boolean) {
    this.sendUserText(confirmed ? 'Yes, continue with that.' : 'No, cancel that task.');
  }

  on(event: string, callback: Listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(callback);
  }

  off(event: string, callback: Listener) {
    this.listeners.get(event)?.delete(callback);
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  isRealtimeEnabled(): boolean {
    return REALTIME_ENABLED;
  }

  listChats() {
    this.ensureLocalChatExists();
    this.emit('chat_list', { chats: this.localChats });
  }

  newChat(name: string) {
    const now = new Date().toISOString();
    const chat: LocalChat = {
      id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      name: (name || 'New Chat').trim() || 'New Chat',
      agent_context_id: null,
      has_summary: false,
      created_at: now,
      updated_at: now,
    };
    this.localChats = [chat, ...this.localChats];
    this.emit('chat_created', { chat });
    this.emit('chat_list', { chats: this.localChats });
  }

  selectChat(chatId: string) {
    this.ensureLocalChatExists();
    const chat = this.localChats.find((entry) => entry.id === chatId);
    if (!chat) {
      return;
    }
    this.emit('chat_selected', { chat, messages: [] });
  }

  private emit(event: string, data: any) {
    this.listeners.get(event)?.forEach((callback) => callback(data));
  }

  private parseMessage(raw: any): any | null {
    if (typeof raw !== 'string') {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private handleRealtimeEvent(payload: any) {
    if (payload.type === 'proxy.error') {
      this.emit('error', payload);
      this.disconnect();
      return;
    }

    if (payload.type === 'agent_task.update') {
      this.emit('task_update', payload.payload);
      return;
    }

    if (payload.type === 'response.done') {
      this.emit('response_done', payload);
      return;
    }

    const assistantText = this.extractAssistantMessageText(payload);
    if (!assistantText) {
      return;
    }

    this.emit('response', {
      text: assistantText,
      raw: payload,
    });
  }

  private ensureLocalChatExists() {
    if (this.localChats.length > 0) {
      return;
    }
    const now = new Date().toISOString();
    this.localChats = [
      {
        id: 'chat_default',
        name: 'Current Session',
        agent_context_id: null,
        has_summary: false,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  private extractAssistantMessageText(payload: any): string | null {
    const eventType = payload?.type;

    if (eventType === 'response.output_item.done') {
      return this.extractTextFromItem(payload.item);
    }

    if (eventType === 'conversation.item.created') {
      return this.extractTextFromItem(payload.item);
    }

    return null;
  }

  private extractTextFromItem(item: any): string | null {
    if (!item || item.type !== 'message' || item.role !== 'assistant') {
      return null;
    }

    const itemId = item.id as string | undefined;
    if (itemId && this.assistantMessageIds.has(itemId)) {
      return null;
    }
    if (itemId) {
      this.assistantMessageIds.add(itemId);
    }

    const parts = Array.isArray(item.content) ? item.content : [];
    const texts: string[] = [];

    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        texts.push(part.text.trim());
        continue;
      }
      if (typeof part?.transcript === 'string' && part.transcript.trim()) {
        texts.push(part.transcript.trim());
      }
    }

    if (!texts.length) {
      return null;
    }

    return texts.join('\n').trim();
  }
}

export default new WebSocketService();
