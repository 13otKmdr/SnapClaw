// API Service with Authentication
import { Platform } from 'react-native';
import { AuthService } from './authService';
import { getApiBaseUrl } from './baseUrl';
import { ErrorHandler, NetworkError, AuthenticationError, ServerError } from './errorHandler';

const API_URL = getApiBaseUrl();

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
      const errorResponse = ErrorHandler.parseHttpError(response.status, data);
      if (response.status === 401 || response.status === 403) {
        return new AuthenticationError(errorResponse.userMessage);
      }
      if (response.status >= 500) {
        return new ServerError(errorResponse.userMessage, response.status);
      }
      return new Error(errorResponse.userMessage);
    } catch {
      const errorResponse = ErrorHandler.parseHttpError(response.status, {});
      return new Error(errorResponse.userMessage || fallback);
    }
  }

  private static async handleNetworkError(error: any): Promise<Error> {
    if (error instanceof TypeError) {
      const errorResponse = ErrorHandler.parseNetworkError(error);
      return new NetworkError(errorResponse.userMessage, errorResponse.errorCode);
    }
    return error;
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
    try {
      const response = await fetch(`${API_URL}/api/voice/process`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify({ text, session_id: sessionId }),
      });

      if (!response.ok) throw await this.parseError(response, 'Voice processing failed');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  static async transcribeAudio(uri: string): Promise<string> {
    try {
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

      if (Platform.OS === 'web') {
        try {
          const blobResponse = await fetch(uri);
          const blob = await blobResponse.blob();
          const blobType = (blob.type || '').toLowerCase();
          const uploadExt =
            blobType.includes('webm') ? 'webm'
            : blobType.includes('mpeg') ? 'mp3'
            : blobType.includes('ogg') ? 'ogg'
            : blobType.includes('wav') ? 'wav'
            : extension;
          (formData as any).append('file', blob, `voice-input.${uploadExt}`);
        } catch {
          formData.append('file', {
            uri,
            name: `voice-input.${extension}`,
            type: mimeType,
          } as any);
        }
      } else {
        formData.append('file', {
          uri,
          name: `voice-input.${extension}`,
          type: mimeType,
        } as any);
      }

      const response = await fetch(`${API_URL}/api/voice/transcribe`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });

      if (!response.ok) throw await this.parseError(response, 'Audio transcription failed');

      const data = await response.json();
      return typeof data?.text === 'string' ? data.text : '';
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  static async processVoiceAudio(uri: string, sessionId: string): Promise<VoiceResponse> {
    try {
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

      if (Platform.OS === 'web') {
        try {
          const blobResponse = await fetch(uri);
          const blob = await blobResponse.blob();
          const blobType = (blob.type || '').toLowerCase();
          const uploadExt =
            blobType.includes('webm') ? 'webm'
            : blobType.includes('mpeg') ? 'mp3'
            : blobType.includes('ogg') ? 'ogg'
            : blobType.includes('wav') ? 'wav'
            : extension;
          (formData as any).append('file', blob, `voice-input.${uploadExt}`);
        } catch {
          formData.append('file', {
            uri,
            name: `voice-input.${extension}`,
            type: mimeType,
          } as any);
        }
      } else {
        formData.append('file', {
          uri,
          name: `voice-input.${extension}`,
          type: mimeType,
        } as any);
      }

      formData.append('session_id', sessionId);

      const response = await fetch(`${API_URL}/api/voice/process-audio`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });

      if (!response.ok) throw await this.parseError(response, 'Voice audio processing failed');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  static async confirmAction(actionType: string, params: Record<string, any>, confirmed: boolean): Promise<any> {
    try {
      const response = await fetch(`${API_URL}/api/voice/confirm?action_type=${actionType}&confirmed=${confirmed}`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify(params),
      });

      if (!response.ok) throw await this.parseError(response, 'Action confirmation failed');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  // Telegram
  static async getTelegramDialogs(): Promise<TelegramChat[]> {
    try {
      const response = await fetch(`${API_URL}/api/telegram/dialogs`, {
        headers: await this.getHeaders(),
      });

      if (!response.ok) throw await this.parseError(response, 'Failed to get Telegram dialogs');

      const data = await response.json();
      return data.dialogs;
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  static async sendTelegramMessage(chatId: number, text: string): Promise<any> {
    try {
      const response = await fetch(`${API_URL}/api/telegram/send`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify({ chat_id: chatId, text }),
      });

      if (!response.ok) throw await this.parseError(response, 'Failed to send Telegram message');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  // Agent Zero
  static async executeAgentTask(prompt: string, context?: string): Promise<any> {
    try {
      const response = await fetch(`${API_URL}/api/agent/execute`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify({ command: prompt, params: { context } }),
      });

      if (!response.ok) throw await this.parseError(response, 'Agent Zero execution failed');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  static async getAgentCapabilities(): Promise<string[]> {
    try {
      const response = await fetch(`${API_URL}/api/agent/capabilities`, {
        headers: await this.getHeaders(),
      });

      if (!response.ok) throw await this.parseError(response, 'Failed to get capabilities');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  // OpenClaw
  static async getOpenClawTools(): Promise<any[]> {
    try {
      const response = await fetch(`${API_URL}/api/openclaw/tools`, {
        headers: await this.getHeaders(),
      });

      if (!response.ok) throw await this.parseError(response, 'Failed to get OpenClaw tools');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  static async executeOpenClawTool(tool: string, target: string, params?: Record<string, any>): Promise<any> {
    try {
      const response = await fetch(`${API_URL}/api/openclaw/execute`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify({ command: tool, target, params }),
      });

      if (!response.ok) throw await this.parseError(response, 'OpenClaw execution failed');

      return response.json();
    } catch (error) {
      throw await this.handleNetworkError(error);
    }
  }

  // Health check
  static async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/health`, { timeout: 5000 } as any);
      return response.ok;
    } catch (error) {
      console.warn('Health check failed:', error);
      return false;
    }
  }

  // Check backend connectivity
  static async checkBackendConnectivity(): Promise<{ isConnected: boolean; message: string }> {
    try {
      const isHealthy = await this.healthCheck();
      if (isHealthy) {
        return { isConnected: true, message: 'Connected to server' };
      }
      const errorResponse = ErrorHandler.parseBackendUnreachableError(API_URL);
      return { isConnected: false, message: errorResponse.userMessage };
    } catch (error) {
      const errorResponse = ErrorHandler.parseBackendUnreachableError(API_URL);
      return { isConnected: false, message: errorResponse.userMessage };
    }
  }
}
