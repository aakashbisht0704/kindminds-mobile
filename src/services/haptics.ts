/**
 * Subtle, best-effort touch confirmation.
 *
 * Haptics are a confirmation layer, never the only feedback: every control
 * still changes visually on press. A device without a vibrator stays silent.
 */
import * as Haptics from 'expo-haptics';

export function tapFeedback(): void {
  void Haptics.selectionAsync().catch(() => {});
}
