/**
 * Native WebSocket service — talks to the FastAPI backend.
 *
 * Protocol mirrors backend/main.py:
 *   Client → Server: auth, audio_chunk, audio_end, text_message,
 *                    select_chat, new_chat, list_chats
 *   Server → Client: auth_ok, auth_error, transcript, agent_update,
 *                    agent_done, audio_chunk, audio_end,
 *                    chat_list, chat_created, chat_selected, error
 */

const WS_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://192.168.1.169:8000').replace(/^http/, 'ws');
const APP_SECRET = process.env.EXPO_PUBLIC_APP_SECRET ?? '';

type Handler = (data: unknown) => void;

class VoiceWebSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Handler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  // ── connect / disconnect ──────────────────────────────────────────

  connect(): void {
    this.shouldReconnect = true;
    this._open();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── send helpers ──────────────────────────────────────────────────

  sendAudioChunk(base64Data: string): void {
    this._send({ type: 'audio_chunk', data: base64Data });
  }

  sendAudioEnd(): void {
    this._send({ type: 'audio_end' });
  }

  sendText(text: string): void {
    this._send({ type: 'text_message', text });
  }

  selectChat(chatId: string): void {
    this._send({ type: 'select_chat', chat_id: chatId });
  }

  newChat(name: string): void {
    this._send({ type: 'new_chat', name });
  }

  listChats(): void {
    this._send({ type: 'list_chats' });
  }

  // ── event emitter ─────────────────────────────────────────────────

  on(event: string, handler: Handler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: Handler): void {
    this.listeners.get(event)?.delete(handler);
  }

  // ── internals ─────────────────────────────────────────────────────

  private _open(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    const url = `${WS_URL}/ws`;
    console.log('[WS] Connecting to', url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this._send({ type: 'auth', token: APP_SECRET });
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);
        this._dispatch(msg.type, msg);
      } catch {
        console.warn('[WS] Non-JSON message:', evt.data);
      }
    };

    this.ws.onclose = (evt) => {
      console.log('[WS] Closed', evt.code, evt.reason);
      this._dispatch('disconnected', {});
      if (this.shouldReconnect) {
        console.log('[WS] Reconnecting in 2 s…');
        this.reconnectTimer = setTimeout(() => this._open(), 2000);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error', err);
    };
  }

  private _send(data: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn('[WS] Cannot send — not connected');
    }
  }

  private _dispatch(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((h) => h(data));
    this.listeners.get('message')?.forEach((h) => h(data));
  }
}

export default new VoiceWebSocket();
