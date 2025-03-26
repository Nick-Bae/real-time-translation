// ✅ TranslationForm.tsx (React Component)
// Path: frontend/components/TranslationForm.tsx

'use client'

import { useState } from 'react'

export default function TranslationForm() {
  const [text, setText] = useState('')
  const [translated, setTranslated] = useState('')
  const [loading, setLoading] = useState(false)

  const handleTranslate = async () => {
    if (!text.trim()) return
    setLoading(true)
    try {
      const response = await fetch('http://localhost:8000/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text,
          source: 'Korean',
          target: 'Chinese',
        }),
      })
      const data = await response.json()
      setTranslated(data.translated || 'Translation failed')
    } catch (error) {
      console.error('Error translating:', error)
      setTranslated('Error during translation')
    }
    setLoading(false)
  }

  return (
    <div className="w-full max-w-2xl mx-auto p-4 bg-white rounded-xl shadow-md">
      <h2 className="text-xl font-semibold text-gray-700 mb-2">Korean to Chinese Translation</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full h-32 p-2 border border-gray-300 rounded-md mb-4"
        placeholder="Enter Korean sermon line here..."
      ></textarea>
      <button
        onClick={handleTranslate}
        disabled={loading}
        className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
      >
        {loading ? 'Translating...' : 'Translate'}
      </button>
      {translated && (
        <div className="mt-6">
          <h3 className="text-lg font-medium text-gray-800 mb-2">Translated Text (Chinese):</h3>
          <div className="p-3 bg-gray-100 rounded-md border border-gray-300 whitespace-pre-wrap">
            {translated}
          </div>
        </div>
      )}
    </div>
  )
}
