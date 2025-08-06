import { useState } from 'react';
import axios from 'axios';

export default function TestBroadcast() {
  const [text, setText] = useState('');
  const [lang, setLang] = useState('en');

  const handleBroadcast = async () => {
    if (!text) return;
    try {
      await axios.post(`${process.env.NEXT_PUBLIC_API_BASE_URL}/api/broadcast`, {
        text,
        lang,
      });
      console.log('Broadcast sent:', text);
    } catch (error) {
      console.error('Broadcast failed:', error);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-gray-100 p-4">
      <h1 className="text-2xl font-bold mb-4">Test Broadcast</h1>
      <textarea
        className="w-full max-w-xl border border-gray-300 rounded-md p-2 mb-4"
        rows={4}
        placeholder="Type translation text..."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        onClick={handleBroadcast}
        className="bg-blue-500 text-white px-4 py-2 rounded-md"
      >
        Send Broadcast
      </button>
    </div>
  );
}
