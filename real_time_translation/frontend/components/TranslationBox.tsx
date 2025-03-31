'use client'

import { useState, useEffect, useRef } from 'react'

const availableLanguages = [
  { code: 'ko', name: 'Korean' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
]

export default function TranslationBox() {
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

  const synthRef = useRef<any>(null)
  const recognitionRef = useRef<any>(null)
  const ttsQueueRef = useRef<string[]>([]) // ✅ Queue for managing TTS playback
  const isSpeakingRef = useRef<boolean>(false) // ✅ Track if TTS is speaking
  const isCancelledRef = useRef<boolean>(false) // ✅ Prevent excessive cancellation

  useEffect(() => {
    if (typeof window !== 'undefined') {
      synthRef.current = window.speechSynthesis

      // ✅ Wait for voices to load properly
      setTimeout(() => {
        const voices = synthRef.current.getVoices()
        if (voices.length > 0) {
          setSelectedVoiceName(voices[0].name) // Default to the first voice
        }
        console.log('✅ Available Voices:', voices)
      }, 1000)
    }
  }, [])

  // Initialize Web Speech API after component mounts
  useEffect(() => {
    if (typeof window !== 'undefined') {
      synthRef.current = window.speechSynthesis

      if ('webkitSpeechRecognition' in window) {
        const recognition = new (window as any).webkitSpeechRecognition()
        recognition.lang = sourceLang
        recognition.continuous = true
        recognition.interimResults = false

        recognition.onresult = (event: any) => {
          const resultText = event.results[event.results.length - 1][0].transcript
          setText(resultText.trim())
          handleTranslate(resultText.trim())
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
    }
  }, [sourceLang, pauseListening])

  // Auto-translate when text changes
  useEffect(() => {
    if (text.trim()) {
      handleTranslate(text)
    }
  }, [text])

  // ✅ Handle text translation
  const handleTranslate = async (inputText: string) => {
    if (!inputText.trim()) return
    setLoading(true)
    try {
      const response = await fetch('http://localhost:8000/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: inputText,
          source: sourceLang,
          target: targetLang,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch translation. Status: ${response.status}`)
      }

      const data = await response.json()
      const translation = data.translated || 'Translation failed'
      let cleanTranslation = translation.replace(/^Translated.*?:\s*/, '').trim()

      if (cleanTranslation.match(/[\u3131-\uD79D]/)) {
        cleanTranslation = 'Translation failed. Please check settings.'
      }

      setTranslated(cleanTranslation)
      if (!isMuted && cleanTranslation !== 'Translation failed') {
        enqueueTranslation(cleanTranslation)
      }
    } catch (error) {
      console.error('❌ Error translating:', error)
      setTranslated('Error during translation')
    }
    setLoading(false)
  }

  // ✅ Enqueue translation for TTS playback
  const enqueueTranslation = (translatedText: string) => {
    if (!translatedText.trim()) {
      console.warn('⚠️ Empty or invalid translation. Skipping...')
      return
    }

    if (synthRef.current.speaking || synthRef.current.pending) {
      synthRef.current.cancel()
    }

    ttsQueueRef.current.push(translatedText)
    if (!isSpeakingRef.current) {
      playNextInQueue()
    }
  }

  // ✅ Play the next sentence in the queue
  const playNextInQueue = () => {
    if (
      ttsQueueRef.current.length === 0 ||
      isMuted ||
      isSpeakingRef.current ||
      synthRef.current.speaking ||
      synthRef.current.pending
    ) {
      return
    }

    const nextText = ttsQueueRef.current.shift()
    if (nextText && synthRef.current) {
      setTimeout(() => {
        if (synthRef.current.speaking) {
          synthRef.current.cancel()
        }

        const utterance = new SpeechSynthesisUtterance(nextText)
        utterance.lang = targetLang
        utterance.volume = volume

        const voices = synthRef.current.getVoices()
        const selectedVoice = voices.find((v) => v.name === selectedVoiceName) || voices[0]

        utterance.voice = selectedVoice
        isSpeakingRef.current = true

        utterance.onend = () => {
          isSpeakingRef.current = false
          if (ttsQueueRef.current.length > 0) {
            playNextInQueue()
          }
        }

        utterance.onerror = (e) => {
          console.error('❌ Speech synthesis error:', e)
          isSpeakingRef.current = false
          if (ttsQueueRef.current.length > 0) {
            playNextInQueue()
          }
        }

        synthRef.current.speak(utterance)
      }, 300)
    }
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
          className={`p-3 rounded-full text-white transition ${
            isListening ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'
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
          className={`px-4 py-2 rounded transition ${
            isMuted ? 'bg-gray-400' : 'bg-green-500 text-white hover:bg-green-600'
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
