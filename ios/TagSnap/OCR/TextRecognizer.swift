import CoreGraphics
import Foundation
import UIKit
import Vision

/// Reading text off a photograph, on the phone, for nothing.
///
/// This is the piece that replaced a paid vision API. `VNRecognizeTextRequest`
/// ships with iOS, runs entirely on the Neural Engine, works in a dead zone,
/// and costs zero per ticket at any volume. On an iPhone 12 or newer a
/// 2000-pixel ticket comes back in roughly 300-500 ms.
///
/// Two settings here are doing most of the work, and both are easy to get
/// wrong:
///
/// **`usesLanguageCorrection = false`.** On by default, and it is the single
/// worst thing you can leave enabled for this job. It runs a language model
/// over the output and "fixes" text towards real words — which turns ticket
/// number `0245871` into something more word-like and mangles vendor codes
/// like `57 CR STONE`. There are no sentences on a scale ticket. Turning it
/// off measurably improves every field this app cares about.
///
/// **`.accurate`.** `.fast` is a different, weaker model intended for live
/// video overlays. The user is standing still holding a piece of paper; a
/// third of a second is not worth a worse read of a number someone is paid on.
enum TextRecognizer {

    struct Line {
        let text: String
        /// Normalised 0...1, origin **top left**, y growing downward.
        ///
        /// Vision reports bottom-left origin. The flip happens here, once,
        /// because the parser's "the line below the label" rule silently
        /// becomes "the line above" if it is missed — the most likely way a
        /// port of this goes wrong.
        let box: CGRect
        let confidence: Double
    }

    struct Result {
        let lines: [Line]
        let ms: Int
        /// Recorded on the tag so an accuracy regression is attributable to a
        /// specific OS version rather than to "the app".
        let engineVersion: String

        var text: String { lines.map(\.text).joined(separator: "\n") }

        /// Is there enough here to be worth submitting at all?
        ///
        /// A blank wall, a thumb over the lens, or a photo taken in the dark
        /// produces two or three garbage lines. Submitting that would file a
        /// reading of nothing; `extraction_failed()` is the right call, and it
        /// puts the photo in front of a person with an honest explanation.
        var isWorthSubmitting: Bool {
            lines.count >= 4
                && text.replacingOccurrences(of: " ", with: "").count >= 30
        }
    }

    enum Failure: LocalizedError {
        case noImage
        case visionFailed(String)

        var errorDescription: String? {
            switch self {
            case .noImage: return "That photo could not be opened."
            case .visionFailed(let why): return "Could not read the photo: \(why)"
            }
        }
    }

    /// Read one image.
    ///
    /// Runs off the main thread — a 300 ms hitch on the camera screen is very
    /// noticeable, and this is called immediately after the shutter.
    static func recognize(_ image: UIImage) async throws -> Result {
        guard let cgImage = image.cgImage else { throw Failure.noImage }

        let started = DispatchTime.now()

        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(
                        throwing: Failure.visionFailed(error.localizedDescription)
                    )
                    return
                }

                let observations = request.results as? [VNRecognizedTextObservation] ?? []
                let lines: [Line] = observations.compactMap { observation in
                    guard let candidate = observation.topCandidates(1).first else { return nil }

                    let b = observation.boundingBox
                    return Line(
                        text: candidate.string,
                        box: CGRect(
                            x: b.minX,
                            y: 1 - b.maxY,   // bottom-left origin -> top-left
                            width: b.width,
                            height: b.height
                        ),
                        // Vision's confidence is per-candidate and generally
                        // well-calibrated on print. It is one multiplier among
                        // several in the parser, never the whole score.
                        confidence: Double(candidate.confidence)
                    )
                }

                let ms = Int(
                    (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
                )

                continuation.resume(returning: Result(
                    lines: lines,
                    ms: ms,
                    engineVersion: "ios-\(UIDevice.current.systemVersion)"
                ))
            }

            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            request.recognitionLanguages = ["en-US"]

            // Scale tickets have small print in the margins — a truck number
            // or a job code is often the smallest thing on the page. The
            // default floor discards it.
            request.minimumTextHeight = 0.008

            // Revision 3 is the current model on iOS 16+. Pinned rather than
            // left to float, so an OS update cannot silently change what the
            // fleet's tickets read as between one week and the next.
            if #available(iOS 16.0, *) {
                request.revision = VNRecognizeTextRequestRevision3
            }

            let handler = VNImageRequestHandler(
                cgImage: cgImage,
                orientation: image.imageOrientation.cgOrientation,
                options: [:]
            )

            // .userInitiated: the driver is watching a spinner on the capture
            // screen, but this must not compete with the UI for the main queue.
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    continuation.resume(
                        throwing: Failure.visionFailed(error.localizedDescription)
                    )
                }
            }
        }
    }
}

private extension UIImage.Orientation {
    /// Vision wants the EXIF orientation, and a photo from the camera is
    /// almost never `.up`. Skipping this reads a portrait ticket sideways.
    var cgOrientation: CGImagePropertyOrientation {
        switch self {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
