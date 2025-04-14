'use client'

import { useState, useEffect, useRef } from 'react'
import { throttle } from '../utils/throttle'
import { useTranslationSocket } from '../utils/useTranslationSocket'

const availableLanguages = [
  { code: 'ko', name: 'Korean' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
]

export default function TranslationBox() {
  // 🔌 WebSocket and status
  const { translationSocketRef} = useTranslationSocket()
  const [text, setText] = useState('')
  const [translated, setTranslated] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sourceLang, setSourceLang] = useState('ko')
  const [targetLang, setTargetLang] = useState('en')
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [pauseListening, setPauseListening] = useState(false)
  const [selectedVoiceName, setSelectedVoiceName] = useState('')
  const [socketStatus, setSocketStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const synthRef = useRef<any>(null)
  const recognitionRef = useRef<any>(null)
  const ttsQueueRef = useRef<string[]>([]) // ✅ Queue for managing TTS playback
  const isSpeakingRef = useRef<boolean>(false) // ✅ Track if TTS is speaking
  const isCancelledRef = useRef<boolean>(false) // ✅ Prevent excessive cancellation
  const sentenceBufferRef = useRef<string>('');

  // ✅ Handle text translation
  const lastTranslatedRef = useRef<string>('') // ⬅️ Define this at the top level of your component

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


  useEffect(() => {
    translationSocketRef.current = new WebSocket(`${process.env.NEXT_PUBLIC_WS_URL}/ws/translate`);

    translationSocketRef.current.onopen = () => {
      console.log('✅ WebSocket connected');
    };

    translationSocketRef.current.onclose = () => {
      console.log('❌ WebSocket closed');
    };

    translationSocketRef.current.onerror = (e) => {
      console.error('❗ WebSocket error', e);
    };

    return () => {
      translationSocketRef.current?.close();
    };
  }, []);

  const throttledSend = useRef(
    throttle((message: string) => {
      const socket = translationSocketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({
          type: "translation",
          payload: message,
          lang: targetLang,
          timestamp: new Date().toISOString(),
        });
        socket.send(payload);
        console.log('📤 Sent structured message:', payload);
      } else {
        console.warn('⚠️ WebSocket not ready. Broadcast skipped.');
      }
    }, 800) // 800ms throttle delay
  ).current;


  const handleTranslate = async (inputText: string) => {
    console.log('🔄 handleTranslate called with:', inputText);

    if (!inputText.trim()) return;

    if (inputText === lastTranslatedRef.current) {
      console.log('🛑 Skipping duplicate sentence:', inputText);
      return;
    }
    lastTranslatedRef.current = inputText;

    setLoading(true);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText,
          source: sourceLang,
          target: targetLang,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch translation. Status: ${response.status}`);
      }

      const data = await response.json();
      const translation = data.translated || 'Translation failed';

      let cleanTranslation = translation.replace(/^Translated.*?:\s*/, '').trim();

      if (cleanTranslation.match(/[\u3131-\uD79D]/)) {
        cleanTranslation = 'Translation failed. Please check settings.';
      }

      setTranslated(cleanTranslation);

      if (!isMuted && cleanTranslation !== 'Translation failed') {
        enqueueTranslation(cleanTranslation);

        // ✅ Structured broadcast via throttled WebSocket
        throttledSend(JSON.stringify({
          type: 'translation',
          payload: cleanTranslation,
          lang: targetLang,
        }));
      }

    } catch (error) {
      console.error('❌ Error translating:', error);
      setTranslated('Error during translation');
    }

    setLoading(false);
  };


  useEffect(() => {
    if (typeof window === 'undefined') return

    // Initialize Speech Synthesis
    synthRef.current = window.speechSynthesis

    const loadVoices = () => {
      const voices = synthRef.current.getVoices()
      if (voices.length > 0) {
        setSelectedVoiceName(voices[0].name)
        console.log('✅ Available Voices:', voices)
      } else {
        // Retry once voices are loaded asynchronously
        window.speechSynthesis.onvoiceschanged = () => {
          const updatedVoices = synthRef.current.getVoices()
          setSelectedVoiceName(updatedVoices[0]?.name || '')
          console.log('✅ Voices loaded later:', updatedVoices)
        }
      }
    }

    loadVoices()

    // Initialize Speech Recognition
    if ('webkitSpeechRecognition' in window) {
      const recognition = new (window as any).webkitSpeechRecognition()
      recognition.lang = sourceLang
      recognition.continuous = true
      recognition.interimResults = true

      let lastTranscript = '' // store previous transcript

      recognition.onresult = (event: any) => {
        let interimTranscript = ''
        console.log('🧠 onresult fired')
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const result = event.results[i]
          interimTranscript += result[0].transcript
        }

        // Remove overlap with previous transcript
        let newContent = interimTranscript
        console.log('📝 New content:', newContent)

        if (lastTranscript && interimTranscript.startsWith(lastTranscript)) {
          newContent = interimTranscript.substring(lastTranscript.length)
        }

        // Update for next comparison
        lastTranscript = interimTranscript

        // Append only the new content
        if (newContent.trim()) {
          sentenceBufferRef.current += newContent
          setText(sentenceBufferRef.current.trim())

          // Smart sentence-ending pattern with polite endings
          const endings = [
            '습니다', '니까', '어요', '에요', '예요', '지요', '죠', '했어', '했지',
            '했네', '했네요', '하자', '한다', '했거든', '하거든', '해요', '해',
            '했니', '입니다', '말합니다', '전합니다', '알립니다', '가르칩니다', '합니다'
          ]

          const sentenceEndRegex = new RegExp(
            `([가-힣\\s“”"‘’']*?(?:${endings.join('|')})(?:[.!?。！？]?)(?=\\s|\\n|$))`,
            'g'
          )


          // Inside your recognition.onresult or wherever needed
          const matches = sentenceBufferRef.current.match(sentenceEndRegex)
          console.log('✅ Detected full sentences:', matches)

          if (matches && matches.length > 0) {
            matches.forEach((sentence) => {
              const cleaned = sentence.trim()
              if (cleaned.length > 3) {
                console.log('📤 Sending for translation:', cleaned)
                handleTranslate(cleaned)
              }
            })

            // Remove processed parts
            sentenceBufferRef.current = sentenceBufferRef.current.replace(sentenceEndRegex, '')
          }
        }
      }

      recognition.onend = () => {
        if (isListening && !pauseListening) {
          recognition.start()
        } else {
          setIsListening(false)
        }
      }

      recognitionRef.current = recognition
    }

  }, [sourceLang, pauseListening])




  // ✅ Enqueue translation for TTS playback
  const enqueueTranslation = (translatedText: string) => {
    if (!translatedText.trim()) {
      console.warn('⚠️ Empty or invalid translation. Skipping...')
      return
    }

    // Prevent duplicate enqueue
    if (ttsQueueRef.current.includes(translatedText)) {
      console.log('⛔ Duplicate translation skipped:', translatedText)
      return
    }

    // If speech in progress, wait for queue
    if (synthRef.current.speaking || isSpeakingRef.current) {
      console.log('🔁 TTS busy. Queueing:', translatedText)
      ttsQueueRef.current.push(translatedText)
      return
    }

    // Add to queue and play
    ttsQueueRef.current.push(translatedText)
    playNextInQueue()
  }


  // ✅ Play the next sentence in the queue
  const playNextInQueue = () => {
    if (
      ttsQueueRef.current.length === 0 ||
      isMuted ||
      isSpeakingRef.current ||
      synthRef.current.speaking
    ) {
      return
    }

    const nextText = ttsQueueRef.current.shift()
    if (!nextText) return

    const utterance = new SpeechSynthesisUtterance(nextText)
    utterance.lang = targetLang
    utterance.volume = volume

    const voices = synthRef.current.getVoices()
    const selectedVoice = voices.find((v) => v.name === selectedVoiceName) || voices[0]
    utterance.voice = selectedVoice

    isSpeakingRef.current = true
    console.log('🗣️ Speaking:', nextText)

    utterance.onend = () => {
      isSpeakingRef.current = false
      if (ttsQueueRef.current.length > 0) {
        setTimeout(() => playNextInQueue(), 300) // Small delay to breathe
      }
    }

    utterance.onerror = (e) => {
      console.error('❌ Speech error:', e)
      isSpeakingRef.current = false
      if (ttsQueueRef.current.length > 0) {
        setTimeout(() => playNextInQueue(), 300)
      }
    }

    synthRef.current.speak(utterance)
  }


  // ✅ Start or stop microphone
  const handleStartListening = () => {
    if (recognitionRef.current) {
      setText('')
      setTranslated('')
      ttsQueueRef.current = []
      synthRef.current.cancel()
      isSpeakingRef.current = false
      recognitionRef.current.start()
      setIsListening(true)
    } else {
      alert('Speech recognition is not supported in this browser.')
    }
  }

  const handleStopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      setIsListening(false)
    }
  }

  // ✅ Clear input, reset and stop TTS
  const handleClear = () => {
    setText('')
    setTranslated('')
    handleStopListening()
    if (synthRef.current) {
      synthRef.current.cancel()
    }
    ttsQueueRef.current = []
  }

  return (
    <div className="w-full max-w-3xl mx-auto p-6 bg-white rounded-xl shadow-md">
      {/* ✅ Header Section */}
      <h2 className="text-2xl font-bold text-gray-700 mb-4 text-center">🎤 Real-Time Translator</h2>
      <div className="flex items-center mb-4 gap-2">
        <span
          className={`inline-block w-3 h-3 rounded-full ${socketStatus === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}
          title={socketStatus === 'connected' ? 'Connected' : 'Disconnected'}
        ></span>
        <span className="text-sm text-gray-600">
          WebSocket: {socketStatus === 'connected' ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* ✅ Status Bar */}
      {loading && (
        <div className="mb-4 text-blue-500 text-sm text-center animate-pulse">
          Translating... Please wait.
        </div>
      )}

      {/* ✅ Language & Voice Controls */}
      <div className="flex gap-4 mb-4">
        <div className="flex flex-col w-1/2">
          <label className="text-gray-600 mb-1">Source Language</label>
          <select
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value)}
            className="p-2 border rounded shadow-sm focus:outline-none"
          >
            {availableLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col w-1/2">
          <label className="text-gray-600 mb-1">Target Language</label>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            className="p-2 border rounded shadow-sm focus:outline-none"
          >
            {availableLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ✅ Text Input and Controls */}
      <div className="flex gap-4 items-center mb-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full h-32 p-3 border rounded-md shadow-sm focus:outline-none"
          placeholder="Type or speak here..."
        />
        <button
          onClick={isListening ? handleStopListening : handleStartListening}
          className={`p-3 rounded-full text-white transition ${isListening ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'
            }`}
        >
          {isListening ? '🛑 Stop' : '🎤 Start'}
        </button>
      </div>

      {/* ✅ Translated Text Output */}
      {translated && (
        <div className="mt-6">
          <h3 className="text-lg font-medium text-gray-800 mb-2">🖥️ Translated Text:</h3>
          <div className="p-3 bg-gray-100 rounded-md border shadow-sm">
            {translated}
          </div>
        </div>
      )}

      {/* ✅ Control Buttons */}
      <div className="flex gap-4 mt-6">
        <button
          onClick={handleClear}
          className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition"
        >
          Clear
        </button>
        <button
          onClick={() => setIsMuted(!isMuted)}
          className={`px-4 py-2 rounded transition ${isMuted ? 'bg-gray-400' : 'bg-green-500 text-white hover:bg-green-600'
            }`}
        >
          {isMuted ? 'Unmute' : 'Mute'}
        </button>
        <div className="flex items-center gap-2">
          <label className="text-gray-600">Volume</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-24"
          />
        </div>
      </div>

      {/* ✅ Voice Selection */}
      <div className="mt-6">
        <label className="text-gray-600 mb-2 block">Choose Voice</label>
        <select
          value={selectedVoiceName}
          onChange={(e) => setSelectedVoiceName(e.target.value)}
          className="p-2 border rounded shadow-sm focus:outline-none w-full"
        >
          {synthRef.current &&
            synthRef.current.getVoices().map((voice) => (
              <option key={voice.name} value={voice.name}>
                {voice.name} ({voice.lang})
              </option>
            ))}
        </select>
      </div>
    </div>
  )
}
