import { Platform } from 'react-native';

type AnyDoc = {
  head: {
    querySelector: (selector: string) => any;
    appendChild: (el: any) => void;
  };
  createElement: (tag: string) => any;
};

const getDocument = (): AnyDoc | null => {
  if (typeof globalThis === 'undefined') return null;
  return (globalThis as any).document || null;
};

const upsertMeta = (name: string, content: string, useProperty = false) => {
  const doc = getDocument();
  if (!doc) return;
  const selector = useProperty ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  let el = doc.head.querySelector(selector);
  if (!el) {
    el = doc.createElement('meta');
    if (useProperty) {
      el.setAttribute('property', name);
    } else {
      el.setAttribute('name', name);
    }
    doc.head.appendChild(el);
  }
  el.setAttribute('content', content);
};

const upsertLink = (rel: string, href: string) => {
  const doc = getDocument();
  if (!doc) return;
  let el = doc.head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = doc.createElement('link');
    el.setAttribute('rel', rel);
    doc.head.appendChild(el);
  }
  el.setAttribute('href', href);
};

export const configureWebAppShell = () => {
  if (Platform.OS !== 'web') return;

  upsertMeta('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no');
  upsertMeta('apple-mobile-web-app-capable', 'yes');
  upsertMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  upsertMeta('apple-mobile-web-app-title', 'SnapClaw');
  upsertMeta('mobile-web-app-capable', 'yes');
  upsertMeta('theme-color', '#0a0a0a');
  upsertMeta('application-name', 'SnapClaw');
  upsertMeta('description', 'Voice-first SnapClaw interface for iPhone and web.');
  upsertMeta('og:title', 'SnapClaw', true);

  upsertLink('manifest', '/manifest.webmanifest');
  upsertLink('apple-touch-icon', '/icons/apple-touch-icon.png');
};

export const registerWebServiceWorker = async () => {
  const webWindow = (typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined) as any;
  if (Platform.OS !== 'web' || !webWindow || !webWindow.navigator?.serviceWorker) {
    return;
  }

  try {
    webWindow.addEventListener('load', () => {
      void webWindow.navigator.serviceWorker.register('/sw.js');
    });
  } catch {
    // Ignore registration errors in unsupported hosting environments.
  }
};
