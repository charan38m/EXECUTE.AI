import io
import os
import wave

import requests
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")
BASE_URL = (os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL", "")).rstrip("/")


def _tiny_wav_bytes() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        # 0.2s of near-silence
        w.writeframes(b"\x00\x00" * 3200)
    return buf.getvalue()


def test_root():
    root = requests.get(f"{BASE_URL}/api/", timeout=30)
    assert root.status_code == 200
    assert root.json().get("message") == "Execute AI API"


def test_task_happy_path_and_shape():
    response = requests.post(
        f"{BASE_URL}/api/ai/task",
        json={"transcript": "I must submit the investor proposal tomorrow and buy groceries"},
        timeout=120,
    )
    assert response.status_code == 200
    payload = response.json()
    task = payload.get("task")
    minutes = payload.get("minutes")
    reason = payload.get("reason")
    assert isinstance(task, str) and task
    assert isinstance(minutes, int) and 1 <= minutes <= 480
    assert isinstance(payload.get("deferred"), list)
    assert isinstance(reason, str)
    # task <= 8 words; reason <= 12 words
    assert len(task.split()) <= 8, f"task too long: {task}"
    assert len(reason.split()) <= 12, f"reason too long: {reason}"
    # alternatives should be list
    assert isinstance(payload.get("alternatives"), list)


def test_task_empty_transcript_returns_400():
    response = requests.post(
        f"{BASE_URL}/api/ai/task",
        json={"transcript": "   "},
        timeout=30,
    )
    assert response.status_code == 400


def test_sort_preserves_all_items_union():
    items = ["Call mom", "Check email", "Buy socks"]
    response = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Submit proposal", "interruptions": items},
        timeout=90,
    )
    assert response.status_code == 200
    payload = response.json()
    for key in ("now", "later", "drop"):
        assert isinstance(payload.get(key), list)
    union = payload["now"] + payload["later"] + payload["drop"]
    # Every input appears exactly once (no dedup, no loss)
    assert sorted(union) == sorted(items), f"union mismatch: {union} vs {items}"


def test_sort_empty_interruptions_returns_empty_buckets():
    empty = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Submit proposal", "interruptions": []},
        timeout=30,
    )
    assert empty.status_code == 200
    assert empty.json() == {"now": [], "later": [], "drop": []}


def test_transcribe_rejects_non_audio_content_type_415():
    response = requests.post(
        f"{BASE_URL}/api/ai/transcribe",
        files={"audio": ("note.txt", b"not audio", "text/plain")},
        timeout=30,
    )
    assert response.status_code == 415


def test_transcribe_empty_audio_returns_400():
    response = requests.post(
        f"{BASE_URL}/api/ai/transcribe",
        files={"audio": ("empty.wav", b"", "audio/wav")},
        timeout=30,
    )
    assert response.status_code == 400


def test_transcribe_happy_path_returns_transcript_string():
    response = requests.post(
        f"{BASE_URL}/api/ai/transcribe",
        files={"audio": ("clip.wav", _tiny_wav_bytes(), "audio/wav")},
        timeout=120,
    )
    # Gemini may return an empty/short transcript for silence, but response must be 200 and shape correct.
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "transcript" in payload
    assert isinstance(payload["transcript"], str)
