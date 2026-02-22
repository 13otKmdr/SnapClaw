import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { Alert, Platform, NativeModules, NativeEventEmitter } from 'react-native';
import * as Speech from 'expo-speech';
import websocket from '../services/websocket';
import { voiceApi, VoiceResponse } from '../services/api';

const { SpeechRecognition } = NativeModules;

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
  actionTaken?: boolean;
  actionResult?: string;
}

interface VoiceState {
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
  isConnected: boolean;
  transcript: string;
  messages: Message[];
  sessionId: string;
  requiresConfirmation: boolean;
  confirmationPrompt: string | null;
}

interface VoiceContextType extends VoiceState {
  startListening: () => Promise<void>;
  stopListening: () => void;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  sendMessage: (text: string) => Promise<void>;
  confirmAction: (confirmed: boolean) => Promise<void>;
  clearHistory: () => void;
}

const VoiceContext = createContext<VoiceContextType | null>(null);

export const useVoice = () => {
  const context = useContext(VoiceContext);
  if (!context) throw new Error('useVoice must be used within VoiceProvider');
  return context;
};

const generateSessionId = () => `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const VoiceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<VoiceState>({
    isListening: false,
    isProcessing: false,
    isSpeaking: false,
    isConnected: false,
    transcript: '',
    messages: [],
    sessionId: generateSessionId(),
    requiresConfirmation: false,
    confirmationPrompt: null,
  });

  const speechRecognitionRef = useRef<any>(null);
  const eventEmitterRef = useRef<NativeEventEmitter | null>(null);

  useEffect(() => {
    // Connect WebSocket
    const connectWs = async () => {
      try {
        await websocket.connect(state.sessionId);
        setState(prev => ({ ...prev, isConnected: true }));
      } catch (error) {
        console.log('WebSocket connection failed, using REST API');
        setState(prev => ({ ...prev, isConnected: false }));
      }
    };

    connectWs();

    // Setup WebSocket listeners
    websocket.on('response', (data: VoiceResponse) => {
      handleResponse(data);
    });

    websocket.on('transcript', (data: { text: string }) => {
      setState(prev => ({ ...prev, transcript: data.text }));
    });

    return () => {
      websocket.disconnect();
    };
  }, []);

  const handleResponse = useCallback((response: VoiceResponse) => {
    setState(prev => ({
      ...prev,
      isProcessing: false,
      messages: [...prev.messages, {
        id: Date.now().toString(),
        type: 'assistant',
        text: response.response,
        timestamp: new Date(),
        actionTaken: response.action_taken,
        actionResult: response.action_result,
      }],
      requiresConfirmation: response.requires_confirmation || false,
      confirmationPrompt: response.confirmation_prompt || null,
    }));

    // Speak the response
    if (response.response) {
      speak(response.response);
    }
  }, []);

  const startListening = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isListening: true, transcript: '' }));

      // For iOS, use native speech recognition
      if (Platform.OS === 'ios' && SpeechRecognition) {
        eventEmitterRef.current = new NativeEventEmitter(SpeechRecognition);
        
        eventEmitterRef.current.addListener('onSpeechResults', (event: any) => {
          const text = event.value?.[0] || '';
          setState(prev => ({ ...prev, transcript: text }));
          sendMessage(text);
        });

        eventEmitterRef.current.addListener('onSpeechError', (event: any) => {
          console.error('Speech error:', event);
          stopListening();
        });

        SpeechRecognition.startRecognizing('en-US');
      } else {
        // Fallback: simulate voice input for demo
        Alert.alert(
          'Voice Input',
          'Enter your message:',
          [
            { text: 'Cancel', onPress: () => setState(prev => ({ ...prev, isListening: false })), style: 'cancel' },
            { text: 'Send', onPress: (text) => {
              if (text) {
                setState(prev => ({ ...prev, transcript: text }));
                sendMessage(text);
              }
            }}
          ],
          { type: 'plain-text' }
        );
      }
    } catch (error) {
      console.error('Failed to start listening:', error);
      setState(prev => ({ ...prev, isListening: false }));
    }
  }, []);

  const stopListening = useCallback(() => {
    if (Platform.OS === 'ios' && SpeechRecognition) {
      SpeechRecognition.stopRecognizing();
      eventEmitterRef.current?.removeAllListeners('onSpeechResults');
      eventEmitterRef.current?.removeAllListeners('onSpeechError');
    }
    setState(prev => ({ ...prev, isListening: false }));
  }, []);

  const speak = useCallback(async (text: string) => {
    setState(prev => ({ ...prev, isSpeaking: true }));
    
    Speech.speak(text, {
      language: 'en-US',
      rate: 1.0,
      pitch: 1.0,
      onDone: () => setState(prev => ({ ...prev, isSpeaking: false })),
      onError: () => setState(prev => ({ ...prev, isSpeaking: false })),
      onStop: () => setState(prev => ({ ...prev, isSpeaking: false })),
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    Speech.stop();
    setState(prev => ({ ...prev, isSpeaking: false }));
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;

    setState(prev => ({
      ...prev,
      isProcessing: true,
      messages: [...prev.messages, {
        id: Date.now().toString(),
        type: 'user',
        text: text,
        timestamp: new Date(),
      }],
      transcript: '',
      isListening: false,
    }));

    try {
      if (websocket.isConnected()) {
        websocket.sendVoice(text);
      } else {
        const response = await voiceApi.processText(text, state.sessionId);
        handleResponse(response);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      setState(prev => ({
        ...prev,
        isProcessing: false,
        messages: [...prev.messages, {
          id: Date.now().toString(),
          type: 'system',
          text: 'Error: Could not connect to server. Please check your connection.',
          timestamp: new Date(),
        }],
      }));
    }
  }, [state.sessionId, handleResponse]);

  const confirmAction = useCallback(async (confirmed: boolean) => {
    setState(prev => ({
      ...prev,
      requiresConfirmation: false,
      confirmationPrompt: null,
      isProcessing: true,
    }));

    try {
      if (websocket.isConnected()) {
        websocket.confirmAction(confirmed);
      } else {
        const response = await voiceApi.confirmAction(state.sessionId, confirmed);
        handleResponse(response);
      }
    } catch (error) {
      console.error('Failed to confirm action:', error);
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  }, [state.sessionId, handleResponse]);

  const clearHistory = useCallback(() => {
    setState(prev => ({
      ...prev,
      messages: [],
      sessionId: generateSessionId(),
    }));
  }, []);

  return (
    <VoiceContext.Provider value={{
      ...state,
      startListening,
      stopListening,
      speak,
      stopSpeaking,
      sendMessage,
      confirmAction,
      clearHistory,
    }}>
      {children}
    </VoiceContext.Provider>
  );
};
