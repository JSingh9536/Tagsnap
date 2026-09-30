import React, { useMemo } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../state/auth';
import { useTags } from '../state/tags';
import { Banner, Card, Empty, StatusPill } from '../components/ui';
import { accentFor, colors, radius, space, TOUCH_MIN, type } from '../theme';
import {
  DRIVER_STATUS_LABEL,
  STATUS_TONE,
  formatCents,
  formatDate,
  formatTons,
  type TagWithRelations,
} from '@tagsnap/shared';
import type { OutboxRow } from '../lib/db';

/**
 * My tags.
 *
 * The list is ordered by what the driver needs to do about it, not by date:
 * anything the office sent back sits at the top, because that is the only
 * state where somebody is waiting on them.
 */
export function TagsScreen({
  navigation,
}: {
  navigation: { navigate: (screen: string, params?: object) => void };
}) {
  const { portal } = useAuth();
  const { tags, outbox, loading, online, syncing, error, refresh, rescans } =
    useTags();

  const accent = accentFor(portal);

  const queued = useMemo(
    () => outbox.filter((o) => o.state !== 'sent'),
    [outbox]
  );

  const sent = useMemo(
    () => tags.filter((t) => t.status !== 'rescan_requested'),
    [tags]
  );

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <FlatList
        data={sent}
        keyExtractor={(t) => t.id}
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl
            refreshing={loading && tags.length > 0}
            onRefresh={() => void refresh()}
            tintColor={colors.textMuted}
          />
        }
        ListHeaderComponent={
          <View style={s.header}>
            {!online ? (
              <Banner
                tone="pending"
                title="No signal"
                detail={
                  queued.length > 0
                    ? `${queued.length} ${queued.length === 1 ? 'ticket is' : 'tickets are'} saved on this phone and will send themselves when you have bars.`
                    : 'Keep taking photos. They send themselves when you get bars.'
                }
              />
            ) : null}

            {error ? <Banner tone="bad" title="Could not refresh" detail={error} /> : null}

            {rescans.length > 0 ? (
              <View style={s.section}>
                <Text style={s.sectionTitle}>The office needs a new photo</Text>
                {rescans.map((tag) => (
                  <RescanCard
                    key={tag.id}
                    tag={tag}
                    onPress={() =>
                      navigation.navigate('TagDetail', { tagId: tag.id })
                    }
                  />
                ))}
              </View>
            ) : null}

            {queued.length > 0 ? (
              <View style={s.section}>
                <View style={s.sectionRow}>
                  <Text style={s.sectionTitle}>On this phone</Text>
                  {syncing ? <Text style={s.syncing}>Sending…</Text> : null}
                </View>
                {queued.map((row) => (
                  <QueuedCard key={row.id} row={row} accent={accent} />
                ))}
              </View>
            ) : null}

            {sent.length > 0 ? (
              <Text style={[s.sectionTitle, s.sentTitle]}>Sent</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <TagCard
            tag={item}
            onPress={() => navigation.navigate('TagDetail', { tagId: item.id })}
          />
        )}
        ListEmptyComponent={
          loading ? null : queued.length === 0 && rescans.length === 0 ? (
            <Empty
              title="No tickets yet"
              hint="Photograph the scale ticket when you pull off the scale. It works with no signal — it will send itself later."
            />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function TagCard({
  tag,
  onPress,
}: {
  tag: TagWithRelations;
  onPress: () => void;
}) {
  const paid = tag.status === 'approved' || tag.status === 'invoiced';

  return (
    <Card onPress={onPress} style={s.card}>
      <View style={s.cardTop}>
        <View style={s.cardIdent}>
          <Text style={s.ticket}>
            {tag.ticket_number ? `#${tag.ticket_number}` : 'Reading the ticket…'}
          </Text>
          <Text style={s.quarry}>
            {tag.quarries?.name ?? 'Quarry not matched yet'}
          </Text>
        </View>
        <StatusPill
          label={DRIVER_STATUS_LABEL[tag.status]}
          tone={STATUS_TONE[tag.status]}
        />
      </View>

      <View style={s.cardBottom}>
        <Text style={s.meta}>{formatDate(tag.tag_date ?? tag.created_at)}</Text>
        <Text style={s.dot}>·</Text>
        <Text style={s.meta}>{formatTons(tag.net_tons)}</Text>
        {paid && tag.computed_pay_cents !== null ? (
          <>
            <Text style={s.dot}>·</Text>
            <Text style={s.pay}>{formatCents(tag.computed_pay_cents)}</Text>
          </>
        ) : null}
      </View>
    </Card>
  );
}

function RescanCard({
  tag,
  onPress,
}: {
  tag: TagWithRelations;
  onPress: () => void;
}) {
  const request = tag.rescan_requests?.find(
    (r) => !r.resolved_at && !r.cancelled_at
  );

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [s.rescanCard, pressed && s.rescanPressed]}
    >
      <Text style={s.rescanTitle}>
        {tag.ticket_number ? `Ticket #${tag.ticket_number}` : 'A ticket you sent'}
      </Text>
      <Text style={s.rescanBody}>
        {request?.note ?? 'The office could not use the photo. Tap to retake it.'}
      </Text>
      <Text style={s.rescanCta}>Retake the photo →</Text>
    </Pressable>
  );
}

function QueuedCard({ row, accent }: { row: OutboxRow; accent: string }) {
  const stuck = row.attempts >= 8;

  return (
    <Card style={[s.card, s.queuedCard, { borderLeftColor: accent }]}>
      <View style={s.cardTop}>
        <View style={s.cardIdent}>
          <Text style={s.ticket}>
            {row.rescan_for_tag_id ? 'Rescan' : 'Ticket photo'}
          </Text>
          <Text style={s.quarry}>{formatDate(row.captured_at)}</Text>
        </View>
        <StatusPill
          label={
            stuck
              ? 'Stuck'
              : row.state === 'uploading'
                ? 'Sending'
                : 'Waiting for signal'
          }
          tone={stuck ? 'bad' : 'pending'}
        />
      </View>
      {stuck && row.last_error ? (
        <Text style={s.queuedError}>
          Still on this phone after several tries: {row.last_error}. Tell the
          office — the photo is not lost.
        </Text>
      ) : null}
    </Card>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  list: { padding: space.md, gap: space.sm, paddingBottom: space.xxl },

  header: { gap: space.md },
  section: { gap: space.sm },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  sectionTitle: { ...type.label, color: colors.textFaint },
  sentTitle: { marginTop: space.sm },
  syncing: { ...type.small, color: colors.textFaint },

  card: { gap: space.sm },
  queuedCard: { borderLeftWidth: 4 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  cardIdent: { flex: 1, gap: 2 },
  ticket: { ...type.bodyStrong, color: colors.text },
  quarry: { ...type.small, color: colors.textMuted },

  cardBottom: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { ...type.small, color: colors.textMuted },
  dot: { color: colors.textFaint },
  pay: { ...type.small, color: colors.good, fontWeight: '700' },

  queuedError: { ...type.small, color: colors.bad, lineHeight: 20 },

  rescanCard: {
    minHeight: TOUCH_MIN + 40,
    backgroundColor: `${colors.attention}1F`,
    borderWidth: 1.5,
    borderColor: colors.attention,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.xs,
  },
  rescanPressed: { backgroundColor: `${colors.attention}33` },
  rescanTitle: { ...type.bodyStrong, color: colors.attention },
  rescanBody: { ...type.small, color: colors.text, lineHeight: 21 },
  rescanCta: { ...type.small, color: colors.attention, fontWeight: '700', marginTop: 4 },
});
