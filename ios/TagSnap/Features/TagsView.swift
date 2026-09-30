import SwiftUI

/// Every ticket this person has filed, newest first, with anything the office
/// is waiting on pinned to the top.
///
/// Read-only by design. A submitter who can edit their own tonnage after the
/// fact is threat #1 in `Trucktags/docs/SECURITY.md`, and the RLS policy would
/// refuse the write anyway — but the screen should not offer it either, or
/// somebody will spend a morning trying.
struct TagsView: View {

    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var uploader: Uploader

    @Binding var openTagId: String?

    @State private var tags: [Tag] = []
    @State private var loading = true
    @State private var error: String?

    /// A tapped notification names a ticket; this drives the push onto it.
    private var notificationOpened: Binding<Bool> {
        Binding(
            get: { openTagId != nil },
            set: { if !$0 { openTagId = nil } }
        )
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()
                content
            }
            .navigationTitle("Tickets")
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    NavigationLink { AccountView() } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            // `navigationDestination(item:)` would be tidier but is iOS 17.
            // The deployment target is 16 so that a five-year-old handset in a
            // truck cab still runs this, which matters more than the syntax.
            .navigationDestination(isPresented: notificationOpened) {
                if let openTagId { TagDetailView(tagId: openTagId) }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    @ViewBuilder private var content: some View {
        if loading, tags.isEmpty {
            ProgressView().tint(Theme.driver)
        } else if tags.isEmpty, uploader.pendingCount == 0 {
            empty
        } else {
            List {
                if uploader.pendingCount > 0 { queuedSection }
                if !rescans.isEmpty { section("Waiting on you", rescans) }
                if !rest.isEmpty { section("Filed", rest) }

                if let error {
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.bad)
                        .listRowBackground(Theme.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    private var rescans: [Tag] { tags.filter { $0.status == .rescanRequested } }
    private var rest: [Tag] { tags.filter { $0.status != .rescanRequested } }

    private func section(_ title: String, _ rows: [Tag]) -> some View {
        Section {
            ForEach(rows) { tag in
                NavigationLink {
                    TagDetailView(tagId: tag.id)
                } label: {
                    TagRow(tag: tag)
                }
                .listRowBackground(Theme.surface)
            }
        } header: {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.faint)
        }
    }

    /// Captures still on the phone.
    ///
    /// Shown as one line rather than as individual rows: a driver who took
    /// eight tickets in a dead zone wants to know that eight are safe, not to
    /// scroll through eight identical grey placeholders.
    private var queuedSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: uploader.isOnline ? "arrow.up.circle" : "wifi.slash")
                    .font(.system(size: 22))
                    .foregroundStyle(uploader.isOnline ? Theme.driver : Theme.pending)

                VStack(alignment: .leading, spacing: 3) {
                    Text("\(uploader.pendingCount) on this phone")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text(uploader.isSyncing ? "Sending…"
                         : uploader.isOnline ? "Will send shortly."
                         : "Saved. They go up when you have signal.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.muted)
                }

                Spacer()

                if uploader.isOnline, !uploader.isSyncing {
                    Button("Send") { Task { await uploader.sync(); await load() } }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.driver)
                }
            }
            .padding(.vertical, 4)
            .listRowBackground(Theme.surface)
        }
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.text.viewfinder")
                .font(.system(size: 44))
                .foregroundStyle(Theme.faint)
            Text("Nothing here yet")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text("Photograph a ticket on the Capture tab and it will show up here.")
                .font(.system(size: 15))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private func load() async {
        error = nil
        do {
            tags = try await API.myTags()
        } catch SupabaseError.signedOut {
            await state.signOut()
        } catch {
            // A failed refresh in a dead zone is normal, not an incident. Keep
            // whatever is already on screen and say so quietly.
            self.error = uploader.isOnline
                ? (error as? LocalizedError)?.errorDescription ?? "Could not refresh."
                : "No signal. Showing what was last loaded."
        }
        loading = false
    }
}

struct TagRow: View {
    let tag: Tag

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(tag.ticketNumber.map { "Ticket #\($0)" } ?? "No ticket number yet")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.text)

                HStack(spacing: 8) {
                    Text(Format.date(tag.tagDate ?? tag.createdAt))
                    if let quarry = tag.quarries?.name {
                        Text("·")
                        Text(quarry).lineLimit(1)
                    }
                }
                .font(.system(size: 14))
                .foregroundStyle(Theme.muted)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 6) {
                StatusPill(status: tag.status)
                Text(tag.netTons.map { Format.tons($0) } ?? "—")
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(.vertical, 6)
    }
}
