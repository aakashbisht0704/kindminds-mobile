/**
 * Licences and attribution.
 *
 * The model weights and the inference engine were written by other people, and
 * Apache-2.0/MIT both require that the licence and the publisher's NOTICE travel
 * with the binary. This screen is that obligation met in the product itself, not
 * only in the repository: it works with no network, which is the whole point of
 * the app.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionButton, AppText, Card, Divider, SectionLabel } from './ui';
import { ATTRIBUTIONS, ATTRIBUTION_SUMMARY, type Attribution } from '../core/ai/attribution';
import { APACHE2, BONSAI_NOTICE, LLAMACPP } from '../core/ai/licences.generated';
import { palette, space } from '../theme';

type LicenceText = { id: string; title: string; body: string };

const LICENCE_TEXTS: readonly LicenceText[] = [
  { id: 'apache2', title: 'Apache License 2.0 (Bonsai 2, Shruti, Mirage)', body: APACHE2 },
  { id: 'notice', title: 'Bonsai 2 NOTICE (Prism ML)', body: BONSAI_NOTICE },
  { id: 'mit', title: 'MIT licence (llama.cpp)', body: LLAMACPP },
];

export function Licences() {
  const [open, setOpen] = useState(false);
  const [openText, setOpenText] = useState<string | null>(null);

  return (
    <View style={styles.wrap}>
      <ActionButton
        label={open ? 'Hide licences' : 'Licences and attribution'}
        tone="ghost"
        accessibilityHint="Shows the model authors, licences, and full licence texts"
        onPress={() => setOpen((current) => !current)}
      />
      {open ? (
        <>
          <AppText variant="caption" color={palette.inkMuted}>
            {ATTRIBUTION_SUMMARY}
          </AppText>
          {ATTRIBUTIONS.map((entry) => (
            <AttributionRow key={entry.id} entry={entry} />
          ))}
          <Divider />
          <SectionLabel>Full licence texts</SectionLabel>
          {LICENCE_TEXTS.map((text) => (
            <View key={text.id} style={styles.textBlock}>
              <ActionButton
                label={openText === text.id ? `Hide ${text.title}` : `Read ${text.title}`}
                tone="ghost"
                onPress={() => setOpenText((current) => (current === text.id ? null : text.id))}
              />
              {openText === text.id ? (
                <Card style={styles.textCard}>
                  <ScrollView style={styles.textScroll} nestedScrollEnabled>
                    <Text style={styles.licenceBody}>{text.body}</Text>
                  </ScrollView>
                </Card>
              ) : null}
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}

function AttributionRow({ entry }: { entry: Attribution }) {
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <View style={styles.headCopy}>
          <Text style={styles.name}>{entry.name}</Text>
          <Text style={styles.role}>{entry.role}</Text>
        </View>
        <Text style={styles.licence}>{entry.licence}</Text>
      </View>
      <Text style={styles.detail}>{entry.copyright}</Text>
      <Text style={styles.detail}>{entry.version}</Text>
      {entry.notice ? <Text style={styles.notice}>{`“${entry.notice}”`}</Text> : null}
      <Text style={styles.detail}>{entry.obligations}</Text>
      <Text style={styles.source}>{entry.source}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  card: { gap: 3 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  headCopy: { flex: 1, gap: 2 },
  name: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  role: { color: palette.inkMuted, fontSize: 12, lineHeight: 17 },
  licence: { color: palette.inkMuted, fontSize: 12, fontWeight: '600', paddingTop: 1 },
  detail: { color: palette.inkMuted, fontSize: 11, lineHeight: 16 },
  notice: { color: palette.ink, fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  source: { color: palette.accent, fontSize: 11, lineHeight: 16 },
  textBlock: { gap: space.xs },
  textCard: { padding: space.sm },
  textScroll: { maxHeight: 260 },
  licenceBody: { color: palette.inkMuted, fontSize: 10, lineHeight: 15, fontFamily: 'monospace' },
});
