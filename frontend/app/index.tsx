import { MaterialCommunityIcons } from "@expo/vector-icons";
import Constants from "expo-constants";
import {
  AudioQuality,
  IOSOutputFormat,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import * as Sharing from "expo-sharing";
import { useKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";
import Svg, { Circle } from "react-native-svg";
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
  type TextInputSubmitEditingEvent,
} from "react-native";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { RefObject } from "react";
import { format, isSameDay } from "date-fns";

import { storage } from "@/src/utils/storage";

type Phase = "speak" | "processing" | "thing" | "session" | "card";
type Alternative = { task: string; minutes: number; reason: string };
type Task = { task: string; minutes: number; deferred: string[]; reason: string; alternatives: Alternative[] };
type HistoryEntry = { task: string; durationSeconds: number; capturedCount: number; completedAt: string };
type DailyCard = { taskLines: string[]; extraTaskCount: number; totalSeconds: number; capturedCount: number };
const webInputStyle = { outlineStyle: "none" } as unknown as TextStyle;
// Mono, 16kHz, 64kbps AAC: the standard input shape for speech recognition.
// Cuts the recorded file to roughly a quarter the size of the stereo/44.1kHz
// default with no loss in transcription accuracy, so it uploads and processes faster.
const RECORDING_OPTIONS = {
  extension: ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 64000,
  android: { outputFormat: "mpeg4" as const, audioEncoder: "aac" as const },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: "audio/webm", bitsPerSecond: 64000 },
  isMeteringEnabled: true,
};

type RecorderControllerHandle = {
  start: () => Promise<void>;
  stopAndRelease: () => Promise<string | null>;
};

const RecorderController = forwardRef<RecorderControllerHandle, { onState: (isRecording: boolean, metering: number) => void }>(function RecorderController({ onState }, ref) {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 100);

  useEffect(() => {
    onState(recorderState.isRecording, recorderState.metering ?? 0);
  }, [onState, recorderState.isRecording, recorderState.metering]);

  useImperativeHandle(ref, () => ({
    start: async () => {
      await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
      recorder.record({ forDuration: 60 });
    },
    stopAndRelease: async () => {
      if (recorder.isRecording) await recorder.stop();
      return recorder.uri;
    },
  }), [recorder]);

  return null;
});

const BACKEND_URL = (
  Constants.expoConfig?.extra?.backendUrl ?? process.env.EXPO_PUBLIC_BACKEND_URL ?? ""
).replace(/\/$/, "");
const HISTORY_KEY = "execute_ai_history";
const ANONYMOUS_ID_KEY = "execute_ai_anonymous_id";
const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY ?? "";
const POSTHOG_HOST = (process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");

const makeAnonymousId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `anonymous-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const track = (event: string, anonymousId: string | null, properties: Record<string, unknown> = {}) => {
  if (!POSTHOG_KEY || !anonymousId) return;
  void fetch(`${POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: POSTHOG_KEY, event, distinct_id: anonymousId, properties }),
  }).catch(() => undefined);
};

const parseResponse = async <T,>(response: Response): Promise<T> => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "Something went wrong");
  return payload as T;
};

const formatDuration = (seconds: number) => {
  const rounded = Math.max(0, seconds);
  const hours = Math.floor(rounded / 3600);
  const wholeMinutes = Math.floor((rounded % 3600) / 60);
  const minutes = rounded > 0 && hours === 0 && wholeMinutes === 0 ? 1 : wholeMinutes;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const formatTimer = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const remainder = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
};

const CARD_TASK_BUDGET = 4;

const buildDailyCard = (history: HistoryEntry[]): DailyCard => {
  const today = history.filter((entry) => isSameDay(new Date(entry.completedAt), new Date()));
  const recent = today.slice(-CARD_TASK_BUDGET);
  return {
    taskLines: recent.map((entry) => entry.task),
    extraTaskCount: Math.max(0, today.length - recent.length),
    totalSeconds: today.reduce((sum, entry) => sum + entry.durationSeconds, 0),
    capturedCount: today.reduce((sum, entry) => sum + entry.capturedCount, 0),
  };
};

