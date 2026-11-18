/**
 * Assistant: the calm, voice-first front door.
 *
 * The assistant is a conversation, not a dashboard. It routes everyday needs to
 * the app's real tools (breathing, SOS, map, mesh, preparedness) and answers
 * safety questions only from the approved offline records. The text model can rephrase a
 * retrieved record on request; it is never the source of the steps.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionButton, AppText } from '../components/ui';
import { BreathingExercise } from '../components/BreathingExercise';
import { PhotoButton } from '../components/PhotoButton';
import { VoiceButton } from '../components/VoiceButton';
import { answer, QUICK_PROMPTS } from '../core/ai/retrieval';
import { assessQuery, type QueryAssessment } from '../core/ai/safety';
import type { AssistantMode } from '../core/ai/prompts';
import type { FallbackReason } from '../core/ai/assistant';
import { KIT_ITEMS, kitProgress, type KitItem } from '../core/preparedness';
import type { KnowledgeEntry } from '../core/knowledge';
import { loadChecklist } from '../services/storage';
import { assistQuery } from '../services/local-ai';
import { useModels } from '../state/useModels';
import { tapFeedback } from '../services/haptics';
import { palette, radius, shadow, space, type } from '../theme';

type ActionKind = 'breathe' | 'sos' | 'kit' | 'chat' | 'map';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: 'text' | 'answer' | 'safety' | 'kit' | 'sos' | 'no-match';
  entry?: KnowledgeEntry;
  sources?: KnowledgeEntry[];
  kitItems?: KitItem[];
  confident?: boolean;
  actions?: ActionKind[];
  query?: string;
  /** The model's answer, when one passed validation. */
  model?: { text: string; mode: AssistantMode; sources: string[]; elapsedMs: number };
  /** Why no model phrasing is shown, in one plain sentence. */
  modelNote?: string;
  photo?: string;
};

const SUGGESTIONS = [
  "I'm anxious",
  'Steady my breathing',
  'Heavy bleeding',
  'I need help now',
  'What should I pack?',
] as const;

