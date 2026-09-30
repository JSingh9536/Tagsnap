/**
 * Design tokens.
 *
 * Sized for the actual use: a phone held in one gloved hand, in a truck cab,
 * in daylight that ranges from a dark loading bay to full sun on a windshield.
 * That drives three choices that look heavy-handed on a desktop mockup and are
 * not — large type, high contrast, and touch targets no smaller than 56pt.
 */

export const colors = {
  bg: '#0F1720',
  surface: '#18222E',
  surfaceRaised: '#22303F',
  border: '#2E3E4F',

  text: '#F2F6FA',
  textMuted: '#9DB0C2',
  textFaint: '#67788A',

  // The driver lane and the subhauler lane are colour-coded end to end, so a
  // subhauler running loads for two outfits can tell at a glance which book
  // they are working in.
  driver: '#3FA7F5',
  subhauler: '#F5A623',

  good: '#3FBF6F',
  attention: '#F5A623',
  bad: '#E5484D',
  pending: '#7B8FA3',

  onAccent: '#0B1119',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 34, fontWeight: '700' as const, letterSpacing: -0.5 },
  title: { fontSize: 24, fontWeight: '700' as const },
  heading: { fontSize: 19, fontWeight: '600' as const },
  body: { fontSize: 17, fontWeight: '400' as const },
  bodyStrong: { fontSize: 17, fontWeight: '600' as const },
  small: { fontSize: 15, fontWeight: '400' as const },
  label: {
    fontSize: 13,
    fontWeight: '600' as const,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  },
  /** For tonnage and dollars. Tabular so columns of numbers line up. */
  mono: {
    fontSize: 17,
    // Not `as const` — React Native's TextStyle wants a mutable array here,
    // and a readonly tuple fails to assign.
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
    fontWeight: '600' as const,
  },
};

/** Nothing tappable is smaller than this. Gloves. */
export const TOUCH_MIN = 56;

export function accentFor(portal: 'driver' | 'subhauler' | null): string {
  return portal === 'subhauler' ? colors.subhauler : colors.driver;
}

export const toneColor = {
  pending: colors.pending,
  attention: colors.attention,
  good: colors.good,
  bad: colors.bad,
} as const;
