import { MaterialCommunityIcons } from "@expo/vector-icons";
import Constants from "expo-constants";
import {
  RecordingPresets,
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
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
  type TextInputSubmitEditingEvent,
} from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { storage } from "@/src/utils/storage";

type Phase = "speak" | "processing" | "thing" | "session" | "card";
type Alternative = { task: string; minutes: number; reason: string };
type Task = { task: string; minutes: number; deferred: string[]; reason: string; alternatives: Alternative[] };
type Sorted = { now: string[]; later: string[]; drop: string[] };
type SessionCard = { task: string; durationSeconds: number; interruptions: string[]; deferredItems: string[]; sorted: Sorted };
const webInputStyle = { outlineStyle: "none" } as unknown as TextStyle;

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
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const formatTimer = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const remainder = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
};

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

function SpeakScreen({ recording, amplitude, onPress, error }: { recording: boolean; amplitude: number; onPress: () => void; error: string }) {
  const pulse = Math.min(0.35, Math.max(0, amplitude / 160));
  return (
    <View style={styles.centerScreen} testID="speak-screen">
      <Text style={styles.prompt}>{error || (recording ? "Listening" : "What’s on your mind?")}</Text>
      <Pressable testID="mic-button" accessibilityRole="button" accessibilityLabel={recording ? "Stop recording" : "Start recording"} onPress={onPress} style={({ pressed }) => [styles.micButton, pressed && styles.pressed]}>
        <View style={[styles.micPulse, { opacity: recording ? 0.25 + pulse : 0 }]} />
        <MaterialCommunityIcons name="microphone" size={30} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

function ProcessingScreen() {
  return <View style={styles.centerScreen} testID="processing-screen"><QuietDot /></View>;
}

function ThingScreen({ task, onStart, onNotThisOne, insets }: { task: Task; onStart: () => void; onNotThisOne: () => void; insets: { bottom: number } }) {
  const fade = useRef(new Animated.Value(0)).current;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setReady(true);
      Animated.timing(fade, { toValue: 1, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
    }, 2000);
    return () => clearTimeout(timer);
  }, [fade]);
  return (
    <View style={styles.centerScreen} testID="thing-screen">
      <Text style={styles.taskText}>{task.task}</Text>
      <Text style={styles.reason}>{task.reason}</Text>
      <Animated.View style={[styles.startAnchor, { bottom: insets.bottom + 24, opacity: fade }]}>
        <Pressable testID="start-button" disabled={!ready} onPress={onStart} style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
          <Text style={styles.startText}>Start</Text>
        </Pressable>
        {task.alternatives.length > 0 ? <Pressable testID="not-this-one" disabled={!ready} onPress={onNotThisOne} style={({ pressed }) => [styles.notThisOneButton, pressed && styles.pressed]}><Text style={styles.notThisOneText}>Not this one?</Text></Pressable> : null}
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
        <TextInput testID="interruption-input" value={draft} onChangeText={setDraft} onSubmitEditing={onSubmit} onBlur={Keyboard.dismiss} returnKeyType="done" placeholder="Something came up?" placeholderTextColor="#6B7280" style={[styles.captureInput, Platform.OS === "web" ? webInputStyle : null]} blurOnSubmit={false} />
        <Pressable testID="end-early" onPress={onEnd} style={({ pressed }) => [styles.endLink, pressed && styles.pressed]}><Text style={styles.endText}>End early</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Group({ title, items }: { title: string; items: string[] }) {
  return <View style={styles.group}><Text style={styles.groupTitle}>{title}</Text>{items.map((item, index) => <Text key={`${item}-${index}`} style={styles.groupItem}>{item}</Text>)}</View>;
}

function CardScreen({ card, insets, cardRef, onShare }: { card: SessionCard; insets: { top: number; bottom: number }; cardRef: RefObject<View | null>; onShare: () => void }) {
  const saved = (card.interruptions.length + card.deferredItems.length) * 23;
  return (
    <ScrollView style={styles.cardScreen} contentContainerStyle={[styles.cardContent, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]} testID="card-screen">
      <View ref={cardRef} collapsable={false} style={styles.shareCanvas}>
        <View style={styles.cardStats}>
          <Text style={styles.cardTask}>{card.task}</Text>
          <Text style={styles.cardNumber}>{formatDuration(card.durationSeconds)}</Text>
          <Text style={styles.cardLabel}>focused</Text>
          <Text style={styles.cardNumber}>{card.interruptions.length}</Text>
          <Text style={styles.cardLabel}>captured</Text>
          <Text style={styles.savedNumber}>{formatDuration(saved * 60)}</Text>
          <Text style={styles.cardLabel}>time saved</Text>
        </View>
        <Text style={styles.wordmark}>Execute AI</Text>
      </View>
      <View style={styles.groups}><Group title="NOW" items={card.sorted.now} /><Group title="LATER" items={card.sorted.later} /><Group title="DROP" items={card.sorted.drop} /></View>
      <Pressable testID="share-button" onPress={onShare} style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}><Text style={styles.shareText}>Share</Text></Pressable>
    </ScrollView>
  );
}

export default function Index() {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>("speak");
  const [anonymousId, setAnonymousId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [card, setCard] = useState<SessionCard | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [amplitude, setAmplitude] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [plannedSeconds, setPlannedSeconds] = useState(0);
  const [interruptions, setInterruptions] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const sessionStartedAt = useRef(0);
  const endingSession = useRef(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<View>(null);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);

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

  useEffect(() => {
    setRecording(recorderState.isRecording);
    setAmplitude(recorderState.metering ?? 0);
  }, [recorderState.isRecording, recorderState.metering]);

  const stopRecording = useCallback(async () => {
    if (!recorder.isRecording) return;
    await recorder.stop();
    if (stopTimer.current) clearTimeout(stopTimer.current);
    const uri = recorder.uri;
    setRecording(false);
    setAmplitude(0);
    if (!uri) {
      setError("No recording found");
      return;
    }
    setPhase("processing");
    setError("");
    try {
      const form = new FormData();
      if (Platform.OS === "web") {
        const blob = await (await fetch(uri)).blob();
        form.append("audio", blob, "thought.webm");
      } else {
        form.append("audio", { uri, name: "thought.m4a", type: "audio/m4a" } as unknown as Blob);
      }
      const transcript = await parseResponse<{ transcript: string }>(await fetch(`${BACKEND_URL}/api/ai/transcribe`, { method: "POST", body: form }));
      const selectedTask = await parseResponse<Task>(await fetch(`${BACKEND_URL}/api/ai/task`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: transcript.transcript }) }));
      setTask(selectedTask);
      setPhase("thing");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not understand that recording");
      setPhase("speak");
    }
  }, [recorder]);

  const startRecording = useCallback(async () => {
    setError("");
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setError("Microphone permission is needed");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 60 });
    stopTimer.current = setTimeout(() => { void stopRecording(); }, 60000);
  }, [recorder, stopRecording]);

  const handleMic = () => { if (recording) void stopRecording(); else void startRecording(); };

  const startSession = () => {
    if (!task) return;
    const seconds = task.minutes * 60;
    setPlannedSeconds(seconds);
    setRemaining(seconds);
    setInterruptions([]);
    setDraft("");
    endingSession.current = false;
    sessionStartedAt.current = Date.now();
    setPhase("session");
    track("session_started", anonymousId, { task: task.task, planned_minutes: task.minutes });
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
    let sorted: Sorted = { now: [], later: [], drop: [] };
    const deferredItems = task.deferred;
    const itemsToSort = [...interruptions, ...deferredItems];
    if (itemsToSort.length > 0) {
      try {
        sorted = await parseResponse<Sorted>(await fetch(`${BACKEND_URL}/api/ai/sort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: task.task, interruptions: itemsToSort }) }));
      } catch {
        sorted = { now: [], later: itemsToSort, drop: [] };
      }
    }
    const nextCard = { task: task.task, durationSeconds: elapsed, interruptions, deferredItems, sorted };
    const historyRaw = await storage.getItem(HISTORY_KEY, "[]");
    let history: unknown[] = [];
    try { history = JSON.parse(historyRaw || "[]") as unknown[]; } catch { history = []; }
    await storage.setItem(HISTORY_KEY, JSON.stringify([...history, { ...nextCard, completedAt: new Date().toISOString() }]));
    setCard(nextCard);
    setPhase("card");
    track("session_completed", anonymousId, { duration_seconds: elapsed, captured: interruptions.length, deferred: deferredItems.length });
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
    if (!cardRef.current || !(await Sharing.isAvailableAsync())) return;
    const uri = await captureRef(cardRef.current, { format: "png", quality: 1, result: "tmpfile", width: 360, height: 640 });
    await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share your Execute AI session" });
    track("card_shared", anonymousId, { captured: card?.interruptions.length ?? 0, deferred: card?.deferredItems.length ?? 0 });
  };

  let content = <ProcessingScreen />;
  if (phase === "speak") content = <SpeakScreen recording={recording} amplitude={amplitude} onPress={handleMic} error={error} />;
  if (phase === "thing" && task) content = <ThingScreen task={task} onStart={startSession} onNotThisOne={chooseNextTask} insets={insets} />;
  if (phase === "session" && task) content = <SessionScreen task={task} remaining={remaining} plannedSeconds={plannedSeconds} count={interruptions.length} onSubmit={addInterruption} onEnd={() => void finishSession()} draft={draft} setDraft={setDraft} insets={insets} />;
  if (phase === "card" && card) content = <CardScreen card={card} insets={insets} cardRef={cardRef} onShare={() => void shareCard()} />;
  return <View style={styles.root}>{content}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  centerScreen: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  prompt: { color: "#6B7280", fontSize: 14, fontWeight: "300", letterSpacing: 0.1, marginBottom: 42, textAlign: "center" },
  micButton: { width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: "#22C55E", alignItems: "center", justifyContent: "center" },
  micPulse: { position: "absolute", width: 116, height: 116, borderRadius: 58, backgroundColor: "#22C55E" },
  pressed: { opacity: 0.58 },
  quietDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#6B7280" },
  taskText: { color: "#FFFFFF", fontSize: 40, lineHeight: 48, fontWeight: "600", letterSpacing: -1.2, textAlign: "center", maxWidth: 340 },
  reason: { color: "#6B7280", fontSize: 14, lineHeight: 20, fontWeight: "300", textAlign: "center", marginTop: 26, maxWidth: 280 },
  startAnchor: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  textButton: { minHeight: 44, minWidth: 80, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  startText: { color: "#FFFFFF", fontSize: 16, fontWeight: "300" },
  notThisOneButton: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, marginTop: 2 },
  notThisOneText: { color: "#6B7280", fontSize: 13, fontWeight: "300" },
  sessionScreen: { flex: 1, backgroundColor: "#000000", paddingHorizontal: 32 },
  sessionTask: { color: "#6B7280", fontSize: 14, fontWeight: "300", textAlign: "center", minHeight: 40 },
  sessionCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  timerWrap: { width: 220, height: 220, alignItems: "center", justifyContent: "center" },
  timerValue: { position: "absolute", color: "#FFFFFF", fontSize: 64, lineHeight: 72, fontWeight: "300", fontVariant: ["tabular-nums"], letterSpacing: -2 },
  deflected: { color: "#6B7280", fontSize: 13, fontWeight: "300", marginTop: 26 },
  sessionBottom: { alignItems: "center" },
  captureInput: { width: "100%", minHeight: 48, color: "#FFFFFF", fontSize: 16, fontWeight: "300", textAlign: "center", paddingHorizontal: 4, paddingVertical: 10, borderWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#6B7280" },
  endLink: { minHeight: 44, justifyContent: "center", paddingHorizontal: 16, marginTop: 18 },
  endText: { color: "#6B7280", fontSize: 13, fontWeight: "300" },
  cardScreen: { flex: 1, backgroundColor: "#000000" },
  cardContent: { alignItems: "center", width: "100%" },
  shareCanvas: { width: 360, height: 640, maxWidth: "100%", backgroundColor: "#000000", paddingHorizontal: 32, paddingVertical: 34, justifyContent: "space-between" },
  cardStats: { alignItems: "center", paddingTop: 12 },
  cardTask: { color: "#6B7280", fontSize: 14, fontWeight: "300", textAlign: "center", marginBottom: 22 },
  cardNumber: { color: "#FFFFFF", fontSize: 48, lineHeight: 54, fontWeight: "300", letterSpacing: -1.8 },
  savedNumber: { color: "#22C55E", fontSize: 56, lineHeight: 62, fontWeight: "300", letterSpacing: -2, marginTop: 22 },
  cardLabel: { color: "#6B7280", fontSize: 12, fontWeight: "300", marginTop: 3, marginBottom: 8 },
  groups: { paddingTop: 10 },
  group: { marginTop: 10 },
  groupTitle: { color: "#6B7280", fontSize: 11, fontWeight: "600", letterSpacing: 1.2, marginBottom: 5 },
  groupItem: { color: "#FFFFFF", fontSize: 13, lineHeight: 19, fontWeight: "300" },
  wordmark: { color: "#FFFFFF", fontSize: 12, fontWeight: "600", textAlign: "center", letterSpacing: 0.4 },
  shareText: { color: "#FFFFFF", fontSize: 16, fontWeight: "300" },
});