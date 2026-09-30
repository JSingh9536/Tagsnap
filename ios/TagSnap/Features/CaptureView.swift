import SwiftUI
import UIKit

/// The screen the app exists for.
///
/// One button. Everything after the shutter happens without asking:
///
///   1. straighten and shrink the image
///   2. write the JPEG to disk
///   3. read it with Vision — **on the device, with no network**
///   4. fingerprint it
///   5. queue it
///
/// The whole sequence takes under a second and none of it needs a signal. That
/// last point is the difference the on-device reader made: a driver in a pit
/// with no bars now learns immediately that their photo was unreadable, while
/// retaking it is free. Under the old server-side reader they found out hours
/// later, from an office phone call, having long since left the quarry.
struct CaptureView: View {

    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var uploader: Uploader
    @StateObject private var location = LocationProvider.shared

    /// Set when the office has sent a specific ticket back. The reason is
    /// printed across this screen while the driver retakes it.
    ///
    /// Explicitly defaulted rather than relying on the implicit nil for an
    /// optional `var`, so `CaptureView()` in the tab bar reads as deliberate
    /// rather than as something that happens to compile.
    var rescanFor: Tag? = nil

    @State private var showCamera = false
    @State private var result: CaptureResult?
    @State private var working = false
    @State private var error: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 20) {
                    if let rescanFor { rescanBanner(rescanFor) } else { header }

                    if let result {
                        ReadingSummary(result: result, tint: tint) {
                            self.result = nil
                        }
                    } else {
                        captureButton
                    }

                    if let error {
                        Text(error)
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.bad)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    queueStatus

                    Spacer(minLength: 24)
                }
                .padding(20)
            }
        }
        .navigationTitle(rescanFor == nil ? "" : "Retake")
        .fullScreenCover(isPresented: $showCamera) {
            if DocumentScanner.isAvailable {
                DocumentScanner(
                    onScan: { image in
                        showCamera = false
                        Task { await handle(image) }
                    },
                    onCancel: { showCamera = false }
                )
                .ignoresSafeArea()
            } else {
                PlainCamera(
                    onCapture: { image in
                        showCamera = false
                        Task { await handle(image) }
                    },
                    onCancel: { showCamera = false }
                )
                .ignoresSafeArea()
            }
        }
        .onAppear { location.request() }
        .onDisappear { location.stop() }
    }

    private var tint: Color { Theme.tint(for: state.payeeType) }

    // MARK: - Pieces

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Photograph a ticket")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(Theme.text)

            Text(state.payeeType.ledgerLabel)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(tint)

            if let quarry = location.nearbyQuarry {
                // Not a claim about the ticket — a claim about where the phone
                // is. Shown because it is reassuring, and because it is the
                // signal that resolves the vendor when the printed name does
                // not match anything on file.
                Label("Looks like you are at \(quarry.name)", systemImage: "mappin.and.ellipse")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rescanBanner(_ tag: Tag) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("The office sent this back", systemImage: "arrow.uturn.backward")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.attention)

            if let rescan = tag.openRescan {
                Text(rescan.reason.label)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(Theme.text)

                // The instruction, not the fault. This is what someone reads
                // while holding a phone in one hand and a ticket in the other.
                Text(rescan.note ?? rescan.reason.instruction)
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let number = tag.ticketNumber {
                Text("Ticket #\(number)")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.faint)
            }
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

    private var captureButton: some View {
        VStack(spacing: 14) {
            Button {
                showCamera = true
            } label: {
                VStack(spacing: 12) {
                    Image(systemName: "camera.fill").font(.system(size: 44))
                    Text(rescanFor == nil ? "Take the photo" : "Retake it")
                        .font(.system(size: 22, weight: .bold))
                }
                .foregroundStyle(.black)
                .frame(maxWidth: .infinity, minHeight: 190)
                .background(tint)
                .clipShape(RoundedRectangle(cornerRadius: 20))
            }
            .disabled(working)

            if working {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.muted)
                    Text("Reading it…").foregroundStyle(Theme.muted)
                }
                .font(.system(size: 15))
            } else {
                Text("Hold the ticket flat. It shoots itself once all four corners are in frame.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.faint)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var queueStatus: some View {
        Group {
            if uploader.pendingCount > 0 {
                Card {
                    HStack(spacing: 10) {
                        Image(systemName: uploader.isOnline ? "arrow.up.circle" : "wifi.slash")
                            .foregroundStyle(uploader.isOnline ? Theme.driver : Theme.pending)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(uploader.pendingCount) waiting to send")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Theme.text)
                            Text(uploader.isOnline
                                 ? "Sending now."
                                 : "They are saved on this phone. They will go up on their own when you have signal.")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    // MARK: - The capture pipeline

    private func handle(_ raw: UIImage) async {
        working = true
        error = nil
        defer { working = false }

        let image = shrink(upright(raw))

        guard let jpeg = image.jpegData(compressionQuality: Config.jpegQuality) else {
            error = "That photo could not be saved. Take it again."
            return
        }

        let id = UUID().uuidString.lowercased()
        let url = Outbox.photosDirectory.appendingPathComponent("\(id).jpg")

        do {
            // Disk first, always. Everything after this can fail and be retried
            // without losing the only copy of the evidence.
            try jpeg.write(to: url, options: .atomic)
        } catch {
            self.error = "This phone is out of space. Free some up and try again."
            return
        }

        // --- read it, here, now ------------------------------------------
        var parsed: ScaleTicketParser.Output?
        var recognised: TextRecognizer.Result?

        do {
            let recognition = try await TextRecognizer.recognize(image)
            recognised = recognition
            if recognition.isWorthSubmitting {
                parsed = ScaleTicketParser.parse(recognition)
            }
        } catch {
            Log.error("vision failed: \(error.localizedDescription)")
        }

        let phash = PerceptualHash.dHash(image)
        let ok = parsed?.isScaleTicket == true

        Outbox.shared.enqueue(Outbox.Row(
            id: id,
            rescanForTagId: rescanFor?.id,
            payeeType: state.payeeType,
            driverId: state.driverId,
            subhaulerId: state.subhaulerId,
            localPath: url.path,
            capturedAt: ISO8601DateFormatter().string(from: Date()),
            capturedLat: location.last?.coordinate.latitude,
            capturedLng: location.last?.coordinate.longitude,
            phash: phash,
            note: nil,
            extractedJSON: parsed.flatMap { encode($0.extractedJSON) },
            confidenceJSON: parsed.flatMap { encode($0.confidenceJSON) },
            rawJSON: parsed.flatMap {
                encode([
                    "trace": $0.trace.map(\.json),
                    "weight_unit": $0.weightUnit ?? NSNull(),
                    "line_count": recognised?.lines.count ?? 0,
                ])
            },
            ocrText: recognised?.text,
            ocrMs: recognised?.ms ?? 0,
            ocrOK: ok,
            status: "pending",
            attempts: 0,
            lastError: nil,
            createdAt: ISO8601DateFormatter().string(from: Date())
        ))

        result = CaptureResult(parsed: parsed, readable: ok, image: image)
        uploader.refreshCount()

        // Fire and forget. If there is no signal this returns immediately and
        // the queue picks it up later; the driver is not waiting on it either
        // way, because the capture is already saved.
        Task { await uploader.sync() }

        if rescanFor != nil { dismiss() }
    }

    /// Resize so the longest side is `Config.maxImageDimension`.
    ///
    /// 2000 px keeps dot-matrix print legible to both Vision and a human on the
    /// review screen, at roughly 400 KB a ticket. Storage is now the only
    /// per-ticket cost in the whole system, so this number is the cost dial.
    private func shrink(_ image: UIImage) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > Config.maxImageDimension else { return image }

        let scale = Config.maxImageDimension / longest
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true

        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    private func encode(_ object: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object)
        else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

struct CaptureResult {
    let parsed: ScaleTicketParser.Output?
    let readable: Bool
    let image: UIImage
}

/// What the phone read, shown for two seconds before the driver moves on.
///
/// The point is not to ask them to check it — a driver is not the reviewer,
/// and asking them to confirm a tonnage they are paid on is the wrong person
/// to ask. The point is that "we could not read this one" arrives now, while
/// the ticket is still in their hand, rather than tonight from the office.
private struct ReadingSummary: View {

    let result: CaptureResult
    let tint: Color
    let onDone: () -> Void

    var body: some View {
        Card {
            HStack(spacing: 12) {
                Image(systemName: result.readable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(result.readable ? Theme.good : Theme.attention)

                VStack(alignment: .leading, spacing: 3) {
                    Text(result.readable ? "Saved" : "Saved, but hard to read")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(Theme.text)
                    Text(result.readable
                         ? "It goes to the office as soon as you have signal."
                         : "The office will type this one in from your photo. Retake it if it was blurry.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let parsed = result.parsed, result.readable {
                Divider().overlay(Theme.line)

                VStack(spacing: 8) {
                    row("Ticket", parsed.ticketNumber.value ?? "—")
                    row("Date", Format.date(parsed.tagDate.value))
                    row("Net", Format.tons(parsed.netTons.value))
                }

                Text("The office checks every number before anyone is paid.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.faint)
            }

            Button("Next ticket", action: onDone)
                .buttonStyle(SecondaryButton())
                .padding(.top, 4)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 15))
                .foregroundStyle(Theme.muted)
            Spacer()
            Text(value)
                .font(.system(size: 17, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.text)
        }
    }
}
