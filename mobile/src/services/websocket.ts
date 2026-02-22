import { io, Socket } from 'socket.io-client';

const WS_URL = 'wss://38.242.132.60:8000';

class WebSocketService {
  private socket: Socket | null = null;
  private listeners: Map<string, Set<Function>> = new Map();

  connect(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(WS_URL, {
        auth: { session_id: sessionId },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });

      this.socket.on('connect', () => {
        console.log('WebSocket connected');
        resolve();
      });

      this.socket.on('connect_error', (error) => {
        console.error('WebSocket connection error:', error);
        reject(error);
      });

      this.socket.on('disconnect', () => {
        console.log('WebSocket disconnected');
        this.emit('disconnected', {});
      });

      this.socket.on('response', (data) => {
        this.emit('response', data);
      });

      this.socket.on('transcript', (data) => {
        this.emit('transcript', data);
      });

      this.socket.on('action_update', (data) => {
        this.emit('action_update', data);
      });
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendVoice(text: string) {
    if (this.socket?.connected) {
      this.socket.emit('voice_input', { text });
    }
  }

  confirmAction(confirmed: boolean) {
    if (this.socket?.connected) {
      this.socket.emit('confirm_action', { confirmed });
    }
  }

  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: Function) {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: any) {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export default new WebSocketService();
