import { useEffect, useState } from 'react';

export default function Display() {
  const [translation, setTranslation] = useState<string>('Waiting for translation...');

  useEffect(() => {
    const ws = new WebSocket('ws://10.0.0.4:8000/ws/translate');

    ws.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === 'translation') {
        setTranslation(data.payload);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket connection closed. Reconnecting...');
      setTimeout(() => window.location.reload(), 3000);
    };

    return () => ws.close();
  }, []);

  return (
    <div className="flex items-center justify-center w-screen h-screen bg-transparent">
      <div className="text-white text-6xl font-bold text-center drop-shadow-2xl">
        {translation}
      </div>
    </div>
  );
}
