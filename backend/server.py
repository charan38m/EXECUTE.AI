from fastapi import FastAPI, APIRouter, File, HTTPException, UploadFile
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Any, List
import uuid
from datetime import datetime, timezone
import json
import asyncio

from google import genai
from google.genai import types


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")
gemini_lock = asyncio.Lock()


# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str


class AlternativeTask(BaseModel):
    task: str
    minutes: int
    reason: str


class TaskResponse(BaseModel):
    task: str
    minutes: int
    deferred: List[str]
    reason: str
    alternatives: List[AlternativeTask] = Field(default_factory=list)


class SortRequest(BaseModel):
    task: str
    interruptions: List[str]


class SortResponse(BaseModel):
    now: List[str]
    later: List[str]
    drop: List[str]


_genai_client: genai.Client | None = None


def get_genai_client() -> genai.Client:
    global _genai_client
    if _genai_client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise HTTPException(status_code=503, detail="Gemini is not configured")
        _genai_client = genai.Client(api_key=api_key)
    return _genai_client


GEMINI_CALL_TIMEOUT_SECONDS = 15


async def run_gemini(system_message: str, contents: List[Any]) -> str:
    client = get_genai_client()
    config = types.GenerateContentConfig(
        system_instruction=system_message,
        temperature=0.1,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        http_options=types.HttpOptions(timeout=GEMINI_CALL_TIMEOUT_SECONDS * 1000),
    )
    async with gemini_lock:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(
                        client.models.generate_content,
                        model="gemini-flash-lite-latest",
                        contents=contents,
                        config=config,
                    ),
                    timeout=GEMINI_CALL_TIMEOUT_SECONDS,
                )
                return (response.text or "").strip()
            except Exception as exc:
                last_error = exc
                logger.warning("Gemini attempt %s failed: %s", attempt + 1, exc)
                if attempt < 2:
                    await asyncio.sleep(0.5 * (attempt + 1))
        logger.exception("Gemini request failed after retries")
        raise HTTPException(status_code=503, detail="Gemini is temporarily busy; please try again") from last_error


def parse_json_object(raw: str) -> Any:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.replace("```json", "", 1).replace("```", "", 1).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1:
        raise HTTPException(status_code=502, detail="Gemini returned invalid JSON")
    try:
        return json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Gemini returned invalid JSON") from exc


def limit_words(value: Any, limit: int) -> str:
    return " ".join(str(value).strip().split()[:limit])


FILLER_PREFIXES = {"and", "but", "so", "or", "um", "uh", "like", "idk", "i", "then", "well", "you", "just", "actually", "basically", "the", "a", "an", "of", "to", "in", "for"}


def is_clean_task(text: str) -> bool:
    stripped = text.strip()
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


# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Execute AI API"}


TASK_SYSTEM_MESSAGE = """You will hear a short voice recording of a person's spoken, unstructured list of
everything on their mind. Listen to the audio directly — do not ask for a transcript, there isn't one.
Detect English, Hindi, Telugu, or code-mixed speech automatically.

Return ONLY valid JSON, no markdown, no preamble:
{"task":"<single most important item, in the user's own words exactly as they said it, max 8 words, in the language they spoke>","minutes":<realistic integer>,"deferred":["<other items>"],"reason":"<max 12 words on why this one won>"}

Rules for `deferred`:
- Every item MUST be a CLEAN, REWRITTEN action phrase, max 6 words.
- NEVER copy words verbatim from what was said. NEVER start with filler words like "and", "but", "so", "idk", "um", "the".
- Each item should read like a to-do written by a human (e.g. "Call dentist", "Send invoice to Priya", "Reply to Rahul's email").
- If a chunk of speech is filler, incomplete, or has no clear action, OMIT it entirely.
- Return an empty deferred array rather than filler.

Choose the primary task using this order, stopping at the first rule that picks a clear winner:
1. Whichever item has the soonest hard deadline.
2. Whichever item unblocks the most other items on the list.
3. Whichever item is smallest and fastest to actually finish.

`task` must be the user's own words for that item, not a rewritten or cleaned-up version. Never return more than one task."""


@api_router.post("/ai/task", response_model=TaskResponse)
async def choose_task(audio: UploadFile = File(...)):
    if not audio.content_type or not audio.content_type.startswith("audio/"):
        raise HTTPException(status_code=415, detail="An audio recording is required")
    contents = await audio.read()
    if not contents:
        raise HTTPException(status_code=400, detail="The recording is empty")
    audio_part = types.Part.from_bytes(data=contents, mime_type=audio.content_type)
    try:
        raw = await run_gemini(TASK_SYSTEM_MESSAGE, ["Listen to this voice note and respond with the JSON described.", audio_part])
        payload = parse_json_object(raw)
        task = limit_words(payload["task"], 8)[:100]
        minutes = max(1, min(int(payload["minutes"]), 480))
        deferred_raw = [str(item).strip() for item in payload.get("deferred", []) if str(item).strip()]
        deferred = [item for item in deferred_raw if is_clean_task(item)]
        reason = limit_words(payload.get("reason", ""), 12)[:120]
        if not task:
            raise ValueError("missing task")
        alternatives = [
            AlternativeTask(task=item, minutes=minutes, reason="Next priority")
            for item in deferred
        ]
        return TaskResponse(task=task, minutes=minutes, deferred=deferred, reason=reason, alternatives=alternatives)
    except Exception as exc:
        logger.exception("Task selection failed")
        raise HTTPException(status_code=503, detail="Could not pick a task; please try again") from exc


@api_router.post("/ai/sort", response_model=SortResponse)
async def sort_interruptions(request: SortRequest):
    if not request.interruptions:
        return SortResponse(now=[], later=[], drop=[])
    system_message = """You receive a list of items a person captured while trying to focus.
For each item:
- REWRITE it as a CLEAN action phrase of max 6 words. Never copy raw transcript verbatim. Never start with filler like "and", "but", "so", "idk", "um".
- If the item is filler, incomplete, or has no clear action, OMIT it entirely (do not put it in any bucket).
Then sort each rewritten item into NOW, LATER, or DROP.
- Default to LATER.
- Use DROP only if the item is clearly trivial and time-bound in a way that has already passed.
- Never drop a real task or commitment.

Return ONLY JSON: {"now":[...],"later":[...],"drop":[...]}. Each array holds clean rewritten phrases (<=6 words), not the raw input."""
    prompt = json.dumps({"task": request.task, "interruptions": request.interruptions}, ensure_ascii=False)
    payload = parse_json_object(await run_gemini(system_message, [prompt]))
    try:
        response: dict[str, List[str]] = {"now": [], "later": [], "drop": []}
        for bucket in ("now", "later", "drop"):
            for item in payload.get(bucket, []):
                text = str(item).strip()
                if is_clean_task(text):
                    response[bucket].append(text)
        return SortResponse(**response)
    except (AttributeError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Gemini returned an unusable sort") from exc

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find().to_list(1000)
    return [StatusCheck(**status_check) for status_check in status_checks]

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
