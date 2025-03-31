import os
from openai import OpenAI
from dotenv import load_dotenv

# ✅ Load environment variables from .env
load_dotenv()

# ✅ Set OpenAI API key and model from .env
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
model = os.getenv("OPENAI_MODEL", "gpt-4o")

def translate_text(text: str, source: str, target: str) -> str:
    """
    Translates text from `source` language to `target` language using OpenAI API.
    Args:
        text (str): Text to be translated
        source (str): Source language (e.g., 'ko')
        target (str): Target language (e.g., 'en')
    Returns:
        str: Translated text or error message
    """
    if not text.strip():
        return "No text provided for translation."

    system_prompt = (
        f"You are a theological translator. "
        f"Translate from {source} to {target}, ensuring spiritual and theological accuracy. "
        f"Do not summarize. Provide only the translated text without additional information."
    )

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text}
            ]
        )

        translated = response.choices[0].message.content.strip()
        return translated
    except Exception as e:
        print(f"❌ Error with OpenAI translation: {e}")
        return "Translation failed due to an API error."
