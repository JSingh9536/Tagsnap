import SwiftUI

/// What you are owed.
///
/// The number people actually open this app for is "approved, not yet
/// invoiced" — the work that is definitely going to be paid but has not been
/// paid yet. It goes at the top in the largest type on the screen.
///
/// Everything here is derived from tags this person can already see, so there
/// is no separate endpoint and no way for it to disagree with the ticket list.
/// A pay figure that contradicts the tickets it came from generates exactly
/// the phone call this app exists to stop.
struct PayView: View {

    @EnvironmentObject private var state: AppState

    @State private var tags: [Tag] = []
    @State private var invoices: [Invoice] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()

                if loading, tags.isEmpty {
                    ProgressView().tint(Theme.driver)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            headline
                            waiting
                            if !invoices.isEmpty { invoiceList }
                            if let error {
                                Text(error).font(.system(size: 14)).foregroundStyle(Theme.bad)
                            }
                            footnote
                        }
                        .padding(20)
                    }
                }
            }
            .navigationTitle("Pay")
            .toolbarBackground(Theme.background, for: .navigationBar)
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private var tint: Color { Theme.tint(for: state.payeeType) }

    private var approvedNotInvoiced: [Tag] {
        tags.filter { $0.status == .approved }
    }

    private var headline: some View {
        Card {
            Text("Approved, not yet invoiced")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.muted)

            Text(Format.cents(approvedNotInvoiced.compactMap(\.computedPayCents).reduce(0, +)))
                .font(.system(size: 46, weight: .heavy, design: .rounded))
                .foregroundStyle(tint)

            Text("\(approvedNotInvoiced.count) load\(approvedNotInvoiced.count == 1 ? "" : "s") · \(Format.tons(approvedNotInvoiced.compactMap(\.netTons).reduce(0, +)))")
                .font(.system(size: 15))
                .foregroundStyle(Theme.muted)

            Text(state.payeeType.ledgerLabel)
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
        }
    }

    private var waiting: some View {
        let pending = tags.filter {
            $0.status != .approved && $0.status != .invoiced && $0.status != .rejected
        }

        return Card {
            Text("Still with the office")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.muted)

            Text("\(pending.count)")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.text)

            Text("Nothing is owed on these until somebody approves them.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var invoiceList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Invoices")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.faint)

            ForEach(invoices) { invoice in
                Card {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(Format.date(invoice.periodStart)) – \(Format.date(invoice.periodEnd))")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Theme.text)
                            Text(invoice.status.rawValue.capitalized)
                                .font(.system(size: 13))
                                .foregroundStyle(invoice.status == .paid ? Theme.good : Theme.muted)
                        }
                        Spacer()
                        Text(Format.cents(invoice.totalCents))
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(Theme.text)
                    }
                }
            }
        }
    }

    private var footnote: some View {
        Text("""
        These figures come from our rate table, not from anything printed on \
        the ticket. The dollar amount on a scale ticket is the quarry billing \
        their customer — it is not what you are paid.
        """)
        .font(.system(size: 13))
        .foregroundStyle(Theme.faint)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func load() async {
        error = nil
        do {
            async let t = API.myTags(limit: 300)
            async let i = API.invoices()
            tags = try await t
            invoices = try await i
        } catch SupabaseError.signedOut {
            await state.signOut()
        } catch {
            self.error = "Could not refresh. Showing what was last loaded."
        }
        loading = false
    }
}
