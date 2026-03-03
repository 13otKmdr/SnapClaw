import { Platform } from 'react-native';

const DEFAULT_NATIVE_API_URL = 'http://100.89.247.64:8000';

type WebRuntime = {
  isSecureContext?: boolean;
  location?: {
    origin?: string;
  };
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

const getWebOrigin = (): string | null => {
  if (Platform.OS !== 'web') {
    return null;
  }

  const runtimeWindow = (typeof globalThis !== 'undefined'
    ? (globalThis as any).window
    : undefined) as WebRuntime | undefined;
  const origin = runtimeWindow?.location?.origin;
  if (typeof origin !== 'string' || !origin.trim()) {
    return null;
  }
  return normalizeBaseUrl(origin);
};

const isWebSecureContext = (): boolean => {
  if (Platform.OS !== 'web') {
    return false;
  }

  const globalSecure = (typeof globalThis !== 'undefined'
    ? (globalThis as any).isSecureContext
    : undefined) as boolean | undefined;
  if (typeof globalSecure === 'boolean') {
    return globalSecure;
  }

  const runtimeWindow = (typeof globalThis !== 'undefined'
    ? (globalThis as any).window
    : undefined) as WebRuntime | undefined;
  return !!runtimeWindow?.isSecureContext;
};

const toWebSocketBaseUrl = (value: string): string => {
  const base = normalizeBaseUrl(value);
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

export const getApiBaseUrl = (): string => {
  const envUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (envUrl) {
    return normalizeBaseUrl(envUrl);
  }

  const webOrigin = getWebOrigin();
  if (webOrigin) {
    return webOrigin;
  }

  return DEFAULT_NATIVE_API_URL;
};

export const getWebSocketBaseUrl = (): string => {
  const explicitWsUrl = process.env.EXPO_PUBLIC_WS_URL?.trim();
  if (explicitWsUrl && !(isWebSecureContext() && explicitWsUrl.toLowerCase().startsWith('ws://'))) {
    return toWebSocketBaseUrl(explicitWsUrl);
  }

  return toWebSocketBaseUrl(getApiBaseUrl());
};
