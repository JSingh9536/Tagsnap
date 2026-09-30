import React, { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../state/auth';
import { useTags } from '../state/tags';
import { currentImage, openRescan, signedImageUrl } from '../lib/api';
import { Banner, Button, Card, Field, Spinner, StatusPill } from '../components/ui';
import { accentFor, colors, radius, space, type } from '../theme';
import {
  DRIVER_STATUS_LABEL,
  PAYEE_LEDGER_LABEL,
  RESCAN_REASON_INSTRUCTION,
  RESCAN_REASON_LABEL,
  STATUS_TONE,
  formatCents,
  formatDate,
  formatTons,
} from '@tagsnap/shared';

/**
 * One tag, from the field's point of view.
 *
 * Shows what the office sees, and no more. Deliberately read-only: a driver
 * cannot edit a tag after submitting it, because a submitter who can change
 * the tonnage after the fact is threat #1 in the security doc. The one action
 * available here is the rescan, and that only exists when the office asked for
 * it.
 */
export function TagDetailScreen({
  route,
  navigation,
}: {
  route: { params: { tagId: string } };
  navigation: { navigate: (screen: string, params?: object) => void };
}) {
  const { portal } = useAuth();
  const { tags } = useTags();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const tag = tags.find((t) => t.id === route.params.tagId);
  const accent = accentFor(portal);
  const image = tag ? currentImage(tag) : null;
  const rescan = tag ? openRescan(tag) : null;

  useEffect(() => {
    let cancelled = false;
    if (!image) return;

    void (async () => {
      try {
        const url = await signedImageUrl(image.image_path);
        if (!cancelled) setImageUrl(url);
      } catch (err) {
        if (!cancelled) {
          setImageError(err instanceof Error ? err.message : 'Could not load it.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [image]);

  if (!tag) {
    return (
      <SafeAreaView style={s.safe}>
        <Spinner label="Loading the ticket…" />
      </SafeAreaView>
    );
  }

  const frozen = tag.status === 'approved' || tag.status === 'invoiced';

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={s.container}>
        <View style={s.head}>
          <Text style={s.ticket}>
            {tag.ticket_number ? `#${tag.ticket_number}` : 'Not read yet'}
          </Text>
          <StatusPill
            label={DRIVER_STATUS_LABEL[tag.status]}
            tone={STATUS_TONE[tag.status]}
          />
        </View>

        {rescan ? (
          <View style={s.rescanBlock}>
            <Text style={s.rescanHead}>{RESCAN_REASON_LABEL[rescan.reason]}</Text>
            <Text style={s.rescanBody}>
              {RESCAN_REASON_INSTRUCTION[rescan.reason]}
            </Text>
            {rescan.note ? (
              <Text style={s.rescanNote}>From the office: “{rescan.note}”</Text>
            ) : null}
            <Button
              title="Retake the photo"
              accent={colors.attention}
              onPress={() =>
                navigation.navigate('Capture', {
                  rescanTagId: tag.id,
                  rescanReason: rescan.reason,
                  rescanNote: rescan.note,
                })
              }
              style={s.rescanButton}
            />
          </View>
        ) : null}

        {tag.status === 'rejected' ? (
          <Banner
            tone="bad"
            title="This ticket was rejected"
            detail={
              tag.rejected_reason ??
              'The office rejected it. Ask them if you think that is wrong.'
            }
          />
        ) : null}

        <Card style={s.imageCard}>
          {imageUrl ? (
            <Image
              source={{ uri: imageUrl }}
              style={s.image}
              resizeMode="contain"
              accessibilityLabel="The scale ticket you photographed"
            />
          ) : imageError ? (
            <Text style={s.imageError}>{imageError}</Text>
          ) : (
            <Spinner label="Loading the photo…" />
          )}
          {tag.rescan_count > 0 ? (
            <Text style={s.imageMeta}>
              Version {(image?.version ?? 1)} — retaken{' '}
              {tag.rescan_count === 1 ? 'once' : `${tag.rescan_count} times`}
            </Text>
          ) : null}
        </Card>

        <Card style={s.fields}>
          <View style={s.fieldRow}>
            <Field label="Date" value={formatDate(tag.tag_date)} />
            <Field label="Quarry" value={tag.quarries?.name ?? '—'} />
          </View>
          <View style={s.fieldRow}>
            <Field label="Material" value={tag.materials?.name ?? '—'} />
            <Field label="Job" value={tag.jobs?.name ?? '—'} />
          </View>
          <View style={s.fieldRow}>
            <Field label="Truck" value={tag.trucks?.number ?? '—'} />
            <Field label="Net" value={formatTons(tag.net_tons)} emphasis />
          </View>
        </Card>

        {frozen ? (
          <Card style={[s.payCard, { borderColor: colors.good }]}>
            <Text style={s.payLabel}>
              {PAYEE_LEDGER_LABEL[tag.payee_type]}
            </Text>
            <Text style={s.payAmount}>{formatCents(tag.computed_pay_cents)}</Text>
            <Text style={s.payNote}>
              {tag.status === 'invoiced'
                ? 'On your invoice. Approved and locked.'
                : 'Approved and locked. It lands on your next invoice.'}
            </Text>
          </Card>
        ) : (
          <Text style={s.pendingNote}>
            The amount appears once the office approves it. What the quarry
            printed on the ticket is what they bill the customer — it is not
            what you are paid.
          </Text>
        )}

        <View style={s.trail}>
          <Text style={s.trailLine}>Sent {formatDate(tag.created_at)}</Text>
          {tag.approved_at ? (
            <Text style={s.trailLine}>Approved {formatDate(tag.approved_at)}</Text>
          ) : null}
          <Text style={[s.trailLine, { color: accent }]}>
            {PAYEE_LEDGER_LABEL[tag.payee_type]}
            {tag.subhaulers ? ` — ${tag.subhaulers.name}` : ''}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: space.md, gap: space.md, paddingBottom: space.xxl },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  ticket: { ...type.title, color: colors.text },

  rescanBlock: {
    backgroundColor: `${colors.attention}1F`,
    borderWidth: 1.5,
    borderColor: colors.attention,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.xs,
  },
  rescanHead: { ...type.heading, color: colors.attention },
  rescanBody: { ...type.body, color: colors.text, lineHeight: 23 },
  rescanNote: { ...type.small, color: colors.textMuted, fontStyle: 'italic' },
  rescanButton: { marginTop: space.sm },

  imageCard: { padding: space.sm, gap: space.sm },
  image: { width: '100%', height: 340, borderRadius: radius.sm, backgroundColor: '#000' },
  imageError: { ...type.small, color: colors.bad, padding: space.md, textAlign: 'center' },
  imageMeta: { ...type.small, color: colors.textFaint, textAlign: 'center' },

  fields: { gap: space.md },
  fieldRow: { flexDirection: 'row', gap: space.lg },

  payCard: { alignItems: 'center', gap: 4, borderWidth: 1.5 },
  payLabel: { ...type.label, color: colors.textFaint },
  payAmount: { ...type.display, color: colors.good },
  payNote: { ...type.small, color: colors.textMuted, textAlign: 'center' },

  pendingNote: {
    ...type.small,
    color: colors.textFaint,
    lineHeight: 21,
    paddingHorizontal: space.xs,
  },

  trail: { gap: 2, paddingTop: space.sm },
  trailLine: { ...type.small, color: colors.textFaint },
});
