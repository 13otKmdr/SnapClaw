// API Service with Authentication
import { AuthService } from './authService';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://100.89.247.64:8000';

export interface VoiceResponse {
  text: string;
  intent: string;
  confidence: number;
  action?: {
    type: string;
    status: string;
  [key: string]: any;
  };
  requires_confirmation: boolean;
  entities?: Record<string, any>;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export class ApiService {
  private static async parseError(response: Response, fallback: string): Promise<Error> {
    try {
      const data = await response.json();
      const detail =
        typeof data?.detail === 'string' ? data.detail
        : typeof data?.message === 'string' ? data.message
        : null;
      if (detail) {
        return new Error(detail);
      }
    } catch {
      // ignore parse errors and use fallback
    }
    return new Error(fallback);
  }

  private static async getHeaders(): Promise<HeadersInit> {
    const token = await AuthService.getToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    };
  }

  // Voice processing
  static async processVoice(text: string, sessionId: string): Promise<VoiceResponse> {
    const response = await fetch(`${API_URL}/api/voice/process`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({ text, session_id: sessionId }),
    });

    if (!response.ok) throw await this.parseError(response, 'Voice processing failed');

    return response.json();
  }

  static async transcribeAudio(uri: string): Promise<string> {
    const token = await AuthService.getToken();
    const extension = (uri.split('.').pop() || 'wav').toLowerCase();
    const typeByExt: Record<string, string> = {
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      m4a: 'audio/m4a',
      mp4: 'audio/mp4',
      webm: 'audio/webm',
    };
    const mimeType = typeByExt[extension] || 'application/octet-stream';
    const formData = new FormData();
    formData.append('file', {
      uri,
      name: `voice-input.${extension}`,
      type: mimeType,
    } as any);

    const response = await fetch(`${API_URL}/api/voice/transcribe`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData,
    });

    if (!response.ok) throw await this.parseError(response, 'Audio transcription failed');

    const data = await response.json();
    return typeof data?.text === 'string' ? data.text : '';
  }

  static async processVoiceAudio(uri: string, sessionId: string): Promise<VoiceResponse> {
    const token = await AuthService.getToken();
    const extension = (uri.split('.').pop() || 'wav').toLowerCase();
    const typeByExt: Record<string, string> = {
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      m4a: 'audio/m4a',
      mp4: 'audio/mp4',
      webm: 'audio/webm',
      ogg: 'audio/ogg',
    };
    const mimeType = typeByExt[extension] || 'application/octet-stream';
    const formData = new FormData();
    formData.append('file', {
      uri,
      name: `voice-input.${extension}`,
      type: mimeType,
    } as any);
    formData.append('session_id', sessionId);

    const response = await fetch(`${API_URL}/api/voice/process-audio`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData,
    });

    if (!response.ok) throw await this.parseError(response, 'Voice audio processing failed');

    return response.json();
  }

  static async confirmAction(actionType: string, params: Record<string, any>, confirmed: boolean): Promise<any> {
    const response = await fetch(`${API_URL}/api/voice/confirm?action_type=${actionType}&confirmed=${confirmed}`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify(params),
    });

    if (!response.ok) throw await this.parseError(response, 'Action confirmation failed');

    return response.json();
  }

  // Telegram
  static async getTelegramDialogs(): Promise<TelegramChat[]> {
    const response = await fetch(`${API_URL}/api/telegram/dialogs`, {
      headers: await this.getHeaders(),
    });

    if (!response.ok) throw await this.parseError(response, 'Failed to get Telegram dialogs');

    const data = await response.json();
    return data.dialogs;
  }

  static async sendTelegramMessage(chatId: number, text: string): Promise<any> {
    const response = await fetch(`${API_URL}/api/telegram/send`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!response.ok) throw await this.parseError(response, 'Failed to send Telegram message');

    return response.json();
  }

  // Agent Zero
  static async executeAgentTask(prompt: string, context?: string): Promise<any> {
    const response = await fetch(`${API_URL}/api/agent/execute`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({ command: prompt, params: { context } }),
    });

    if (!response.ok) throw await this.parseError(response, 'Agent Zero execution failed');

    return response.json();
  }

  static async getAgentCapabilities(): Promise<string[]> {
    const response = await fetch(`${API_URL}/api/agent/capabilities`, {
      headers: await this.getHeaders(),
    });

    if (!response.ok) throw await this.parseError(response, 'Failed to get capabilities');

    return response.json();
  }

  // OpenClaw
  static async getOpenClawTools(): Promise<any[]> {
    const response = await fetch(`${API_URL}/api/openclaw/tools`, {
      headers: await this.getHeaders(),
    });

    if (!response.ok) throw await this.parseError(response, 'Failed to get OpenClaw tools');

    return response.json();
  }

  static async executeOpenClawTool(tool: string, target: string, params?: Record<string, any>): Promise<any> {
    const response = await fetch(`${API_URL}/api/openclaw/execute`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({ command: tool, target, params }),
    });

    if (!response.ok) throw await this.parseError(response, 'OpenClaw execution failed');

    return response.json();
  }

  // Health check
  static async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
