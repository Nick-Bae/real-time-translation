// utils/urls.ts
const api = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";
const rawWs = process.env.NEXT_PUBLIC_WS_URL || api.replace("http", "ws");

export const API_URL = api;
export const WS_URL  = rawWs.includes("/ws/")
  ? rawWs
  : `${rawWs.replace(/\/+$/, "")}/ws/translate`;
