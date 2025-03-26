// @ts-ignore
import Head from 'next/head'
import TranslationForm from '../components/TranslationForm'

export default function Home() {
  return (
    <>
      <Head>
        <title>Real-Time Sermon Translator</title>
      </Head>
      <main className="min-h-screen bg-gray-100 p-6 flex flex-col items-center justify-start">
        <h1 className="text-3xl font-bold text-blue-700 mb-6">
          🎤 Real-Time Sermon Translator
        </h1>
        <TranslationForm />
      </main>
    </>
  )
}