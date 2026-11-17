/**
 * KindMinds visual language: warm, calm, and legible under stress.
 *
 * The Figma direction is white space, peach-orange primary actions, soft grey
 * secondary surfaces, and a green "you are okay" card. We keep the field-app
 * rules underneath: every status is written in words, every control is at least
 * 44pt, and the palette never carries meaning on its own.
 */
export const palette = {
  canvas: '#FAF7F2',
  surface: '#FFFFFF',
  raised: '#F3EFE9',
  line: '#E8E1D7',
  lineStrong: '#D7CEC1',
  ink: '#1D1B18',
  inkMuted: '#5B564F',
  inkFaint: '#6D665D',
  primary: '#C34B15',
  primaryDeep: '#A63E0E',
  primaryText: '#96370F',
  primaryWash: '#FAE9DE',
  peach: '#FAE9DE',
  cream: '#FBF4EC',
  accent: '#234E82',
  accentDeep: '#183A65',
  accentWash: '#EAF0F8',
  hazard: '#AE2A20',
  hazardDim: '#FBE9E6',
  caution: '#855600',
  cautionDim: '#FBF1DD',
  safe: '#23634B',
  safeDim: '#E6F1EB',
  info: '#234E82',
  infoDim: '#EAF0F8',
  jade: '#23634B',
  jadeDeep: '#1B4C3A',
  jadeWash: '#E6F1EB',
  sand: '#EFE7DB',
} as const;

export type Severity = 'hazard' | 'caution' | 'safe' | 'info' | 'neutral';

export const severityColor: Record<Severity, string> = {
  hazard: palette.hazard,
  caution: palette.caution,
  safe: palette.safe,
  info: palette.info,
  neutral: palette.inkMuted,
};

export const severityWash: Record<Severity, string> = {
  hazard: palette.hazardDim,
  caution: palette.cautionDim,
  safe: palette.safeDim,
  info: palette.infoDim,
  neutral: palette.raised,
};

/** 4px rhythm. Every margin, padding and gap in the app comes from here. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  pill: 999,
} as const;

/**
 * Two voices: the platform sans for everything a person reads, and a monospace
 * readout for anything they might transcribe or compare (coordinates, distances,
 * counters, timers).
 */
export const type = {
  // Numbers that can be compared over time use tabular figures. Everything a
  // person reads uses the platform sans; no decorative monospace.
  readout: {
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
    letterSpacing: 0.1,
  },
  numeric: {
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
  },
  display: {
    fontSize: 32,
    lineHeight: 36,
    fontWeight: '800' as const,
    letterSpacing: -0.8,
  },
  title: { fontSize: 19, lineHeight: 24, fontWeight: '700' as const, letterSpacing: -0.3 },
  body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 24 },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0 },
  caption: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16, letterSpacing: 0 },
} as const;

export const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 } as const;

/** Soft elevation used by cards and the tab bar. */
export const shadow = {
  shadowColor: '#2B241C',
  shadowOpacity: 0.05,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 4 },
  elevation: 2,
} as const;