const EXAMPLE_PROMPTS = [
  "exam Friday, two assignments, gym, mom's asking about the trip, opened nothing all day",
  "three client edits pending, invoice unsent, need to post today, phone won't stop",
  "launch next week, no landing page, cofounder waiting on me, haven't eaten",
];

function ExamplePrompts() {
  const [index, setIndex] = useState(0);
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const timer = setInterval(() => {
      Animated.timing(opacity, { toValue: 0, duration: 300, easing: Easing.in(Easing.ease), useNativeDriver: true }).start(() => {
        setIndex((value) => (value + 1) % EXAMPLE_PROMPTS.length);
        Animated.timing(opacity, { toValue: 1, duration: 300, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
      });
    }, 4200);
    return () => clearInterval(timer);
  }, [opacity]);
  return (
    <Animated.Text style={[styles.examplePrompt, { opacity }]} numberOfLines={2}>
      {EXAMPLE_PROMPTS[index]}
    </Animated.Text>
  );
}

function PulsingRing({ active }: { active: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (!active) {
      scale.setValue(1);
      opacity.setValue(0.5);
      return;
    }
    const loop = Animated.loop(
      Animated.parallel([
        Animated.timing(scale, { toValue: 1.35, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      scale.setValue(1);
      opacity.setValue(0.5);
    };
  }, [active, scale, opacity]);
  if (!active) return null;
  return <Animated.View pointerEvents="none" style={[styles.pulsingRing, { opacity, transform: [{ scale }] }]} />;
}

function QuietDot() {
  const opacity = useRef(new Animated.Value(0.25)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.8, duration: 700, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.25, duration: 700, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      ]),
    ).start();
  }, [opacity]);
  return <Animated.View testID="quiet-processing" style={[styles.quietDot, { opacity }]} />;
}

function TimerRing({ progress, value }: { progress: number; value: string }) {
  const size = 220;
  const stroke = 2;
  const radius = 102;
  const circumference = 2 * Math.PI * radius;
  return (
    <View style={styles.timerWrap}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#22C55E" strokeWidth={stroke} strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - progress)} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      <Text style={styles.timerValue}>{value}</Text>
    </View>
  );
}

