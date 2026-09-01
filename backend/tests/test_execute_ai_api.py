import os
import requests

BASE_URL = (os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL", "")).rstrip("/")


def test_root_and_task_shape():
    root = requests.get(f"{BASE_URL}/api/", timeout=30)
    assert root.status_code == 200
    assert root.json().get("message") == "Execute AI API"
    response = requests.post(
        f"{BASE_URL}/api/ai/task",
        json={"transcript": "I must submit the investor proposal tomorrow and buy groceries"},
        timeout=90,
    )
    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload.get("task"), str) and payload["task"]
    assert isinstance(payload.get("minutes"), int)
    assert isinstance(payload.get("deferred"), list)
    assert isinstance(payload.get("reason"), str)


def test_sort_shape_and_empty_case():
    response = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Submit proposal", "interruptions": ["Call mom", "Check email"]},
        timeout=90,
    )
    assert response.status_code == 200
    payload = response.json()
    assert all(isinstance(payload.get(key), list) for key in ("now", "later", "drop"))
    empty = requests.post(
        f"{BASE_URL}/api/ai/sort",
        json={"task": "Submit proposal", "interruptions": []},
        timeout=30,
    )
    assert empty.status_code == 200
    assert empty.json() == {"now": [], "later": [], "drop": []}


def test_transcribe_rejects_non_audio():
    response = requests.post(
        f"{BASE_URL}/api/ai/transcribe",
        files={"audio": ("note.txt", b"not audio", "text/plain")},
        timeout=30,
    )
    assert response.status_code == 415