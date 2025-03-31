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

  const synthRef = useRef<any>(null)
  const recognitionRef = useRef<any>(null)
  const ttsQueueRef = useRef<string[]>([]) // ✅ Queue for managing TTS playback
  const isSpeakingRef = useRef<boolean>(false) // ✅ Track if TTS is speaking
  const isCancelledRef = useRef<boolean>(false) // ✅ Prevent excessive cancellation
  const [selectedVoiceName, setSelectedVoiceName] = useState('')

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


  useEffect(() => {
    if (typeof window !== 'undefined') {
      synthRef.current = window.speechSynthesis

      // ✅ Wait for voices to load before proceeding
      setTimeout(() => {
        console.log('✅ Available voices:', synthRef.current.getVoices())
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
        recognition.continuous = true // ✅ Continuous listening enabled
        recognition.interimResults = false

        recognition.onresult = (event: any) => {
          const resultText = event.results[event.results.length - 1][0].transcript
          setText(resultText.trim()) // ✅ Reset to only keep the latest result
          handleTranslate(resultText.trim())
        }

        recognition.onend = () => {
          if (isListening && !pauseListening) {
            recognition.start() // ✅ Restart recognition automatically
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

  // ✅ Enqueue translation for TTS playback
  const enqueueTranslation = (translatedText: string) => {
    if (!translatedText.trim()) {
      console.warn('⚠️ Empty or invalid translation. Skipping...')
      return
    }

    // ✅ Cancel ongoing speech only if necessary
    if (synthRef.current.speaking || synthRef.current.pending) {
      console.warn('🛑 Cancelling previous speech to avoid overlap...')
      synthRef.current.cancel()
    }

    // ✅ Push clean text into the queue
    ttsQueueRef.current.push(translatedText)
    console.log('🎧 Enqueuing clean text for speech:', translatedText)
    if (!isSpeakingRef.current) {
      playNextInQueue() // ✅ Start playing if no active speech
    }
  }

  // Handle text translation
  const handleTranslate = async (inputText: string) => {
    if (!inputText.trim()) return
    if (isSpeakingRef.current) {
      console.warn('⚠️ Speech already in progress. Skipping this translation...')
      return
    }

    setLoading(true)
    try {
      // ✅ Correctly define response before parsing JSON
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

      // ✅ Check if response is OK before parsing
      if (!response.ok) {
        throw new Error(`Failed to fetch translation. Status: ${response.status}`)
      }

      const data = await response.json()

      // ✅ Add debug log to verify API response
      console.log('API Response:', data)

      // ✅ Corrected translation handling
      const translation = data.translated || data.translation || 'Translation failed'

      // ✅ Check and clean translation properly
      let cleanTranslation = translation.replace(/^Translated.*?:\s*/, '').trim()

      // ✅ Log for debugging
      console.log('✅ Cleaned Translation:', cleanTranslation)

      // ✅ Check if translation is still in Korean (likely untranslated)
      if (cleanTranslation.match(/[\u3131-\uD79D]/)) {
        console.warn('⚠️ Translation is still in Korean. Check API or translation logic.')
        cleanTranslation = 'Translation failed. Please check settings.'
      }

      // ✅ Set clean translation and update UI
      setTranslated(cleanTranslation)

      // ✅ Send the correct translated text to TTS
      if (!isMuted && translation !== 'Translation failed') {
        enqueueTranslation(cleanTranslation) // ✅ Send clean translation to TTS
      }
    } catch (error) {
      console.error('❌ Error translating:', error)
      setTranslated('Error during translation')
    }
    setLoading(false)
  }


  // Play the next sentence in the queue
  // ✅ Play the next sentence in the queue
  const playNextInQueue = () => {
    if (
      ttsQueueRef.current.length === 0 ||
      isMuted ||
      isSpeakingRef.current ||
      synthRef.current.speaking ||
      synthRef.current.pending
    ) {
      console.warn('⚠️ Queue empty or speech in progress. Skipping queue play...')
      isSpeakingRef.current = false
      return
    }

    const nextText = ttsQueueRef.current.shift()
    if (nextText && synthRef.current) {
      setTimeout(() => {
        if (synthRef.current.speaking) {
          console.warn('🛑 Cancelling previous speech to avoid overlap...')
          synthRef.current.cancel()
        }

        const utterance = new SpeechSynthesisUtterance(nextText)
        utterance.lang = targetLang
        utterance.volume = volume

        // ✅ Choose a female voice if available
        const voices = synthRef.current.getVoices()
        
          const selectedVoice = voices.find((v) => v.name === selectedVoiceName) || voices[0]

        utterance.voice = selectedVoice

        console.log('🎙️ Using voice:', selectedVoice.name, 'for language:', targetLang)

        isSpeakingRef.current = true

        utterance.onend = () => {
          console.log('✅ Finished speaking:', nextText)
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
      }, 300) // ✅ Small delay to prevent overlap
    }
  }

  // Start or stop microphone
  const handleStartListening = () => {
    if (recognitionRef.current) {
      setText('') // ✅ Clear text before starting new session
      setTranslated('') // ✅ Clear previous translation
      ttsQueueRef.current = [] // ✅ Clear the queue
      synthRef.current.cancel() // ✅ Cancel any ongoing speech
      isSpeakingRef.current = false
      recognitionRef.current.start()
      setIsListening(true)
      console.log('🎙️ Listening started. Previous speech cleared.')
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

  // Clear input, reset and stop TTS
  const handleClear = () => {
    setText('')
    setTranslated('')
    handleStopListening()
    if (synthRef.current) {
      synthRef.current.cancel() // ✅ Stop ongoing TTS immediately
    }
    ttsQueueRef.current = [] // ✅ Clear TTS queue
    isCancelledRef.current = false // ✅ Reset cancellation flag
  }


  return (
    <div className="w-full max-w-2xl mx-auto p-4 bg-white rounded-xl shadow-md">
      <h2 className="text-xl font-semibold text-gray-700 mb-4">🎤 Real-Time Translator</h2>

      {/* Language Selection */}
      <div className="flex gap-4 mb-4">
        <div className="flex flex-col w-1/2">
          <label className="text-gray-600">Source Language</label>
          <select
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value)}
            className="p-2 border rounded"
          >
            {availableLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col w-1/2">
          <label className="text-gray-600">Target Language</label>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            className="p-2 border rounded"
          >
            {availableLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Input and Controls */}
      <div className="flex items-center gap-2 mb-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full h-32 p-2 border border-gray-300 rounded-md"
          placeholder="Type or speak here..."
        ></textarea>
        <button
          onClick={isListening ? handleStopListening : handleStartListening}
          className={`p-3 rounded-full ${isListening ? 'bg-red-600' : 'bg-blue-600'} text-white hover:opacity-80`}
        >
          {isListening ? '🛑 Stop' : '🎤 Start Mic'}
        </button>
      </div>

      {/* Translated Text Output */}
      {translated && (
        <div className="mt-6">
          <h3 className="text-lg font-medium text-gray-800 mb-2">🖥️ Translated Text:</h3>
          <div className="p-3 bg-gray-100 rounded-md border border-gray-300 whitespace-pre-wrap">
            {translated}
          </div>
        </div>
      )}

      {/* Control Buttons */}
      <div className="flex items-center gap-4 mt-4">
        <button
          onClick={handleClear}
          className="px-4 py-2 rounded bg-red-500 text-white hover:bg-red-600 transition"
        >
          Clear Input
        </button>
        <button
          onClick={() => setIsMuted(!isMuted)}
          className={`px-4 py-2 rounded ${isMuted ? 'bg-gray-400' : 'bg-green-600 text-white'} hover:opacity-90 transition`}
        >
          {isMuted ? 'Unmute' : 'Mute'}
        </button>
        <div className="flex items-center">
          <label className="mr-2 text-gray-600">Volume</label>
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
        <button
          onClick={() => {
            if (synthRef.current) {
              synthRef.current.cancel()
              ttsQueueRef.current = [] // ✅ Clear the queue
              console.log('🛑 Speech synthesis reset and queue cleared.')
            }
          }}
          className="px-4 py-2 bg-red-600 text-white rounded"
        >
          🛑 Reset Audio
        </button>
        <div className="flex flex-col w-1/2 mb-4">
          <label className="text-gray-600">Choose Voice</label>
          <select
            value={selectedVoiceName}
            onChange={(e) => setSelectedVoiceName(e.target.value)}
            className="p-2 border rounded"
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
    </div>
  )
}
