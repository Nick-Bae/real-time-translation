import Head from 'next/head'
import TranslationBox from '../components/TranslationBox'

export default function Home() {
  return (
    <>
      <Head>
        <title>Real-Time Translator</title>
      </Head>
      <main className="min-h-screen bg-gray-100 p-6 flex flex-col items-center justify-start">
        <h1 className="text-3xl font-bold text-blue-700 mb-6">
          🎤 Real-Time Sermon Translator
        </h1>
        <TranslationBox />
      </main>
    </>
  )
}