function SpeakScreen({ recording, amplitude, onPress, error, onRetry, recordingSeconds }: { recording: boolean; amplitude: number; onPress: () => void; error: string; onRetry: () => void; recordingSeconds: number }) {
  const pulse = Math.min(0.35, Math.max(0, amplitude / 160));
  return (
    <View style={styles.centerScreen} testID="speak-screen">
      <Text style={styles.prompt}>Speak your chaos</Text>
      <View style={styles.micWrap}>
        <PulsingRing active={recording} />
        <Pressable testID="mic-button" accessibilityRole="button" accessibilityLabel={recording ? "Stop recording" : "Start recording"} onPress={onPress} style={({ pressed }) => [styles.micButton, pressed && styles.pressed]}>
          <View style={[styles.micPulse, { opacity: recording ? 0.25 + pulse : 0 }]} />
          <MaterialCommunityIcons name="microphone" size={30} color="#FFFFFF" />
        </Pressable>
      </View>
      {recording ? <Text testID="recording-timer" style={styles.recordingTimer}>{formatTimer(recordingSeconds)}</Text> : null}
      <Text style={styles.tagline}>Get one thing. Execute it.</Text>
      {!recording && !error ? <ExamplePrompts /> : null}
      {error ? (
        <View style={styles.errorBlock}>
          <Text style={styles.errorLine} testID="speak-error">{error}</Text>
          <Pressable testID="retry-button" accessibilityRole="button" accessibilityLabel="Retry" onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function ProcessingScreen({ label }: { label?: string }) {
  return (
    <View style={styles.centerScreen} testID="processing-screen">
      <QuietDot />
      {label ? <Text style={styles.processingLabel}>{label}</Text> : null}
    </View>
  );
}

function ThingScreen({ task, onStart, onNotThisOne, insets }: { task: Task; onStart: (minutes: number) => void; onNotThisOne: () => void; insets: { bottom: number } }) {
  const fade = useRef(new Animated.Value(0)).current;
  const [ready, setReady] = useState(false);
  const [minutes, setMinutes] = useState(task.minutes);
  const minuteOptions = [15, 25, 45, 60, 90, 120];
  useEffect(() => {
    setMinutes(task.minutes);
    setReady(false);
    fade.setValue(0);
    const timer = setTimeout(() => {
      setReady(true);
      Animated.timing(fade, { toValue: 1, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
    }, 2000);
    return () => clearTimeout(timer);
  }, [fade, task.task, task.minutes]);
  const adjustMinutes = () => {
    const currentIndex = minuteOptions.indexOf(minutes);
    const nextIndex = currentIndex === -1 ? minuteOptions.findIndex((value) => value > minutes) : currentIndex + 1;
    setMinutes(minuteOptions[nextIndex >= 0 && nextIndex < minuteOptions.length ? nextIndex : 0]);
  };
  return (
    <View style={[styles.thingScreen, { paddingBottom: insets.bottom + 32 }]} testID="thing-screen">
      <View style={styles.thingHeader}>
        <Text style={styles.taskText} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.55} allowFontScaling>
          {task.task}
        </Text>
        <Text style={styles.reason} numberOfLines={3}>{task.reason}</Text>
      </View>
      <Animated.View style={[styles.thingFooter, { opacity: fade }]}>
        <Pressable testID="minutes-selector" accessibilityRole="button" accessibilityLabel="Adjust focus minutes" onPress={adjustMinutes} disabled={!ready} style={({ pressed }) => [styles.minutesButton, pressed && styles.pressed]}>
          <Text key={`minutes-${minutes}`} style={styles.minutesValue} numberOfLines={1}>{minutes} min</Text>
        </Pressable>
        <Pressable testID="start-button" disabled={!ready} onPress={() => onStart(minutes)} style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
          <Text style={styles.startText}>Start</Text>
        </Pressable>
        {task.alternatives.length > 0 ? <Pressable testID="not-this-one" disabled={!ready} onPress={onNotThisOne} style={({ pressed }) => [styles.notThisOneButton, pressed && styles.pressed]}><Text style={styles.notThisOneText}>Not this one</Text></Pressable> : null}
      </Animated.View>
    </View>
  );
}

function SessionScreen({ task, remaining, plannedSeconds, count, onSubmit, onEnd, draft, setDraft, insets }: {
  task: Task; remaining: number; plannedSeconds: number; count: number; onSubmit: (event: TextInputSubmitEditingEvent) => void; onEnd: () => void; draft: string; setDraft: (value: string) => void; insets: { top: number; bottom: number };
}) {
  useKeepAwake("execute-ai-session");
  const progress = plannedSeconds > 0 ? remaining / plannedSeconds : 0;
  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.sessionScreen} testID="session-screen">
      <Text style={[styles.sessionTask, { marginTop: insets.top + 16 }]} numberOfLines={2}>{task.task}</Text>
      <View style={styles.sessionCenter}>
        <TimerRing progress={progress} value={formatTimer(remaining)} />
        {count > 0 ? <Text style={styles.deflected}>{count} saved for later</Text> : null}
      </View>
      <View style={[styles.sessionBottom, { paddingBottom: insets.bottom + 20 }]}>
        <TextInput testID="interruption-input" value={draft} onChangeText={setDraft} onSubmitEditing={onSubmit} onBlur={Keyboard.dismiss} returnKeyType="done" placeholder="Something popped up? Drop it here" placeholderTextColor="#9CA3AF" style={[styles.captureInput, Platform.OS === "web" ? webInputStyle : null]} blurOnSubmit={false} />
        <Pressable testID="end-early" onPress={onEnd} style={({ pressed }) => [styles.endLink, pressed && styles.pressed]}><Text style={styles.endText}>End early</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function CardScreen({ card, insets, cardRef, onShare, onNewSession }: { card: DailyCard; insets: { top: number; bottom: number }; cardRef: RefObject<View | null>; onShare: () => void; onNewSession: () => void }) {
  const headerDate = format(new Date(), "EEE d MMM");
  const focusedText = formatDuration(card.totalSeconds);
  return (
    <View style={[styles.cardScreen, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]} testID="card-screen">
      <View ref={cardRef} collapsable={false} style={styles.shareBody}>
        <View style={styles.shareBodyTop}>
          <Text style={styles.cardHeader}>EXECUTED · {headerDate}</Text>
          <View style={styles.taskList}>
            {card.taskLines.map((text, index) => (
              <Text key={`task-${index}`} style={styles.taskLine} numberOfLines={2}>✓ {text}</Text>
            ))}
            {card.extraTaskCount > 0 ? <Text style={styles.moreItems}>+{card.extraTaskCount} more</Text> : null}
          </View>
          <Text style={styles.statsLine}>{focusedText} focused · {card.capturedCount} things captured, 0 lost</Text>
        </View>
        <Text style={styles.wordmark}>Execute AI</Text>
      </View>
      <Pressable testID="share-button" onPress={onShare} style={({ pressed }) => [styles.shareButton, pressed && styles.pressed]}>
        <Text style={styles.shareText}>Share</Text>
      </Pressable>
      <Pressable testID="new-session-button" onPress={onNewSession} style={({ pressed }) => [styles.newSessionButton, pressed && styles.pressed]}>
        <Text style={styles.newSessionText}>Start another</Text>
      </Pressable>
    </View>
  );
}

export default function Index() {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>("speak");
  const [anonymousId, setAnonymousId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [card, setCard] = useState<DailyCard | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [amplitude, setAmplitude] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [processingLabel, setProcessingLabel] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [plannedSeconds, setPlannedSeconds] = useState(0);
  const [interruptions, setInterruptions] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [recorderKey, setRecorderKey] = useState(0);
  const sessionStartedAt = useRef(0);
  const endingSession = useRef(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingLifecycle = useRef<"idle" | "starting" | "recording" | "stopping">("idle");
  const recorderController = useRef<RecorderControllerHandle | null>(null);
  const cardRef = useRef<View>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await storage.getItem(ANONYMOUS_ID_KEY, "");
      const id = stored || makeAnonymousId();
      if (!stored) await storage.setItem(ANONYMOUS_ID_KEY, id);
      if (active) {
        setAnonymousId(id);
        track("first_open", id);
      }
    })();
    return () => { active = false; };
  }, []);

  const handleRecorderState = useCallback((isRecording: boolean, metering: number) => {
    setRecording(isRecording);
    setAmplitude(metering);
  }, []);

  useEffect(() => {
    if (!recording) {
      setRecordingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setRecordingSeconds(0);
    const interval = setInterval(() => {
      setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => clearInterval(interval);
  }, [recording]);

  const stopRecording = useCallback(async () => {
    if (recordingLifecycle.current !== "recording") return;
    recordingLifecycle.current = "stopping";
    if (stopTimer.current) clearTimeout(stopTimer.current);
    setRecording(false);
    setAmplitude(0);
    try {
      const uri = await recorderController.current?.stopAndRelease();
      setRecorderKey((value) => value + 1);
      if (!uri) throw new Error("No recording found");
      setPhase("processing");
      setProcessingLabel("Finding your one thing");
      setError("");
      const form = new FormData();
      if (Platform.OS === "web") {
        const blob = await (await fetch(uri)).blob();
        form.append("audio", blob, "thought.webm");
      } else {
        form.append("audio", { uri, name: "thought.m4a", type: "audio/m4a" } as unknown as Blob);
      }
      const selectedTask = await parseResponse<Task>(await fetch(`${BACKEND_URL}/api/ai/task`, { method: "POST", body: form }));
      setTask(selectedTask);
      setPhase("thing");
    } catch (requestError) {
      console.warn("stopRecording failed", requestError);
      setError("Didn't catch that. Try again.");
      setPhase("speak");
    } finally {
      recordingLifecycle.current = "idle";
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (recordingLifecycle.current !== "idle") return;
    recordingLifecycle.current = "starting";
    setError("");
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission is needed");
        recordingLifecycle.current = "idle";
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (!recorderController.current) throw new Error("Recorder is not ready");
      await recorderController.current.start();
      recordingLifecycle.current = "recording";
      setRecording(true);
      stopTimer.current = setTimeout(() => { void stopRecording(); }, 60000);
    } catch (requestError) {
      try {
        await recorderController.current?.stopAndRelease();
      } catch {
        // The controller is remounted below even if native cleanup also failed.
      }
      setRecorderKey((value) => value + 1);
      recordingLifecycle.current = "idle";
      setRecording(false);
      setAmplitude(0);
      setError(requestError instanceof Error ? requestError.message : "Could not start recording");
    }
  }, [stopRecording]);

  const handleMic = () => { if (recording) void stopRecording(); else void startRecording(); };

  const retryRecording = () => {
    setError("");
    void startRecording();
  };

  const startSession = (minutes: number) => {
    if (!task) return;
    const seconds = minutes * 60;
    setPlannedSeconds(seconds);
    setRemaining(seconds);
    setInterruptions([]);
    setDraft("");
    endingSession.current = false;
    sessionStartedAt.current = Date.now();
    setPhase("session");
    track("session_started", anonymousId, { task: task.task, planned_minutes: minutes });
  };

  const chooseNextTask = () => {
    if (!task || task.alternatives.length === 0) return;
    const [next, ...remainingAlternatives] = task.alternatives;
    const nextDeferred = [...task.deferred.filter((item) => item !== next.task), task.task];
    setTask({ ...next, deferred: nextDeferred, alternatives: remainingAlternatives });
  };

  const finishSession = useCallback(async () => {
    if (!task || endingSession.current) return;
    endingSession.current = true;
    const elapsed = Math.max(1, Math.min(plannedSeconds, Math.floor((Date.now() - sessionStartedAt.current) / 1000)));
    setPhase("processing");
    setProcessingLabel("");
    const entry: HistoryEntry = {
      task: task.task,
      durationSeconds: elapsed,
      capturedCount: interruptions.length,
      completedAt: new Date().toISOString(),
    };
    const historyRaw = await storage.getItem(HISTORY_KEY, "[]");
    let history: HistoryEntry[] = [];
    try { history = JSON.parse(historyRaw || "[]") as HistoryEntry[]; } catch { history = []; }
    const updatedHistory = [...history, entry];
    await storage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    setCard(buildDailyCard(updatedHistory));
    setPhase("card");
    track("session_completed", anonymousId, { duration_seconds: elapsed, captured: interruptions.length });
  }, [anonymousId, interruptions, plannedSeconds, task]);

  useEffect(() => {
    if (phase !== "session") return;
    const interval = setInterval(() => {
      const next = Math.max(0, plannedSeconds - Math.floor((Date.now() - sessionStartedAt.current) / 1000));
      setRemaining(next);
      if (next <= 0) void finishSession();
    }, 250);
    return () => clearInterval(interval);
  }, [finishSession, phase, plannedSeconds]);

  const addInterruption = (event: TextInputSubmitEditingEvent) => {
    const item = event.nativeEvent.text.trim();
    if (!item) return;
    setInterruptions((items) => [...items, item]);
    setDraft("");
    track("interruption_captured", anonymousId);
  };

  const shareCard = async () => {
    if (!cardRef.current) return;
    try {
      const rawUri = await captureRef(cardRef.current, { format: "png", quality: 1, result: "tmpfile" });
      const uri = rawUri.startsWith("file://") ? rawUri : `file://${rawUri}`;
      if (Platform.OS !== "web" && (await Sharing.isAvailableAsync())) {
        await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share your Execute AI session" });
      } else if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.share) {
        const blob = await (await fetch(uri)).blob();
        const file = new File([blob], "execute-ai.png", { type: "image/png" });
        await navigator.share({ files: [file], title: "Execute AI" }).catch(() => undefined);
      }
      track("card_shared", anonymousId, { captured: card?.capturedCount ?? 0 });
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : "Could not share the card");
    }
  };

  const resetToSpeak = useCallback(() => {
    setPhase("speak");
    setCard(null);
    setTask(null);
    setInterruptions([]);
    setDraft("");
    setPlannedSeconds(0);
    setRemaining(0);
    setError("");
    setProcessingLabel("");
    endingSession.current = false;
  }, []);

  let content = <ProcessingScreen label={processingLabel} />;
  if (phase === "speak") content = <SpeakScreen recording={recording} amplitude={amplitude} onPress={handleMic} error={error} onRetry={retryRecording} recordingSeconds={recordingSeconds} />;
  if (phase === "thing" && task) content = <ThingScreen task={task} onStart={startSession} onNotThisOne={chooseNextTask} insets={insets} />;
  if (phase === "session" && task) content = <SessionScreen task={task} remaining={remaining} plannedSeconds={plannedSeconds} count={interruptions.length} onSubmit={addInterruption} onEnd={() => void finishSession()} draft={draft} setDraft={setDraft} insets={insets} />;
  if (phase === "card" && card) content = <CardScreen card={card} insets={insets} cardRef={cardRef} onShare={() => void shareCard()} onNewSession={resetToSpeak} />;
  return (
    <>
      <RecorderController key={recorderKey} ref={recorderController} onState={handleRecorderState} />
      <View style={styles.root}>{content}</View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  centerScreen: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  prompt: { color: "#F5F5F5", fontSize: 20, fontWeight: "700", letterSpacing: 0.1, marginBottom: 36, textAlign: "center" },
  tagline: { color: "#D1D5DB", fontSize: 15, fontWeight: "500", letterSpacing: 0.2, marginTop: 28, textAlign: "center" },
  recordingTimer: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", marginTop: 18, fontVariant: ["tabular-nums"], letterSpacing: 0.5 },
  examplePrompt: { color: "#9CA3AF", fontSize: 12, fontWeight: "500", textAlign: "center", marginTop: 28, maxWidth: 280, lineHeight: 17 },
  errorBlock: { alignItems: "center", marginTop: 22 },
  errorLine: { color: "#D1D5DB", fontSize: 13, fontWeight: "500", letterSpacing: 0.2, textAlign: "center", paddingHorizontal: 24 },
  retryButton: { minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, marginTop: 4 },
  retryText: { color: "#22C55E", fontSize: 14, fontWeight: "600", letterSpacing: 0.3 },
  processingLabel: { color: "#D1D5DB", fontSize: 14, fontWeight: "500", marginTop: 20, textAlign: "center" },
  micWrap: { alignItems: "center", justifyContent: "center" },
  pulsingRing: { position: "absolute", width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: "#22C55E" },
  thingScreen: { flex: 1, paddingHorizontal: 32 },
  thingHeader: { flex: 1, alignItems: "center", justifyContent: "center" },
  thingFooter: { alignItems: "center", paddingTop: 24 },
  minutesButton: { minHeight: 44, minWidth: 140, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, paddingVertical: 8, overflow: "hidden" },
  minutesValue: { color: "#FFFFFF", fontSize: 22, fontWeight: "600", letterSpacing: 0.2, textAlign: "center", includeFontPadding: false },
  micButton: { width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: "#22C55E", alignItems: "center", justifyContent: "center" },
  micPulse: { position: "absolute", width: 116, height: 116, borderRadius: 58, backgroundColor: "#22C55E" },
  pressed: { opacity: 0.58 },
  quietDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#9CA3AF" },
  taskText: { color: "#FFFFFF", fontSize: 40, lineHeight: 48, fontWeight: "700", letterSpacing: -1.2, textAlign: "center", maxWidth: 340 },
  reason: { color: "#D1D5DB", fontSize: 14, lineHeight: 20, fontWeight: "500", textAlign: "center", marginTop: 26, maxWidth: 280 },
  textButton: { minHeight: 44, minWidth: 80, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, marginTop: 28 },
  startText: { color: "#22C55E", fontSize: 20, fontWeight: "600", letterSpacing: 0.4 },
  notThisOneButton: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, marginTop: 16 },
  notThisOneText: { color: "#9CA3AF", fontSize: 13, fontWeight: "500" },
  sessionScreen: { flex: 1, backgroundColor: "#000000", paddingHorizontal: 32 },
  sessionTask: { color: "#D1D5DB", fontSize: 14, fontWeight: "500", textAlign: "center", minHeight: 40 },
  sessionCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  timerWrap: { width: 220, height: 220, alignItems: "center", justifyContent: "center" },
  timerValue: { position: "absolute", color: "#FFFFFF", fontSize: 64, lineHeight: 72, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -2 },
  deflected: { color: "#9CA3AF", fontSize: 13, fontWeight: "500", marginTop: 26 },
  sessionBottom: { alignItems: "center" },
  captureInput: { width: "100%", minHeight: 48, color: "#FFFFFF", fontSize: 16, fontWeight: "500", textAlign: "center", paddingHorizontal: 4, paddingVertical: 10, borderWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#6B7280" },
  endLink: { minHeight: 44, justifyContent: "center", paddingHorizontal: 16, marginTop: 18 },
  endText: { color: "#9CA3AF", fontSize: 13, fontWeight: "500" },
  cardScreen: { flex: 1, backgroundColor: "#000000", paddingHorizontal: 24, alignItems: "center" },
  shareBody: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "space-between", backgroundColor: "#000000", paddingTop: 8, paddingBottom: 4 },
  shareBodyTop: { alignSelf: "stretch", alignItems: "center" },
  cardHeader: { color: "#F5F5F5", fontSize: 15, fontWeight: "700", letterSpacing: 1, textAlign: "center" },
  taskList: { alignSelf: "stretch", alignItems: "flex-start", marginTop: 28, paddingHorizontal: 12 },
  taskLine: { color: "#FFFFFF", fontSize: 17, lineHeight: 24, fontWeight: "600", marginTop: 8 },
  statsLine: { color: "#D1D5DB", fontSize: 13, fontWeight: "500", letterSpacing: 0.2, textAlign: "center", marginTop: 28, paddingHorizontal: 12 },
  moreItems: { color: "#9CA3AF", fontSize: 13, fontWeight: "500", marginTop: 8, letterSpacing: 0.2 },
  wordmark: { color: "#9CA3AF", fontSize: 11, fontWeight: "600", textAlign: "center", letterSpacing: 1.4 },
  shareButton: { alignSelf: "center", minHeight: 44, minWidth: 120, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, marginTop: 24 },
  shareText: { color: "#22C55E", fontSize: 18, fontWeight: "600", letterSpacing: 0.4 },
  newSessionButton: { alignSelf: "center", minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, marginTop: 12 },
  newSessionText: { color: "#9CA3AF", fontSize: 13, fontWeight: "500", letterSpacing: 0.3 },
});