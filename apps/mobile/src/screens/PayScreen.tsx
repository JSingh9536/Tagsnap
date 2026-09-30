import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../state/auth';
import { useTags } from '../state/tags';
import { fetchMyInvoices } from '../lib/api';
import { Card, Empty, StatusPill } from '../components/ui';
import { accentFor, colors, space, type } from '../theme';
import {
  PAYEE_LEDGER_LABEL,
  formatCents,
  formatDate,
  formatTons,
  type Invoice,
} from '@tagsnap/shared';

/**
 * What is owed.
 *
 * The heading changes with who is looking, because the two are different
 * financial instruments and calling them the same thing causes real confusion
 * at month end: an employee driver is looking at a settlement, a subhauler is
 * looking at what their outfit is owed as a vendor.
 *
 * "Not yet on an invoice" is the number people actually open this screen for —
 * approved work that has not hit a period close yet.
 */
export function PayScreen() {
  const { profile, portal } = useAuth();
  const { tags, refresh, loading } = useTags();
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const accent = accentFor(portal);
  const isSubhauler = profile?.role === 'subhauler';

  useEffect(() => {
    void fetchMyInvoices()
      .then(setInvoices)
      .catch(() => {
        // No signal. The approved-but-uninvoiced figure below still works off
        // the cached tag list, which is the more useful half anyway.
      });
  }, [tags]);

  const pending = useMemo(() => {
    const approved = tags.filter((t) => t.status === 'approved');
    return {
      count: approved.length,
      tons: approved.reduce((sum, t) => sum + Number(t.net_tons ?? 0), 0),
      cents: approved.reduce((sum, t) => sum + (t.computed_pay_cents ?? 0), 0),
    };
  }, [tags]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <FlatList
        data={invoices}
        keyExtractor={(i) => i.id}
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void refresh()}
            tintColor={colors.textMuted}
          />
        }
        ListHeaderComponent={
          <View style={s.header}>
            <Text style={s.title}>
              {isSubhauler ? 'Owed to your outfit' : 'Your settlement'}
            </Text>

            <Card style={[s.pendingCard, { borderColor: accent }]}>
              <Text style={s.pendingLabel}>Approved, not yet invoiced</Text>
              <Text style={[s.pendingAmount, { color: accent }]}>
                {formatCents(pending.cents)}
              </Text>
              <Text style={s.pendingMeta}>
                {pending.count} {pending.count === 1 ? 'load' : 'loads'} ·{' '}
                {formatTons(pending.tons)}
              </Text>
            </Card>

            {profile ? (
              <Text style={s.ledger}>
                {PAYEE_LEDGER_LABEL[
                  isSubhauler ? 'subhauler' : 'employee_driver'
                ]}
                {isSubhauler ? ' — billed from your company to ours' : ''}
              </Text>
            ) : null}

            {invoices.length > 0 ? (
              <Text style={s.sectionTitle}>Past periods</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => <InvoiceCard invoice={item} />}
        ListEmptyComponent={
          <Empty
            title="No invoices yet"
            hint="Approved loads are grouped into an invoice when the office closes the pay period."
          />
        }
      />
    </SafeAreaView>
  );
}

function InvoiceCard({ invoice }: { invoice: Invoice }) {
  const tone =
    invoice.status === 'paid'
      ? 'good'
      : invoice.status === 'void'
        ? 'bad'
        : 'pending';

  return (
    <Card style={s.invoice}>
      <View style={s.invoiceTop}>
        <Text style={s.period}>
          {formatDate(invoice.period_start)} – {formatDate(invoice.period_end)}
        </Text>
        <StatusPill label={invoice.status} tone={tone} />
      </View>
      <Text style={s.total}>{formatCents(invoice.total_cents)}</Text>
    </Card>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  list: { padding: space.md, gap: space.sm, paddingBottom: space.xxl },
  header: { gap: space.md, marginBottom: space.sm },
  title: { ...type.title, color: colors.text },

  pendingCard: { alignItems: 'center', gap: 4, borderWidth: 1.5, paddingVertical: space.lg },
  pendingLabel: { ...type.label, color: colors.textFaint },
  pendingAmount: { ...type.display, fontSize: 40 },
  pendingMeta: { ...type.small, color: colors.textMuted },

  ledger: { ...type.small, color: colors.textFaint, textAlign: 'center' },
  sectionTitle: { ...type.label, color: colors.textFaint, marginTop: space.sm },

  invoice: { gap: space.sm },
  invoiceTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.sm,
  },
  period: { ...type.bodyStrong, color: colors.text, flex: 1 },
  total: { ...type.title, color: colors.text },
});
