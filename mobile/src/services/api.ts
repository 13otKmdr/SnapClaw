import axios from 'axios';

const API_BASE_URL = 'https://38.242.132.60:8000';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  'Authorization': 'Bearer YOUR_API_KEY',
  },
});

export interface VoiceRequest {
  text: string;
  session_id?: string;
}

export interface VoiceResponse {
  mode: 'CHAT' | 'COMMAND' | 'AMBIGUOUS';
  confidence: number;
  intent?: string;
  response: string;
  action_taken?: boolean;
  action_result?: string;
  requires_confirmation?: boolean;
  confirmation_prompt?: string;
}

export interface ActionPlanResponse {
  mode: string;
  confidence: number;
  intent: string;
  requires_confirmation: boolean;
  confirmation_prompt?: string;
  user_feedback: {
    spoken_ack: string;
    spoken_result: string;
    brief_text_log: string;
  };
}

export const voiceApi = {
  processText: async (text: string, sessionId?: string): Promise<VoiceResponse> => {
    const response = await api.post<VoiceResponse>('/api/voice/process', {
      text,
      session_id: sessionId,
    });
    return response.data;
  },

  confirmAction: async (sessionId: string, confirmed: boolean): Promise<VoiceResponse> => {
    const response = await api.post<VoiceResponse>('/api/voice/confirm', {
      session_id: sessionId,
      confirmed,
    });
    return response.data;
  },

  getHistory: async (sessionId: string) => {
    const response = await api.get(`/api/voice/history/${sessionId}`);
    return response.data;
  },

  healthCheck: async () => {
    const response = await api.get('/health');
    return response.data;
  },
};

export default api;
