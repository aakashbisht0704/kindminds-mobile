/**
 * On-device model status.
 *
 * Shruti and Mirage are part of the full install. Bonsai is the only large,
 * optional download; this is the one place a person should have to think about
 * model sizes. No model leaves the phone.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionButton, AppText, Card, ProgressBar } from './ui';
import { releaseLocalModels } from '../services/local-ai';
import { downloadModel, MODEL_URLS } from '../services/downloads';
import { deleteModel, formatModelSize } from '../services/model-pack';
import { BUNDLED_BYTES, installBundledModels } from '../services/bundled-models';
import { useModels, notifyModelsChanged } from '../state/useModels';
import { KINDMINDS_LITE } from '../config';
import { palette, space, type } from '../theme';

export function ModelManager() {
  const models = useModels();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [includedProgress, setIncludedProgress] = useState(0);
  const [installingIncluded, setInstallingIncluded] = useState(false);
  const [textDownloading, setTextDownloading] = useState(false);
  const [textProgress, setTextProgress] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState(0);

  async function installIncluded() {
    if (installingIncluded) return;
    setInstallingIncluded(true);
    setIncludedProgress(0);
    setNotice(null);
    try {
      await installBundledModels((fraction) => setIncludedProgress(fraction));
      notifyModelsChanged();
      setNotice('Shruti and Mirage are ready on this phone.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The included models could not be installed.');
    } finally {
      setInstallingIncluded(false);
    }
  }

  async function installTextModel() {
    if (textDownloading) return;
    setTextDownloading(true);
    setTextProgress(0);
    setNotice(null);
    try {
      await downloadModel(
        'text',
        MODEL_URLS.text.url,
        MODEL_URLS.text.name,
        setTextProgress,
        MODEL_URLS.text.bytes,
        MODEL_URLS.text.sha256,
        (fraction) => {
          setVerifying(true);
          setVerifyProgress(fraction);
        },
      );
      await models.refresh();
      notifyModelsChanged();
      setNotice('Bonsai 2 installed and verified. Questions are now answered from the approved records.');
    } catch (error) {
      // The downloader already returns one plain sentence, and it keeps the
      // partial file, so the next tap continues where this one stopped.
      setNotice(
        `The text model is not installed yet. ${
          error instanceof Error ? error.message : 'Check the connection and tap Download again.'
        }`,
      );
    } finally {
      setTextDownloading(false);
      setVerifying(false);
    }
  }

  async function remove(kind: 'text' | 'voice' | 'vision') {
    const model = models[kind];
    if (!model) return;
    setBusy(kind);
    setNotice(null);
    try {
      await deleteModel(model);
      await releaseLocalModels();
      await models.refresh();
      notifyModelsChanged();
      setNotice(`${model.name} removed.`);
    } finally {
      setBusy(null);
    }
  }

  if (KINDMINDS_LITE) {
    return (
      <View style={styles.wrap}>
        <AppText variant="title">On-device models</AppText>
        <Card>
          <AppText variant="body" color={palette.inkMuted}>
            This build uses approved records and wellbeing tools without local speech or vision
            models. Install the full build to add Shruti, Mirage, and the optional Bonsai text model.
          </AppText>
        </Card>
      </View>
    );
  }

  const includedMissing = !models.voice || !models.vision;

  return (
    <View style={styles.wrap}>
      <AppText variant="title">Shruti + Mirage</AppText>
      <AppText variant="caption" color={palette.inkMuted}>
        Included with this app. Nothing is downloaded in the field and nothing leaves this phone.
      </AppText>

      <Card style={styles.card}>
        <ModelRow
          title="Shruti"
          detail="Voice input · Hindi, Hinglish, Indian English"
          installed={Boolean(models.voice)}
          size={MODEL_URLS.voice.bytes}
        />
        <ModelRow
          title="Mirage"
          detail="Photo labels, signs, and visible hazards"
          installed={Boolean(models.vision)}
          size={MODEL_URLS.vision.bytes}
        />
        {includedMissing ? (
          <>
            {installingIncluded ? <ProgressBar ratio={includedProgress} severity="safe" /> : null}
            <ActionButton
              label={installingIncluded ? 'Installing included models' : 'Install included models'}
              tone="soft"
              busy={installingIncluded}
              onPress={() => void installIncluded()}
            />
          </>
        ) : (
          <View style={styles.installedNote}>
            <Text style={styles.installedText}>{`${formatModelSize(BUNDLED_BYTES)} installed`}</Text>
            <ActionButton
              label={busy === 'voice' || busy === 'vision' ? 'Removing' : 'Remove both'}
              tone="ghost"
              disabled={busy !== null}
              onPress={() => {
                void (async () => {
                  await remove('voice');
                  await remove('vision');
                })();
              }}
            />
          </View>
        )}
      </Card>

      <AppText variant="title" style={styles.textTitle}>Bonsai 2 2B</AppText>
      <AppText variant="caption" color={palette.inkMuted}>
        Optional. Reads the approved records and explains or answers them in English, Hindi or
        Hinglish. It is not a doctor and cannot add advice of its own.
      </AppText>

      <Card style={styles.card}>
        <View style={styles.textHead}>
          <View style={styles.textCopy}>
            <Text style={styles.textDetail}>
              {models.text
                ? `${models.text.name} · ${formatModelSize(models.text.sizeBytes)}`
                : '521 MB download · Apache-2.0 · PrismML Ternary Bonsai 2'}
            </Text>
            <Text style={styles.textHint}>
              {models.text
                ? 'Installed, integrity-checked and ready.'
                : 'Download before an emergency, while you still have a connection.'}
            </Text>
          </View>
          <Text style={[styles.status, { color: models.text ? palette.safe : palette.inkMuted }]}>
            {models.text ? 'Installed' : 'Optional'}
          </Text>
        </View>

        {textDownloading && verifying ? (
          <ProgressBar ratio={verifyProgress} severity="safe" />
        ) : textDownloading ? (
          <ProgressBar ratio={textProgress} severity="safe" />
        ) : null}
        <ActionButton
          label={
            textDownloading && verifying
              ? `Checking model integrity ${Math.round(verifyProgress * 100)}%`
              : textDownloading
                ? `Downloading Bonsai ${Math.round(textProgress * 100)}%`
              : models.text
                ? 'Bonsai is installed'
                : 'Download Bonsai 2 2B'
          }
          tone={models.text ? 'soft' : 'primary'}
          busy={textDownloading}
          disabled={Boolean(models.text)}
          onPress={() => void installTextModel()}
        />
        {models.text ? (
          <ActionButton label="Remove Bonsai" tone="ghost" disabled={busy !== null} onPress={() => void remove('text')} />
        ) : null}
      </Card>

      {notice ? <AppText variant="caption" color={palette.inkMuted}>{notice}</AppText> : null}

      {models.all.length > 0 ? (
        <ActionButton
          label="Free model memory"
          tone="ghost"
          onPress={() => {
            void releaseLocalModels();
            setNotice('Model memory released. Files are still stored on the phone.');
          }}
        />
      ) : null}
    </View>
  );
}

function ModelRow({
  title,
  detail,
  installed,
  size,
}: {
  title: string;
  detail: string;
  installed: boolean;
  size: number;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <Text style={[styles.rowSize, { color: installed ? palette.safe : palette.inkMuted }]}>
        {installed ? 'Ready' : formatModelSize(size)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  card: { gap: space.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { color: palette.ink, fontSize: 16, fontWeight: '700' },
  rowDetail: { color: palette.inkMuted, fontSize: 12, lineHeight: 17 },
  rowSize: { ...type.readout, fontSize: 12, paddingTop: 2 },
  installedNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  installedText: { color: palette.safe, fontSize: 12, fontWeight: '600' },
  textTitle: { marginTop: space.md },
  textHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  textCopy: { flex: 1, gap: 3 },
  textDetail: { color: palette.ink, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  textHint: { color: palette.inkMuted, fontSize: 12, lineHeight: 17 },
  status: { fontSize: 12, fontWeight: '700', paddingTop: 1 },
});
