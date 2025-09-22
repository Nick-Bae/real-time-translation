export async function translateKRtoEN(apiBase: string, text_kr: string) {
  const r = await fetch(`${apiBase}/api/translate`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text_kr }),
  });
  const j = await r.json(); return j.en as string;
}

export async function ttsEN(apiBase: string, text: string, voice = 'en-US-Wavenet-D') {
  const r = await fetch(`${apiBase}/api/tts`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text, voice }),
  });
  const blob = await r.blob();
  return URL.createObjectURL(blob); // use in <audio src=...>
}
