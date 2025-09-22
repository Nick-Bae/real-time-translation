import { useState } from 'react';
import { translateKRtoEN, ttsEN } from '../lib/api';

const API = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export default function QuickTest() {
  const [kr, setKr] = useState('여호와께서 스바냐 선지자를 통해 말씀하십니다.');
  const [en, setEn] = useState('');
  const [src, setSrc] = useState<string>();

  return (
    <div style={{ padding: 24 }}>
      <h1>All-Google Baseline Test</h1>
      <textarea rows={4} cols={60} value={kr} onChange={e=>setKr(e.target.value)} />
      <div style={{ marginTop: 8 }}>
        <button onClick={async ()=>{
          const out = await translateKRtoEN(API, kr);
          setEn(out);
          const url = await ttsEN(API, out, 'en-US-Wavenet-D');
          setSrc(url);
        }}>Translate → Speak</button>
      </div>
      <p><b>EN:</b> {en}</p>
      {src && <audio controls src={src} autoPlay />}
    </div>
  );
}
