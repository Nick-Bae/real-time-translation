# backend/app/google_stt_v2.py
from typing import Iterable, Iterator, Dict, Any, Optional
from google.cloud import speech_v2 as speech

def streaming_recognize_v2(
    audio_chunks: Iterable[bytes],
    language_code: str = "ko-KR",
    enable_interim_results: bool = True,
    enable_voice_activity_events: bool = True,
    model: Optional[str] = None,          # e.g., "latest_long"
) -> Iterator[Dict[str, Any]]:
    """
    Yields dict events:
      - {"type":"interim", "text": "..."}
      - {"type":"final",   "text": "..."}
      - {"type":"__speech_activity_end__", "offset": <seconds> }
    """
    client = speech.SpeechClient()

    if not model:
        # "latest_long" for long form; "latest_short" behaves more single-utterance-like
        model = "latest_short"

    # Configure request
    config = speech.RecognitionConfig(
        auto_decoding_config=speech.AutoDetectDecodingConfig(),
        language_codes=[language_code],
        features=speech.RecognitionFeatures(
            enable_automatic_punctuation=True,
            enable_voice_activity_events=enable_voice_activity_events,
        ),
        model=model,
    )
    streaming_config = speech.StreamingRecognitionConfig(
        config=config,
        streaming_features=speech.StreamingRecognitionFeatures(
            interim_results=enable_interim_results
        ),
    )

    def reqs() -> Iterator[speech.StreamingRecognizeRequest]:
        # First request: config only
        yield speech.StreamingRecognizeRequest(streaming_config=streaming_config)
        # Then audio
        for chunk in audio_chunks:
            yield speech.StreamingRecognizeRequest(audio_chunk=speech.RecognitionAudio(data=chunk))

    # Start streaming
    responses = client.streaming_recognize(requests=reqs())
    for resp in responses:
        # Voice activity events (end of speech)
        if resp.speech_event_type == speech.StreamingRecognizeResponse.SpeechEventType.SPEECH_ACTIVITY_END:
            # seconds may be None; treat as hint only
            yield {"type": "__speech_activity_end__", "offset": getattr(resp, "speech_event_offset", None)}

        # Results (interim/final)
        for result in resp.results:
            if not result.alternatives:
                continue
            text = result.alternatives[0].transcript or ""
            if not text:
                continue
            if result.is_final:
                yield {"type": "final", "text": text}
            else:
                yield {"type": "interim", "text": text}