const KIT_INTENT = /\b(kit|pack|packed|prepared|prepare|supplies|checklist)\b/i;
const BREATH_INTENT = /\b(breathe|breathing|panic|anxious|anxiety|shaking|calm|overwhelmed)\b/i;
const SOS_INTENT = /\b(sos|emergency|emergencies|trapped|help me now|need help now)\b/i;
const CHAT_INTENT = /\b(chat|talk|people|nearby|message|radio|bluetooth)\b/i;
const MAP_INTENT = /\b(map|where am i|i am lost|i'm lost|route|directions)\b/i;
const GREETING_INTENT = /\b(hi|hello|hey|namaste|good morning|good evening|thanks|thank you)\b/i;

function messageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * How the model's answer relates to what is on screen. The answer itself is the
 * assistant's bubble now; this line only says where it came from, because a
 * person deserves to know whether words were written here or quoted.
 */
const MODE_CAPTIONS: Record<AssistantMode, string> = {
  REPHRASE: 'In plain words',
  QUESTION: 'Answered from the approved record',
  CLARIFY: 'About that step',
  SITUATION: 'What applies here',
};

/** "Written on this phone in 12 s" — proof it ran, not a canned string. */
function provenanceLine(model: { mode: AssistantMode; elapsedMs: number }): string {
  const seconds = Math.max(1, Math.round(model.elapsedMs / 1000));
  return `${MODE_CAPTIONS[model.mode]} · written on this phone in ${seconds} s`;
}

/** One sentence explaining why only the approved record is on screen. */
function fallbackNote(reason?: FallbackReason, installed = true): string {
  if (reason === 'timeout') {
    return 'The local model took too long on this phone, so only the approved record is shown.';
  }
  if (reason === 'no_model') {
    return installed
      ? 'The text model is installed but could not start on this phone, so only the approved record is shown.'
      : 'The text model is not installed, so only the approved record is shown.';
  }
  return 'The local model’s answer did not stay within the approved record, so only the record is shown.';
}

export function AssistantScreen({
  onOpenKit,
  onOpenSos,
  onOpenChat,
  onOpenMap,
}: {
  onOpenKit?: () => void;
  onOpenSos?: () => void;
  onOpenChat?: () => void;
  onOpenMap?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const models = useModels();
  const scrollRef = useRef<ScrollView | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [breathing, setBreathing] = useState(false);
  const [kitPacked, setKitPacked] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    void loadChecklist().then(setKitPacked);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [messages.length, thinking]);

  function openAction(action: ActionKind) {
    tapFeedback();
    if (action === 'breathe') setBreathing(true);
    if (action === 'sos') onOpenSos?.();
    if (action === 'kit') onOpenKit?.();
    if (action === 'chat') onOpenChat?.();
    if (action === 'map') onOpenMap?.();
  }

  async function sendPrompt(raw: string) {
    const text = raw.trim();
    if (text.length === 0 || thinking) return;
    setDraft('');
    setNotice(null);
    setInputError(null);
    Keyboard.dismiss();
    setMessages((current) => [
      ...current,
      { id: messageId(), role: 'user', text, kind: 'text' },
    ]);
    setThinking(true);
    try {
      const response = await buildResponse(text, kitPacked, Boolean(models.text));
      setMessages((current) => [...current, response]);
    } finally {
      setThinking(false);
    }
  }

  async function explain(message: Message) {
    if (!message.entry || !message.query || message.model) return;
    setNotice('Reading the approved record on this phone…');
    const outcome = await assistQuery(message.query, {
      mode: 'REPHRASE',
      sourceId: message.entry.id,
    });
    setNotice(null);
    setMessages((current) =>
      current.map((candidate) => {
        if (candidate.id !== message.id) return candidate;
        if (outcome.kind === 'answer') {
          return {
            ...candidate,
            text: outcome.text,
            model: {
              text: outcome.text,
              mode: outcome.mode,
              sources: outcome.sources.map((source) => source.title),
              elapsedMs: outcome.elapsedMs,
            },
          };
        }
        return {
          ...candidate,
          modelNote: fallbackNote(outcome.kind === 'fallback' ? outcome.reason : undefined, Boolean(models.text)),
        };
      }),
    );
  }

  const intro = messages.length === 0;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.topBar, { paddingTop: insets.top + space.sm }]}>
        <Text style={styles.wordmark}>KindMinds</Text>
        {onOpenKit ? (
          <Pressable accessibilityRole="button" hitSlop={space.sm} onPress={onOpenKit} style={styles.topAction}>
            <Text style={styles.topActionText}>Prepare</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[styles.content, intro && styles.contentIntro]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        showsVerticalScrollIndicator={false}
      >
        {intro ? (
          <Intro
            voiceReady={Boolean(models.voice)}
            onPick={(suggestion) => void sendPrompt(suggestion)}
          />
        ) : null}
        {messages.map((message) => (
          <Appearing key={message.id}>
            <MessageView
              message={message}
              modelsText={Boolean(models.text)}
              onAction={openAction}
              onExplain={() => void explain(message)}
            />
          </Appearing>
        ))}
        {thinking ? (
          <View style={styles.thinking}>
            <ActivityIndicator size="small" color={palette.primary} />
            <Text style={styles.thinkingText}>Checking the records on this phone…</Text>
          </View>
        ) : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </ScrollView>

      <View style={styles.composerWrap}>
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Tell me what is happening…"
            placeholderTextColor={palette.inkFaint}
            style={styles.input}
            multiline
            maxLength={500}
            returnKeyType="send"
            onSubmitEditing={() => void sendPrompt(draft)}
            accessibilityLabel="Message KindMinds"
          />
          <View style={styles.composerActions}>
            <VoiceButton
              enabled={Boolean(models.voice)}
              onTranscript={(text) => void sendPrompt(text)}
              onError={setInputError}
            />
            <PhotoButton
              enabled={Boolean(models.vision)}
              onDescription={(text) => {
                setInputError(null);
                setMessages((current) => [
                  ...current,
                  {
                    id: messageId(),
                    role: 'assistant',
                    text: 'Here is what I can see. This is a description, not a diagnosis.',
                    kind: 'text',
                    photo: text,
                  },
                ]);
              }}
              onError={setInputError}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={draft.trim().length === 0}
              hitSlop={space.sm}
              android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
              onPress={() => {
                tapFeedback();
                void sendPrompt(draft);
              }}
              style={({ pressed }) => [
                styles.send,
                draft.trim().length === 0 && styles.sendDisabled,
                { opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
          </View>
        </View>
        {inputError ? (
          <Text accessibilityLiveRegion="polite" style={styles.composerError}>
            {inputError}
          </Text>
        ) : null}
        <Text style={styles.privacy}>Approved records only.</Text>
      </View>

      <BreathingExercise visible={breathing} onClose={() => setBreathing(false)} />
    </KeyboardAvoidingView>
  );
}

async function buildResponse(
  text: string,
  packed: Record<string, boolean>,
  textModelInstalled: boolean,
): Promise<Message> {
  const lower = text.toLowerCase();
  const assessment = assessQuery(text);

  if (GREETING_INTENT.test(lower) && text.trim().split(/\s+/).length <= 4) {
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'text',
      text: 'I’m here. Tell me what is happening — first aid, panic, water, shelter, or finding people nearby.',
      query: text,
    };
  }

  if (KIT_INTENT.test(lower)) {
    const fresh = await loadChecklist().catch(() => packed);
    const progress = kitProgress(fresh);
    const missing = KIT_ITEMS.filter((item) => fresh[item.id] !== true).slice(0, 3);
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'kit',
      text:
        progress.ratio === 1
          ? 'Your 72-hour kit is complete. Keep the phone charged and the offline map installed.'
          : `You have ${progress.packed} of ${progress.total} essentials. Start with the next three; that is where the biggest safety gain is.`,
      actions: ['kit'],
      query: text,
      kitItems: missing,
    };
  }

  if (SOS_INTENT.test(lower)) {
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'sos',
      text: 'Open SOS and send it now. It goes out with your position in one tap; add a note afterwards if you can.',
      actions: ['sos'],
      query: text,
    };
  }

  if (BREATH_INTENT.test(lower)) {
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'text',
      text: 'Let’s slow this down together. One minute of longer exhales is enough to lower the alarm. If you are in danger, use SOS instead.',
      actions: ['breathe', 'sos'],
      query: text,
    };
  }

  if (CHAT_INTENT.test(lower)) {
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'text',
      text: 'Chat shows one pinned room and the people closest to you over Bluetooth. Open it to ask for water, a route, or company.',
      actions: ['chat'],
      query: text,
    };
  }

  if (MAP_INTENT.test(lower)) {
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'text',
      text: 'Your offline map is on this phone. Open it to see where you are and what is around you; it keeps working without a network.',
      actions: ['map'],
      query: text,
    };
  }

  if (assessment.severity === 'self-harm' || assessment.severity === 'emergency') {
    const result = answer(text);
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'safety',
      text: assessment.message ?? 'This may be an emergency. Get help now and follow the approved record.',
      actions: assessment.severity === 'self-harm' ? ['sos', 'breathe'] : ['sos'],
      entry: result?.primary,
      sources: result?.sources,
      confident: result?.confident,
      query: text,
    };
  }

  if (assessment.severity === 'wellness') {
    const result = answer(text);
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'answer',
      text: 'That sounds heavy. You do not have to solve it all at once. Here is a grounded next step.',
      entry: result?.primary,
      sources: result?.sources,
      confident: result?.confident,
      actions: ['breathe'],
      query: text,
    };
  }

  const result = answer(text);
  if (!result) {
    const unsupported = await assistQuery(text);
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'no-match',
      text:
        unsupported.kind === 'unsupported'
          ? unsupported.text
          : 'I do not have an approved record for that. Do not improvise from memory. Try naming the problem in plain words, or open SOS if someone is in danger.',
      actions: ['sos'],
      query: text,
    };
  }
  // The model's answer is the assistant's reply. The approved record it came
  // from stays on screen beneath it, so the reader always has the reviewed
  // wording and can see exactly what the answer was built from.
  const layered = await assistQuery(text, { sourceId: result.primary.id });
  if (layered.kind === 'answer') {
    return {
      id: messageId(),
      role: 'assistant',
      kind: 'answer',
      text: layered.text,
      entry: result.primary,
      sources: result.sources,
      confident: result.confident,
      query: text,
      model: {
        text: layered.text,
        mode: layered.mode,
        sources: layered.sources.map((source) => source.title),
        elapsedMs: layered.elapsedMs,
      },
    };
  }
  return {
    id: messageId(),
    role: 'assistant',
    kind: 'answer',
    text: result.confident
      ? 'Here is the approved record for that.'
      : 'This is the closest approved record on the phone. It may not be the exact match.',
    entry: result.primary,
    sources: result.sources,
    confident: result.confident,
    query: text,
    modelNote: fallbackNote(layered.kind === 'fallback' ? layered.reason : undefined, textModelInstalled),
  };
}

