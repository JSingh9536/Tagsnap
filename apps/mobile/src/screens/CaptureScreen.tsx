import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import { useAuth } from '../state/auth';
import { useTags } from '../state/tags';
import { enqueue } from '../lib/db';
import { Banner, Button } from '../components/ui';
import { accentFor, colors, radius, space, TOUCH_MIN, type } from '../theme';
import {
  RESCAN_REASON_INSTRUCTION,
  RESCAN_REASON_LABEL,
  payeeForRole,
} from '@tagsnap/shared';

/**
 * Capture.
 *
 * The one rule this screen holds to: a photo the driver has taken is never
 * lost and never blocks on the network. It is written to disk and queued
 * before anything else happens, so the driver can be back in the truck before
 * the upload has even started.
 *
 * Doubles as the rescan screen. When the office sends a tag back, the same
 * camera opens with their reason across the top and the new photo attaches to
 * the existing tag instead of creating another one — which matters, because
 * two tags for one ticket is exactly the duplicate the whole system is built
 * to prevent.
 */

export interface CaptureParams {
  /** Set when answering a rescan. Absent for a new tag. */
  rescanTagId?: string;
  rescanReason?: keyof typeof RESCAN_REASON_LABEL;
  rescanNote?: string | null;
}

export function CaptureScreen({
  route,
  navigation,
}: {
  route: { params?: CaptureParams };
  navigation: { goBack: () => void; navigate: (screen: string) => void };
}) {
  const { profile, portal, confirmIdentity } = useAuth();
  const { refresh, kickSync } = useTags();
  const { width } = useWindowDimensions();

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);

  const params = route.params ?? {};
  const isRescan = Boolean(params.rescanTagId);
  const accent = accentFor(portal);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const shoot = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const shot = await cameraRef.current.takePictureAsync({
        quality: 0.9,
        skipProcessing: false,
      });
      if (!shot?.uri) throw new Error('The camera returned nothing.');
      setPreview(shot.uri);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The camera failed.');
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const keep = useCallback(async () => {
    if (!preview || !profile || busy) return;
    setBusy(true);
    setError(null);

    try {
      // Submitting a tag puts a number on somebody's invoice, so the phone
      // confirms who is holding it. On a device with no enrolled biometric
      // this passes through rather than stranding a driver at a quarry.
      const confirmed = await confirmIdentity(
        isRescan ? 'Confirm this rescan' : 'Confirm this ticket'
      );
      if (!confirmed) {
        setBusy(false);
        return;
      }

      // Resize before it ever touches the queue. A 12 MP phone photo is four
      // times the bytes of what the extractor needs and, on a bar of signal at
      // a quarry, four times as likely to time out.
      const processed = await ImageManipulator.manipulateAsync(
        preview,
        [{ resize: { width: 2000 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      const id = Crypto.randomUUID();
      const dir = `${FileSystem.documentDirectory}tags/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
        () => {
          // Already there.
        }
      );
      const local = `${dir}${id}.jpg`;
      await FileSystem.moveAsync({ from: processed.uri, to: local });

      const where = await captureLocation();

      await enqueue({
        id,
        local_uri: local,
        rescan_for_tag_id: params.rescanTagId ?? null,
        payee_type: payeeForRole(profile.role),
        driver_id: profile.role === 'subhauler' ? null : profile.id,
        subhauler_id: profile.subhauler_id,
        captured_at: new Date().toISOString(),
        captured_lat: where?.lat ?? null,
        captured_lng: where?.lng ?? null,
        note: null,
      });

      // The tag is safe on disk now. Everything past this point is best
      // effort, and none of it is allowed to fail loudly.
      void kickSync();
      void refresh();

      setPreview(null);
      navigation.goBack();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save the photo to this device.'
      );
    } finally {
      setBusy(false);
    }
  }, [
    preview,
    profile,
    busy,
    confirmIdentity,
    isRescan,
    params.rescanTagId,
    kickSync,
    refresh,
    navigation,
  ]);

  if (!permission) {
    return <SafeAreaView style={s.safe} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <View style={s.padded}>
          <Banner
            tone="attention"
            title="TagSnap needs the camera"
            detail="Photographing the scale ticket is the whole job. Without the camera there is nothing to send the office."
            action={
              permission.canAskAgain
                ? { label: 'Allow camera', onPress: () => void requestPermission() }
                : undefined
            }
          />
          {!permission.canAskAgain ? (
            <Text style={s.hint}>
              Turn the camera back on for TagSnap in your phone's Settings.
            </Text>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  // ---- review the shot before it goes anywhere ---------------------------
  if (preview) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <View style={s.previewWrap}>
          <Image
            source={{ uri: preview }}
            style={[s.preview, { width: width - space.md * 2 }]}
            resizeMode="contain"
            accessibilityLabel="The photo you just took"
          />
        </View>

        <View style={s.previewActions}>
          <Text style={s.checkPrompt}>
            Can you read the ticket number and the net weight?
          </Text>
          {error ? <Banner tone="bad" title="Not saved" detail={error} /> : null}
          <Button
            title={isRescan ? 'Send the rescan' : 'Send it'}
            onPress={keep}
            accent={accent}
            loading={busy}
          />
          <Button
            title="Take it again"
            variant="secondary"
            onPress={() => {
              setPreview(null);
              setError(null);
            }}
            disabled={busy}
          />
        </View>
      </SafeAreaView>
    );
  }

  // ---- the camera --------------------------------------------------------
  return (
    <View style={s.cameraRoot}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        autofocus="on"
      />

      <SafeAreaView style={s.overlay} edges={['top', 'bottom']} pointerEvents="box-none">
        {isRescan && params.rescanReason ? (
          <View style={s.rescanBar}>
            <Text style={s.rescanTitle}>
              {RESCAN_REASON_LABEL[params.rescanReason]}
            </Text>
            <Text style={s.rescanBody}>
              {RESCAN_REASON_INSTRUCTION[params.rescanReason]}
            </Text>
            {params.rescanNote ? (
              <Text style={s.rescanNote}>“{params.rescanNote}”</Text>
            ) : null}
          </View>
        ) : (
          <View style={s.tipBar}>
            <Text style={s.tipText}>
              Lay the ticket flat. All four corners in frame. Keep your shadow
              off it.
            </Text>
          </View>
        )}

        <View style={s.frame} pointerEvents="none">
          <Corner style={s.tl} />
          <Corner style={s.tr} />
          <Corner style={s.bl} />
          <Corner style={s.br} />
        </View>

        <View style={s.controls}>
          <Pressable
            onPress={() => setTorch((t) => !t)}
            style={s.smallControl}
            accessibilityRole="button"
            accessibilityLabel={torch ? 'Turn the light off' : 'Turn the light on'}
          >
            <Text style={s.smallControlText}>{torch ? 'Light on' : 'Light'}</Text>
          </Pressable>

          <Pressable
            onPress={shoot}
            disabled={busy}
            style={({ pressed }) => [
              s.shutter,
              { borderColor: accent },
              pressed && { transform: [{ scale: 0.94 }] },
              busy && { opacity: 0.5 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Photograph the ticket"
            testID="shutter"
          >
            <View style={[s.shutterCore, { backgroundColor: accent }]} />
          </Pressable>

          <Pressable
            onPress={navigation.goBack}
            style={s.smallControl}
            accessibilityRole="button"
          >
            <Text style={s.smallControlText}>Cancel</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

function Corner({ style }: { style: object }) {
  return <View style={[s.corner, style]} />;
}

/**
 * Where the photo was taken — at the moment of the photo, and nowhere else.
 *
 * This gives the office a free check that the truck really was at that quarry,
 * which is one of the fields that then does not need a human. Denial is fine
 * and silent: it costs one automatic verification, not the tag.
 *
 * There is deliberately no background location anywhere in this app. Tracking
 * a driver's day changes the app's privacy posture, its store review, and
 * possibly its legal footing, for very little validation benefit.
 */
async function captureLocation(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      const asked = await Location.requestForegroundPermissionsAsync();
      if (asked.status !== 'granted') return null;
    }
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  padded: { padding: space.lg, gap: space.md },
  hint: { ...type.small, color: colors.textMuted, lineHeight: 21 },

  cameraRoot: { flex: 1, backgroundColor: '#000' },
  overlay: { flex: 1, justifyContent: 'space-between' },

  tipBar: {
    margin: space.md,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  tipText: { ...type.small, color: '#fff', textAlign: 'center', lineHeight: 20 },

  rescanBar: {
    margin: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(245,166,35,0.92)',
    gap: 4,
  },
  rescanTitle: { ...type.bodyStrong, color: '#1A1200' },
  rescanBody: { ...type.small, color: '#1A1200', lineHeight: 20 },
  rescanNote: { ...type.small, color: '#1A1200', fontStyle: 'italic', marginTop: 4 },

  frame: {
    position: 'absolute',
    top: '22%',
    bottom: '26%',
    left: '8%',
    right: '8%',
  },
  corner: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderColor: 'rgba(255,255,255,0.85)',
  },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  shutter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  shutterCore: { width: 62, height: 62, borderRadius: 31 },
  smallControl: {
    minWidth: 74,
    minHeight: TOUCH_MIN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallControlText: { ...type.small, color: '#fff', fontWeight: '600' },

  previewWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.md },
  preview: { flex: 1, borderRadius: radius.md, backgroundColor: '#000' },
  previewActions: { padding: space.md, gap: space.sm },
  checkPrompt: {
    ...type.bodyStrong,
    color: colors.text,
    textAlign: 'center',
    marginBottom: space.xs,
  },
});
