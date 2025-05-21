// utils/urls.ts
export const baseHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
export const API_URL = `http://${baseHost}:8000`;
export const WS_URL = `ws://${baseHost}:8000`;