function Intro({
  voiceReady,
  onPick,
}: {
  voiceReady: boolean;
  onPick: (suggestion: string) => void;
}) {
  return (
    <View style={styles.intro}>
      <Text style={styles.heroTitle}>What’s happening right now?</Text>
      <Text style={styles.heroBody}>
        Tell me in your words. I can help with first aid, panic, water, shelter, or finding people
        nearby.
      </Text>
      <View style={styles.suggestions}>
        {SUGGESTIONS.map((suggestion) => {
          const urgent = suggestion === 'I need help now';
          return (
            <Pressable
              key={suggestion}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(195,75,21,0.08)' }}
              onPress={() => {
                tapFeedback();
                onPick(suggestion);
              }}
              style={({ pressed }) => [
                styles.suggestion,
                urgent && styles.suggestionUrgent,
                { opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.suggestionText, urgent && styles.suggestionTextUrgent]}>
                {suggestion}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.voiceHint}>
        {voiceReady
          ? 'Tap the microphone and speak. Shruti runs on this phone.'
          : 'Type below. This build has no voice model.'}
      </Text>
    </View>
  );
}

function Appearing({ children }: { children: ReactNode }) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [progress]);
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

function MessageView({
  message,
  modelsText,
  onAction,
  onExplain,
}: {
  message: Message;
  modelsText: boolean;
  onAction: (action: ActionKind) => void;
  onExplain: () => void;
}) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{message.text}</Text>
        </View>
      </View>
    );
  }

  if (message.kind === 'answer' && message.entry) {
    return (
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantText}>{message.text}</Text>
        {message.model ? (
          <Text style={styles.provenance}>{provenanceLine(message.model)}</Text>
        ) : null}
        <View style={styles.answerCard}>
          <Text style={styles.cardKicker}>
            {message.model ? 'Approved record this answer came from' : 'Approved record'}
          </Text>
          <Text style={styles.answerTitle}>{message.entry.title}</Text>
          <Text style={styles.answerSummary}>{message.entry.summary}</Text>
          {message.entry.steps.map((step, index) => (
            <View key={`${message.id}-${index}`} style={styles.step}>
              <Text style={styles.stepNumber}>{String(index + 1).padStart(2, '0')}</Text>
              <Text style={[styles.stepText, step.critical && styles.stepCritical]}>{step.text}</Text>
            </View>
          ))}
          {message.entry.never.map((rule) => (
            <Text key={rule} style={styles.never}>{rule}</Text>
          ))}
          {!message.model && message.modelNote ? (
            <Text style={styles.modelNote}>{message.modelNote}</Text>
          ) : null}
          <View style={styles.messageActions}>
            {modelsText && !message.model ? (
              <Pressable accessibilityRole="button" onPress={onExplain} style={styles.textAction}>
                <Text style={styles.textActionLabel}>Say it in plain words</Text>
              </Pressable>
            ) : null}
            {message.actions?.map((action) => (
              <ActionPill key={action} action={action} onPress={() => onAction(action)} />
            ))}
          </View>
        </View>
      </View>
    );
  }

  if (message.kind === 'safety') {
    return (
      <View style={styles.assistantMessage}>
        <View style={styles.safetyCard}>
          <Text style={styles.safetyKicker}>Get help first</Text>
          <Text style={styles.answerTitle}>{message.text}</Text>
          {message.entry ? (
            <>
              <Text style={styles.answerSummary}>{message.entry.summary}</Text>
              {message.entry.steps.map((step, index) => (
                <View key={`${message.id}-${index}`} style={styles.step}>
                  <Text style={styles.stepNumber}>{String(index + 1).padStart(2, '0')}</Text>
                  <Text style={styles.stepText}>{step.text}</Text>
                </View>
              ))}
            </>
          ) : null}
          <View style={styles.messageActions}>
            {message.actions?.map((action) => (
              <ActionPill key={action} action={action} onPress={() => onAction(action)} />
            ))}
          </View>
        </View>
      </View>
    );
  }

  if (message.kind === 'kit') {
    return (
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantText}>{message.text}</Text>
        <View style={styles.answerCard}>
          <Text style={styles.answerTitle}>Next to pack</Text>
          {(message.kitItems ?? []).map((item) => (
            <View key={item.id} style={styles.kitRow}>
              <Text style={styles.kitBullet}>○</Text>
              <View style={styles.kitRowText}>
                <Text style={styles.kitLabel}>{item.label}</Text>
                <Text style={styles.answerSummary}>{item.why}</Text>
              </View>
            </View>
          ))}
          <View style={styles.messageActions}>
            {message.actions?.map((action) => (
              <ActionPill key={action} action={action} onPress={() => onAction(action)} />
            ))}
          </View>
        </View>
      </View>
    );
  }

  if (message.kind === 'sos') {
    return (
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantText}>{message.text}</Text>
        <View style={styles.messageActions}>
          {message.actions?.map((action) => (
            <ActionPill key={action} action={action} onPress={() => onAction(action)} />
          ))}
        </View>
      </View>
    );
  }

  if (message.kind === 'no-match') {
    return (
      <View style={styles.assistantMessage}>
        <Text style={styles.assistantText}>{message.text}</Text>
        <View style={styles.messageActions}>
          {message.actions?.map((action) => (
            <ActionPill key={action} action={action} onPress={() => onAction(action)} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantMessage}>
      <Text style={styles.assistantText}>{message.text}</Text>
      {message.photo ? (
        <View style={styles.answerCard}>
          <Text style={styles.answerSummary}>{message.photo}</Text>
        </View>
      ) : null}
      {message.actions?.length ? (
        <View style={styles.messageActions}>
          {message.actions.map((action) => (
            <ActionPill key={action} action={action} onPress={() => onAction(action)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const ACTION_COPY: Record<ActionKind, string> = {
  breathe: 'Steady my breathing',
  sos: 'Open SOS',
  kit: 'Open prepare',
  chat: 'Open Chat',
  map: 'Open Map',
};

function ActionPill({ action, onPress }: { action: ActionKind; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(249,115,22,0.08)' }}
      onPress={onPress}
      style={({ pressed }) => [styles.actionPill, action === 'sos' && styles.sosPill, { opacity: pressed ? 0.75 : 1 }]}
    >
      <Text style={[styles.actionPillText, action === 'sos' && styles.sosPillText]}>{ACTION_COPY[action]}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: palette.canvas,
  },
  wordmark: { color: palette.ink, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  topAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  topActionText: { color: palette.accent, fontSize: 13, fontWeight: '700' },
  scroll: { flex: 1 },
  content: { gap: space.md, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg },
  contentIntro: { flexGrow: 1, justifyContent: 'center', paddingBottom: space.xl },
  intro: { gap: space.md },
  heroTitle: { color: palette.ink, fontSize: 34, lineHeight: 39, fontWeight: '800', letterSpacing: -1 },
  heroBody: { color: palette.inkMuted, fontSize: 16, lineHeight: 24, maxWidth: '94%' },
  voiceHint: { color: palette.inkMuted, fontSize: 12, lineHeight: 17 },
  userRow: { alignItems: 'flex-end' },
  userBubble: {
    maxWidth: '86%',
    backgroundColor: palette.primary,
    borderRadius: radius.md,
    borderBottomRightRadius: radius.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  userText: { color: palette.surface, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  assistantMessage: { gap: space.sm, maxWidth: '96%' },
  assistantText: { color: palette.ink, fontSize: 16, lineHeight: 24 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  thinkingText: { color: palette.inkMuted, fontSize: 12 },
  notice: { color: palette.inkMuted, fontSize: 11, paddingVertical: space.xs },
  answerCard: {
    gap: space.sm,
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.line,
    padding: space.md,
  },
  answerTitle: { color: palette.ink, fontSize: 19, fontWeight: '700', lineHeight: 24, letterSpacing: -0.2 },
  answerSummary: { color: palette.inkMuted, fontSize: 14, lineHeight: 21 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  stepNumber: { ...type.readout, color: palette.inkMuted, fontSize: 11, fontWeight: '700', paddingTop: 3, width: 18 },
  stepText: { flex: 1, color: palette.ink, fontSize: 14, lineHeight: 21 },
  stepCritical: { fontWeight: '700' },
  never: {
    color: palette.hazard,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: palette.hazardDim,
    borderRadius: radius.sm,
    padding: space.sm,
  },
  modelText: {
    gap: space.xs,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  modelSources: { color: palette.inkMuted, fontSize: 11, lineHeight: 16 },
  modelNote: { color: palette.hazard, fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  modelLabel: { color: palette.safe, fontSize: 12, fontWeight: '700' },
  /** Where the answer came from: mode plus the time it actually took. */
  provenance: { color: palette.safe, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  /** Small heading above the record inside the card. */
  cardKicker: {
    color: palette.inkMuted,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  messageActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, paddingTop: space.xs },
  textAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.xs },
  textActionLabel: { color: palette.accent, fontSize: 13, fontWeight: '600' },
  actionPill: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: palette.primaryWash,
    overflow: 'hidden',
  },
  actionPillText: { color: palette.primaryText, fontSize: 13, fontWeight: '700' },
  sosPill: { backgroundColor: palette.hazard },
  sosPillText: { color: palette.surface },
  safetyCard: {
    gap: space.sm,
    backgroundColor: palette.hazardDim,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.hazard,
    padding: space.md,
  },
  safetyKicker: { color: palette.hazard, fontSize: 12, fontWeight: '700' },
  kitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  kitBullet: { color: palette.primary, fontSize: 16, lineHeight: 18 },
  kitRowText: { flex: 1, gap: 1 },
  kitLabel: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  composerWrap: { backgroundColor: palette.canvas, paddingTop: space.xs },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    paddingTop: space.xs,
  },
  suggestion: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.line,
  },
  suggestionUrgent: { backgroundColor: palette.hazardDim, borderColor: palette.hazardDim },
  suggestionText: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  suggestionTextUrgent: { color: palette.hazard, fontWeight: '700' },
  composer: {
    marginHorizontal: space.lg,
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    padding: space.sm,
    gap: space.sm,
    ...shadow,
  },
  input: { color: palette.ink, fontSize: 16, lineHeight: 22, maxHeight: 112, paddingTop: 4 },
  composerActions: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'flex-end', gap: space.xs },
  send: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: palette.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sendDisabled: { opacity: 0.35 },
  sendText: { color: palette.surface, fontSize: 24, fontWeight: '600', lineHeight: 26 },
  privacy: { color: palette.inkMuted, fontSize: 11, textAlign: 'center', paddingVertical: space.sm },
  composerError: {
    color: palette.caution,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
});
