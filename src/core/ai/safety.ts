/**
 * Safety checks that sit in front of the local model.
 *
 * The model is a rephraser, never the source of truth. These checks catch the
 * two cases where a generic answer is not enough: a person may be thinking about
 * hurting themselves, or the situation may be an immediate medical emergency.
 * In both cases the approved record and the SOS button take priority over anything
 * the model could say.
 */

import type { TopicId } from '../knowledge';

export type QuerySeverity = 'self-harm' | 'emergency' | 'wellness' | 'normal';

export type QueryAssessment = {
  severity: QuerySeverity;
  message: string | null;
  suggestedTopic: TopicId | null;
  matched: string[];
};

const SELF_HARM = [
  'suicide',
  'suicidal',
  'kill myself',
  'end my life',
  'want to die',
  'don\'t want to live',
  'do not want to live',
  'hurt myself',
  'self harm',
  'self-harm',
  'cut myself',
  'overdose',
];

const EMERGENCY = [
  'not breathing',
  'stopped breathing',
  'unconscious',
  'unresponsive',
  'no pulse',
  'severe bleeding',
  'bleeding badly',
  'chest pain',
  'heart attack',
  'stroke',
  'seizure',
  'choking',
  'crushed',
  'trapped',
];

const WELLNESS = [
  'panic',
  'anxiety',
  'anxious',
  'shaking',
  'scared',
  'afraid',
  'grief',
  'grieving',
  'lost someone',
  'died',
  'death',
  'sad',
  'depressed',
  'lonely',
  'alone',
  'angry',
  'furious',
  'can\'t sleep',
  'cannot sleep',
  'nightmare',
  'overwhelmed',
  'hopeless',
];

function find(text: string, terms: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term));
}

export function assessQuery(query: string): QueryAssessment {
  const selfHarm = find(query, SELF_HARM);
  if (selfHarm.length > 0) {
    return {
      severity: 'self-harm',
      matched: selfHarm,
      suggestedTopic: 'grounding',
      message:
        'You matter, and you do not have to carry this alone. Move away from anything you could use to hurt yourself. Stay with a person if you can. Use the SOS button to call nearby people, and contact local emergency services if any network is available. The grounding steps below can help you get through the next few minutes.',
    };
  }

  const emergency = find(query, EMERGENCY);
  if (emergency.length > 0) {
    return {
      severity: 'emergency',
      matched: emergency,
      suggestedTopic: null,
      message:
        'This may be an immediate emergency. Use the SOS button now and follow the approved steps below. Do not wait for the AI, and do not drive yourself if you are injured.',
    };
  }

  const wellness = find(query, WELLNESS);
  if (wellness.length > 0) {
    const suggestedTopic: TopicId = wellness.some((term) => ['grief', 'grieving', 'lost someone', 'died', 'death'].includes(term))
      ? 'grief'
      : wellness.some((term) => ['lonely', 'alone'].includes(term))
        ? 'loneliness'
        : wellness.some((term) => ['angry', 'furious'].includes(term))
          ? 'anger'
          : wellness.some((term) => ['can\'t sleep', 'cannot sleep', 'nightmare'].includes(term))
            ? 'sleep'
            : 'grounding';
    return { severity: 'wellness', matched: wellness, suggestedTopic, message: null };
  }

  return { severity: 'normal', matched: [], suggestedTopic: null, message: null };
}

const UNSAFE_PATTERNS: readonly RegExp[] = [
  /\b\d+(\.\d+)?\s?(mg|mcg|ml|milligrams?|micrograms?|tablets?|pills?|capsules?)\b/i,
  /\b(take|give)\s+(one|two|three|four|\d+)\s+(tablet|pill|capsule|dose)s?\b/i,
  /\b(you|they)\s+(have|has|are suffering from|might have)\s+(cancer|diabetes|infection|pneumonia|a fracture|concussion)\b/i,
  /\b(antibiotic|antibiotics|morphine|opioid|insulin|epinephrine|adrenaline|steroid)s?\b/i,
  /\b(stop|change)\s+(taking|your)\s+(medication|medicine|insulin|tablets?)\b/i,
  /\b(inject|injection|iv drip|intravenous)\b/i,
  /\b(diagnos(e|is|ed|ing))\b/i,
];

/**
 * A second gate after grounding: even a response that reuses the record's words
 * can smuggle in a dose, a diagnosis, or a new medicine. Those are rejected and
 * the record is shown verbatim instead.
 */
export function containsUnsafeAdvice(response: string): boolean {
  return UNSAFE_PATTERNS.some((pattern) => pattern.test(response));
}
