/**
 * On-device retrieval over the offline knowledge base.
 *
 * The rule that governs this file: the assistant may never invent first-aid
 * advice. It can only return a record that already exists in
 * `KNOWLEDGE_BASE`, in the order that record defines. Everything here is
 * lexical retrieval (BM25 with a field boost), so it costs no battery, needs no
 * model file, works on a device that has never had a network, and is fully
 * deterministic enough to unit test.
 */

import { KNOWLEDGE_BASE, type KnowledgeEntry, type TopicId } from '../knowledge';

const K1 = 1.2;
const B = 0.75;

/** Field weights: a title hit means far more than a stray keyword hit. */
const FIELD_WEIGHT = { title: 3, keyword: 2.2, summary: 1.4, step: 1 } as const;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'do', 'does', 'i', 'we', 'you', 'my', 'me', 'and', 'or',
  'of', 'to', 'in', 'on', 'for', 'with', 'what', 'how', 'should', 'can', 'if', 'it', 'that', 'this',
  'be', 'been', 'was', 'were', 'have', 'has', 'had', 'will', 'would', 'there', 'their', 'them',
  'get', 'got', 'need', 'want', 'please', 'help', 'somebody', 'someone', 'anyone', 'body',
]);

/**
 * Tiny suffix stemmer, not a linguistics project. Field reports use "bleeding",
 * "bleeds", "bled"; the index must collapse those to one term.
 */
