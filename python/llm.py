from __future__ import annotations

from groq import Groq

SYSTEM_PROMPT = """
You are WingMan, a real-time interview assistant. Your job is to help the candidate answer interview questions clearly, confidently, and concisely.

Rules:
- Give direct, structured answers.
- Keep answers under 150 words unless the question is notably complex.
- Tailor answers to the candidate's resume and extra context.
- Match the interview language when practical, while preserving technical terms and code in their original spelling.
- For coding questions, provide clean, commented code with a short explanation.
- Never mention that you are an AI assistant.

Interview Language:
{language}

Candidate Resume:
{resume_text}

Extra Context:
{extra_context}
"""

QUESTION_CHECK_PROMPT = """
You classify transcript snippets from an interview.
The text may be a raw transcript or an English translation of the spoken audio.
Answer with only YES or NO.
Return YES only if the text is clearly an interview question or interview prompt directed at the candidate.
"""


class LLMClient:
    def __init__(self, api_key: str):
        self.client = Groq(api_key=api_key)
        self.default_model = "llama-3.3-70b-versatile"
        self.classifier_model = "meta-llama/llama-4-scout-17b-16e-instruct"

    def is_question(self, transcript: str) -> bool:
        if not transcript.strip():
            return False

        response = self.client.chat.completions.create(
            model=self.classifier_model,
            messages=[
                {"role": "system", "content": QUESTION_CHECK_PROMPT},
                {"role": "user", "content": transcript},
            ],
            temperature=0,
            max_completion_tokens=8,
        )
        content = response.choices[0].message.content or ""
        return content.strip().upper().startswith("YES")

    def stream_answer(self, question: str, session: dict):
        system = SYSTEM_PROMPT.format(
            language=session.get("language", "en"),
            resume_text=session.get("resume_text", "Not provided"),
            extra_context=session.get("extra_context", "None"),
        )
        model = session.get("model", self.default_model)
        stream = self.client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": question},
            ],
            temperature=0.35,
            max_completion_tokens=500,
            stream=True,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
