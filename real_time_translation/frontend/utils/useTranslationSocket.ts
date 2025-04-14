import { useEffect, useRef, useState } from 'react';

export const useTranslationSocket = () => {
  const translationSocketRef = useRef<WebSocket | null>(null);
  const [socketStatus, setSocketStatus] = useState<'connected' | 'disconnected'>('disconnected');

  useEffect(() => {
    const socket = new WebSocket(`${process.env.NEXT_PUBLIC_WS_URL}/ws/translate`);
    translationSocketRef.current = socket;

    socket.onopen = () => {
      console.log('✅ WebSocket connected');
      setSocketStatus('connected');
    };

    socket.onclose = () => {
      console.warn('❌ WebSocket disconnected');
      setSocketStatus('disconnected');
    };

    socket.onerror = (e) => {
      console.error('⚠️ WebSocket error', e);
      setSocketStatus('disconnected');
    };

    return () => socket.close();
  }, []);

  return { translationSocketRef, socketStatus };
};
