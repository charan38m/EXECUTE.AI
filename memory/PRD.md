# Execute AI — Product Record

## Problem statement
Execute AI helps overwhelmed students, founders, and knowledge workers regain focus. The user speaks an unstructured mental list, receives exactly one priority task, works against a focused timer, and captures interruptions without acting on them. The app is Android-first, requires no account, and uses a calm, empty interface to reduce cognitive load.

## Architecture
- Expo SDK 54 React Native client with Expo Router, local AsyncStorage-backed anonymous identity/history, Expo Audio recording, Keep Awake, SVG timer ring, and PNG sharing.
- FastAPI backend on port 8001 with Gemini through `emergentintegrations`, streaming internally and strict JSON parsing for transcription, task selection, and interruption sorting.
- MongoDB remains available for the starter health endpoint; user session history is intentionally local-only.
- PostHog uses direct capture requests only when `EXPO_PUBLIC_POSTHOG_KEY` is populated; host and key are environment-configurable.

## User personas
- Overwhelmed student who needs a single next action from a mixed-language brain dump.
- Founder or knowledge worker who loses focus to self-generated interruptions.
- Mobile-first Indian user speaking English, Hindi, Telugu, or code-mixed language.

## Core requirements (static)
- Four-step flow: Speak → The One Thing → Session → The Card.
- Pure black background, white/grey text, green reserved for mic/timer/time-saved accents.
- No login, signup, phone, email, blockers, accessibility service, dashboard, navigation, settings, or gamification.
- Anonymous UUID on first launch, local session history, and PostHog event hooks.
- Gemini must transcribe speech and return exactly one bounded task; interruptions must sort into NOW/LATER/DROP.
- Shareable 9:16 PNG card with Execute AI wordmark.

## Implemented — 2026-09-01
- Built the minimal four-screen React Native flow with fade-only processing, delayed Start, focused countdown, interruption capture, and shareable result card.
- Added real Expo Audio recording with microphone permissions, 60-second cap, metering-driven mic pulse, and session Keep Awake behavior.
- Added FastAPI Gemini audio transcription, single-task extraction, and interruption sorting with strict schemas, server-side word limits, item sanitization, serialized calls, and bounded retries.
- Added anonymous local identity/history and env-gated PostHog events: `first_open`, `session_started`, `session_completed`, `interruption_captured`, and `card_shared`.
- Verified TypeScript, JavaScript lint, Python lint/compile, public backend regression (3/3), and 390×844 preview smoke. Physical permission-enabled recording/share should receive a device pass.

## Prioritized backlog

### P0
- Device/Expo Go verification of full microphone → transcription → session → card → PNG share flow on Android.
- Populate `EXPO_PUBLIC_POSTHOG_KEY` when the analytics project is ready and validate event delivery.

### P1
- Add a small local history recovery/read path if a future review screen is approved; keep it out of the current one-focus flow.
- Add offline-friendly retry messaging for audio upload without inventing a transcript.

### P2
- Evaluate export typography and safe-area rendering on a range of Android aspect ratios.
- Add a lightweight privacy note only if required by store review, without adding onboarding.

## Next task list
1. Test recording permissions and sharing on a physical Android device.
2. Add PostHog project key through environment configuration and confirm the five events.
3. Review Gemini multilingual output quality with representative English/Hinglish/Telugu recordings.