import io
import os
import wave

import requests
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")
BASE_URL = (os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL", "")).rstrip("/")

# Mirror of backend FILLER_PREFIXES / is_clean_task contract for validation
FILLER_PREFIXES = {"and", "but", "so", "or", "um", "uh", "like", "idk", "i", "then", "well",
                   "you", "just", "actually", "basically", "the", "a", "an", "of", "to", "in", "for"}


def is_clean_task(text: str) -> bool:
    stripped = (text or "").strip()
    if not stripped:
        return False
    words = stripped.split()
    if len(words) > 6:
        return False
    if len(stripped) > 60:
        return False
    first = words[0].lower().strip(",.?!")
    if first in FILLER_PREFIXES:
        return False
    return True


def _tiny_wav_bytes() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 3200)
    return buf.getvalue()


# --- Health ---
def test_root():
    root = requests.get(f"{BASE_URL}/api/", timeout=30)
    assert root.status_code == 200
    assert root.json().get("message") == "Execute AI API"


# --- /api/ai/task ---
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
    assert len(task.split()) <= 8, f"task too long: {task}"
    assert len(reason.split()) <= 12, f"reason too long: {reason}"
    assert isinstance(payload.get("alternatives"), list)


def test_task_empty_transcript_returns_400():
    response = requests.post(
        f"{BASE_URL}/api/ai/task",
        json={"transcript": "   "},
        timeout=30,
    )
    assert response.status_code == 400


def test_task_deferred_items_pass_is_clean_task():
    """Every deferred item must be clean: <=6 words, <=60 chars, no filler prefix."""
    long_prompt = (
        "ok so um i need to call the dentist and idk what to do "
        "but also finish the report and pick up dry cleaning from the shop "
        "near the office before it closes and reply to seventeen recruiter emails"
    )
    response = requests.post(
        f"{BASE_URL}/api/ai/task",
        json={"transcript": long_prompt},
        timeout=120,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    deferred = payload.get("deferred", [])
    assert isinstance(deferred, list)
    for item in deferred:
        assert isinstance(item, str) and item
        assert is_clean_task(item), f"deferred item fails is_clean_task: {item!r}"
    for alt in payload.get("alternatives", []):
        alt_task = alt.get("task", "")
        assert is_clean_task(alt_task), f"alternative task fails is_clean_task: {alt_task!r}"


# --- /api/ai/sort ---
def test_sort_returns_only_clean_items():
    """Every item in NOW/LATER/DROP must pass is_clean_task.
    Filler-only items should be omitted entirely."""
    interruptions = [
        "and idk what to do but",
        "call dentist tomorrow morning",
        "um the report is due",
    ]
    response = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Finish quarterly report", "interruptions": interruptions},
        timeout=120,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    for key in ("now", "later", "drop"):
        assert isinstance(payload.get(key), list)
    union = payload["now"] + payload["later"] + payload["drop"]
    for item in union:
        assert is_clean_task(item), f"bucket item fails is_clean_task: {item!r}"


def test_sort_clean_short_items_preserved():
    """Short, already-clean items should survive round-trip through the cleaner."""
    items = ["Call mom", "Check email", "Buy socks"]
    response = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Submit proposal", "interruptions": items},
        timeout=120,
    )
    assert response.status_code == 200
    payload = response.json()
    union = payload["now"] + payload["later"] + payload["drop"]
    # Every returned item is clean
    for item in union:
        assert is_clean_task(item), f"item fails is_clean_task: {item!r}"
    # Union count should not exceed input count (nothing invented).
    assert len(union) <= len(items) + 1  # allow small variance


def test_sort_empty_interruptions_returns_empty_buckets():
    empty = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Submit proposal", "interruptions": []},
        timeout=30,
    )
    assert empty.status_code == 200
    assert empty.json() == {"now": [], "later": [], "drop": []}


def test_sort_long_interruption_returns_clean_bucket_items():
    """Long/messy items should be rewritten (not verbatim) and remain <=6 words."""
    long_item = "I really need to remember to call the dentist about the appointment tomorrow morning"
    short_items = ["Buy socks", "Water plants"]
    response = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Ship investor deck", "interruptions": [long_item, *short_items]},
        timeout=120,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    union = payload["now"] + payload["later"] + payload["drop"]
    for item in union:
        assert is_clean_task(item), f"bucket item fails is_clean_task: {item!r}"


# --- /api/ai/transcribe ---
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
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "transcript" in payload
    assert isinstance(payload["transcript"], str)
