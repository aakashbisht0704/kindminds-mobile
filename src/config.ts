/**
 * Build-time feature flags.
 *
 * `EXPO_PUBLIC_KINDMINDS_LITE=1` builds a small app with the map, mesh, SOS,
 * records, and wellbeing tools but without the on-device AI native libraries.
 * The full build keeps the local text/voice models.
 */
export const KINDMINDS_LITE = process.env.EXPO_PUBLIC_KINDMINDS_LITE === '1';