export function stem(token: string): string {
  // Only English is stemmed. Hindi/Hinglish alias terms are kept verbatim.
  if (!/^[a-z0-9]+$/.test(token)) return token;
  if (token.length <= 3) return token;
  const irregular: Record<string, string> = { bleeding: 'bleed', bled: 'bleed', burns: 'burn', burnt: 'burn' };
  const direct = irregular[token];
  if (direct) return direct;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Devanagari letters are single tokens, so the split is Unicode-aware. */
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

type IndexedField = { terms: Map<string, number>; length: number };

type IndexedDoc = {
  entry: KnowledgeEntry;
  fields: Record<keyof typeof FIELD_WEIGHT, IndexedField>;
  totalLength: number;
};

function indexField(text: string): IndexedField {
  const terms = new Map<string, number>();
  let length = 0;
  for (const token of tokenize(text)) {
    terms.set(token, (terms.get(token) ?? 0) + 1);
    length += 1;
  }
  return { terms, length };
}

/**
 * Human-written Hindi and Hinglish search terms, one short list per record.
 *
 * The records themselves are English because the approved guidance is English;
 * this table is only the retrieval bridge, so someone typing "khoon beh raha
 * hai" lands on the bleeding record instead of nothing. It is deliberately
 * small and reviewed: no machine translation, no generated synonyms.
 */
export const HINDI_ALIASES: Partial<Record<TopicId, string[]>> = {
  bleeding: ['खून', 'खून बहना', 'घाव', 'ज़ख्म', 'khoon', 'khoon beh raha', 'ghaav', 'jakhm', 'zakhm'],
  cpr: ['सांस नहीं', 'बेहोश', 'सीपीआर', 'saans nahi', 'behosh', 'cpr', 'dhadkan'],
  breathing: ['सांस लेने', 'सांस', 'दम', 'saans', 'dam', 'saans lene mein dikkat'],
  shock: ['सदमा', 'शॉक', 'बेहोशी', 'sadma', 'shock', 'behoshi'],
  fracture: ['हड्डी', 'हड्डी टूट', 'फ्रैक्चर', 'haddi', 'haddi toot gayi', 'fracture'],
  burns: ['जलना', 'जलन', 'आग से जला', 'jalna', 'jalan', 'aag se jal gaya'],
  'head-injury': ['सिर', 'सिर की चोट', 'sir', 'sir par chot', 'sir mein chot'],
  hypothermia: ['ठंड', 'सर्दी', 'ठंड लगना', 'thand', 'sardi', 'thand lag gayi'],
  heat: ['लू', 'गर्मी', 'धूप', 'loo', 'garmi', 'dhoop'],
  choking: ['गला', 'दम घुटना', 'gala', 'gala phans gaya', 'dam ghut raha'],
  water: ['पानी', 'पीने का पानी', 'पानी साफ', 'paani', 'pani', 'peene ka paani', 'paani saaf'],
  food: ['खाना', 'भोजन', 'khana', 'bhojan', 'khane ki cheez'],
  shelter: ['आश्रय', 'घर', 'aashray', 'ghar', 'rehne ki jagah'],
  fire: ['आग', 'आग लग', 'aag', 'aag lag gayi', 'jal raha'],
  sanitation: ['शौचालय', 'सफाई', 'शौच', 'shauchalay', 'safai', 'toilet'],
  earthquake: ['भूकंप', 'भूकम्प', 'bhookamp', 'bhukamp', 'zameen hil'],
  flood: ['बाढ़', 'पानी भर', 'baadh', 'badh', 'paani bhar gaya', 'baad'],
  cyclone: ['तूफान', 'चक्रवात', 'toofan', 'tufan', 'chakravat', 'hawa'],
  wildfire: ['जंगल की आग', 'जंगल', 'jungle', 'jungle mein aag', 'forest'],
  panic: ['घबराहट', 'डर', 'ghabrahat', 'dar', 'darr', 'panic'],
  grief: ['दुख', 'शोक', 'मौत', 'dukh', 'kisi ki maut', 'shok'],
  grounding: ['शांत', 'खुद को शांत', 'shaant', 'khud ko shaant', 'sukoon'],
  sleep: ['नींद', 'सो नहीं', 'neend', 'so nahi pa raha', 'need'],
  anger: ['गुस्सा', 'क्रोध', 'gussa', 'krodh'],
  loneliness: ['अकेला', 'अकेलापन', 'akela', 'akelapan', 'alone'],
  children: ['बच्चे', 'बच्चा', 'bacche', 'bachcha', 'bacche kaise'],
  signal: ['सिग्नल', 'फोन', 'नेटवर्क', 'signal', 'phone', 'network'],
  power: ['बैटरी', 'चार्ज', 'battery', 'charge', 'bijli'],
};

function buildIndex(entries: readonly KnowledgeEntry[]): { docs: IndexedDoc[]; df: Map<string, number>; avgLength: number } {
  const docs: IndexedDoc[] = entries.map((entry) => {
    const fields = {
      title: indexField(entry.title),
      keyword: indexField([...entry.keywords, ...(HINDI_ALIASES[entry.id] ?? [])].join(' ')),
      summary: indexField(entry.summary),
      step: indexField(entry.steps.map((step) => step.text).join(' ')),
    };
    const totalLength = fields.title.length + fields.keyword.length + fields.summary.length + fields.step.length;
    return { entry, fields, totalLength };
  });

  const df = new Map<string, number>();
  for (const doc of docs) {
    const unique = new Set<string>();
    for (const field of Object.values(doc.fields)) {
      for (const term of field.terms.keys()) unique.add(term);
    }
    for (const term of unique) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const avgLength = docs.length === 0 ? 1 : docs.reduce((sum, doc) => sum + doc.totalLength, 0) / docs.length;
  return { docs, df, avgLength };
}

const INDEX = buildIndex(KNOWLEDGE_BASE);

export type SearchHit = {
  entry: KnowledgeEntry;
  score: number;
  /** Which query terms actually landed, used to explain the match in the UI. */
  matchedTerms: string[];
};

function idf(term: string, docCount: number): number {
  const df = INDEX.df.get(term) ?? 0;
  return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
}

export function search(query: string, limit = 3): SearchHit[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const docCount = INDEX.docs.length;
  const scored: SearchHit[] = [];

  for (const doc of INDEX.docs) {
    let score = 0;
    const matched = new Set<string>();

    for (const term of queryTerms) {
      const weight = idf(term, docCount);
      for (const [fieldName, weightValue] of Object.entries(FIELD_WEIGHT) as [
        keyof typeof FIELD_WEIGHT,
        number,
      ][]) {
        const field = doc.fields[fieldName];
        const tf = field.terms.get(term);
        if (!tf) continue;
        matched.add(term);
        const norm = 1 - B + B * (doc.totalLength / INDEX.avgLength);
        score += weightValue * weight * ((tf * (K1 + 1)) / (tf + K1 * norm));
      }
    }

    if (score <= 0) continue;
    // Urgency is a tiebreaker only: a lifesaving record outranks a calmer match.
    scored.push({ entry: doc.entry, score: score + doc.entry.urgency * 0.35, matchedTerms: [...matched] });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function findById(id: TopicId): KnowledgeEntry | undefined {
  return KNOWLEDGE_BASE.find((entry) => entry.id === id);
}

export type AssistantAnswer = {
  /** Records the answer was assembled from. Always non-empty when grounded. */
  sources: KnowledgeEntry[];
  /** The primary record, whose steps are authoritative. */
  primary: KnowledgeEntry;
  confident: boolean;
  /** Set when retrieval found nothing: the UI must show the browse fallback. */
  handoff: string | null;
};

/**
 * A hit is "confident" only if it matched at least two distinct query terms or
 * landed on a title keyword. One stray term is not grounds for medical advice.
 */
const CONFIDENCE_THRESHOLD = 3.2;

export function answer(query: string): AssistantAnswer | null {
  const hits = search(query, 2);
  const top = hits[0];
  if (!top) return null;
  const confident = top.score >= CONFIDENCE_THRESHOLD || top.matchedTerms.length >= 2;
  return {
    sources: hits.map((hit) => hit.entry),
    primary: top.entry,
    confident,
    handoff: confident ? null : 'No matching record. Browse the categories instead.',
  };
}

/** Suggested quick actions, ordered by how often they are needed in the first hour. */
export const QUICK_PROMPTS: readonly { label: string; query: string }[] = [
  { label: 'Someone is bleeding badly', query: 'severe bleeding pressure' },
  { label: 'Not breathing', query: 'not breathing cpr' },
  { label: 'How do I make water safe?', query: 'safe drinking water boil' },
  { label: 'A building collapsed', query: 'earthquake trapped rubble' },
  { label: "I can't stop shaking", query: 'panic attack breathing' },
  { label: 'Phone battery is dying', query: 'battery power save' },
  { label: "I can't sleep", query: 'sleep insomnia night' },
  { label: 'I feel alone', query: 'lonely alone connection' },
  { label: 'I am so angry', query: 'anger furious unfair' },
] as const;
