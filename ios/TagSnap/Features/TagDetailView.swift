import SwiftUI

/// One ticket, as filed.
///
/// Deliberately flat: the photo, what was read off it, where it is in the
/// process, and — if the office has sent it back — one button that opens the
/// camera with the reason printed across it.
///
/// Nothing here is editable. The values shown are what the office is looking
/// at, and if they are wrong the fix is a correction on the review screen by
/// somebody who is not the person being paid for the load.
struct TagDetailView: View {

    let tagId: String

    @State private var tag: Tag?
    @State private var imageURL: URL?
    @State private var loading = true
    @State private var error: String?
    @State private var showRetake = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            if loading {
                ProgressView().tint(Theme.driver)
            } else if let tag {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let rescan = tag.openRescan { rescanCard(tag, rescan) }

                        photo

                        status(tag)
                        fields(tag)

                        if tag.status == .approved || tag.status == .invoiced {
                            approved(tag)
                        }

                        if let notes = tag.reviewNotes, !notes.isEmpty {
                            Card {
                                Text("From the office")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Theme.faint)
                                Text(notes)
                                    .font(.system(size: 16))
                                    .foregroundStyle(Theme.text)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(20)
                }
            } else if let error {
                Text(error).foregroundStyle(Theme.bad).padding()
            }
        }
        .navigationTitle(tag?.ticketNumber.map { "#\($0)" } ?? "Ticket")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .fullScreenCover(isPresented: $showRetake) {
            if let tag {
                NavigationStack {
                    CaptureView(rescanFor: tag)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Cancel") { showRetake = false }
                            }
                        }
                }
            }
        }
    }

    // MARK: - Pieces

    @ViewBuilder private var photo: some View {
        if let imageURL {
            AsyncImage(url: imageURL) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .failure:
                    placeholder("Could not load the photo")
                default:
                    placeholder("Loading the photo…")
                }
            }
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        } else {
            placeholder("The photo has not reached the office yet")
        }
    }

    private func placeholder(_ text: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.surface)
            Text(text).font(.system(size: 14)).foregroundStyle(Theme.faint)
        }
        .frame(height: 200)
    }

    private func rescanCard(_ tag: Tag, _ rescan: RescanRequestRow) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Retake this one", systemImage: "arrow.uturn.backward")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.attention)

            Text(rescan.reason.label)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Theme.text)

            Text(rescan.note ?? rescan.reason.instruction)
                .font(.system(size: 17))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)

            Button("Open the camera") { showRetake = true }
                .buttonStyle(PrimaryButton(tint: Theme.attention))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.attention.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(Theme.attention.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }

    private func status(_ tag: Tag) -> some View {
        Card {
            HStack {
                StatusPill(status: tag.status)
                Spacer()
                Text(tag.payeeType.ledgerLabel)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.faint)
            }

            Text(explain(tag))
                .font(.system(size: 15))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func fields(_ tag: Tag) -> some View {
        Card {
            Text("What was read")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.faint)

            row("Ticket", tag.ticketNumber ?? "—")
            row("Date", Format.date(tag.tagDate))
            row("Quarry", tag.quarries?.name ?? "—")
            row("Material", tag.materials?.name ?? "—")
            row("Job", tag.jobs?.name ?? "—")
            row("Truck", tag.trucks?.number ?? "—")

            Divider().overlay(Theme.line)

            row("Gross", Format.tons(tag.grossTons))
            row("Tare", Format.tons(tag.tareTons))
            row("Net", Format.tons(tag.netTons), emphasised: true)

            if tag.engine != nil {
                Text(readBy(tag))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
                    .padding(.top, 2)
            }
        }
    }

    private func approved(_ tag: Tag) -> some View {
        Card {
            Text("Approved")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.faint)
            Text(Format.cents(tag.computedPayCents))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.good)
            Text(tag.status == .invoiced
                 ? "On your invoice."
                 : "Frozen. It will land on your next invoice.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.muted)
        }
    }

    private func row(_ label: String, _ value: String, emphasised: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 15))
                .foregroundStyle(Theme.muted)
            Spacer()
            Text(value)
                .font(.system(
                    size: emphasised ? 20 : 16,
                    weight: emphasised ? .bold : .regular,
                    design: .monospaced
                ))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.trailing)
        }
    }

    /// What the status means for this person, in their terms.
    private func explain(_ tag: Tag) -> String {
        switch tag.status {
        case .queued: return "Saved on your phone. It goes up when you have signal."
        case .uploaded: return "The office has your photo. Nothing has read it yet."
        case .extracted: return "Being checked."
        case .needsReview: return "The office is looking at this one."
        case .ready: return "Waiting for someone in the office to approve it."
        case .rescanRequested: return "The office needs a new photo of this ticket."
        case .approved: return "Approved and frozen. Nothing changes it from here."
        case .invoiced: return "On an invoice."
        case .rejected:
            return tag.rejectedReason.map { "Rejected: \($0)" } ?? "Rejected."
        }
    }

    private func readBy(_ tag: Tag) -> String {
        let engine: String
        switch tag.engine {
        case .appleVision: engine = "read on your phone"
        case .mlkit: engine = "read on the phone"
        case .tesseract: engine = "read in the office"
        case .officeManual: engine = "typed in by the office"
        case .quarryFeed: engine = "sent by the quarry"
        case .none: engine = "not read yet"
        }
        guard let ms = tag.ocrMs, ms > 0 else { return engine.capitalizedFirst }
        return "\(engine.capitalizedFirst), \(ms) ms"
    }

    private func load() async {
        do {
            let fetched = try await API.tag(id: tagId)
            tag = fetched
            if let path = fetched?.currentImage?.imagePath {
                imageURL = try? await Supabase.shared.signedImageURL(path: path)
            }
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription
                ?? "Could not load that ticket."
        }
        loading = false
    }
}

private extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
