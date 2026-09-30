import CoreGraphics
import Foundation
import UIKit

/// A difference hash of a tag photo.
///
/// The unique constraint on `(quarry_id, ticket_number)` catches the same
/// ticket filed twice. It does not catch the same physical ticket photographed
/// from a different angle and filed with one digit of the ticket number
/// changed — which is the version of that someone actually tries, because it
/// looks like an honest typo if anyone asks.
///
/// dHash catches it. The method is deliberately crude: shrink to 9×8
/// greyscale, then record whether each pixel is brighter than the one to its
/// right. That yields 64 bits describing the *structure* of the image, which
/// survives a different angle, different lighting, and a different phone,
/// while two genuinely different documents diverge immediately.
///
/// This used to run on the server, which had the image bytes. It runs here
/// now, before upload, and the hash rides along on the `tag_images` row. Same
/// algorithm, same bit layout, same `app.phash_distance()` comparison in SQL —
/// see `supabase/functions/.retired/phash.ts` for the version this was ported
/// from, and `008_phash.sql` for the comparison.
enum PerceptualHash {

    private static let width = 9
    private static let height = 8

    /// Returns a signed 64-bit value, because Postgres `bigint` is signed and
    /// the XOR-and-popcount distance works on the bit pattern regardless.
    static func dHash(_ image: UIImage) -> Int64? {
        guard let grey = downsampleToGrey(image) else { return nil }

        var hash: UInt64 = 0
        var bit = 0

        for y in 0..<height {
            for x in 0..<(width - 1) {
                let left = grey[y * width + x]
                let right = grey[y * width + x + 1]
                if left > right {
                    hash |= (1 << UInt64(63 - bit))
                }
                bit += 1
            }
        }

        return Int64(bitPattern: hash)
    }

    /// Average every source pixel that falls in each destination cell.
    ///
    /// Nearest-neighbour sampling would be faster and would make the hash
    /// sensitive to exactly the thing it must ignore — a one-pixel shift from
    /// a slightly different camera angle. Averaging is what makes the result
    /// stable across two photos of the same sheet of paper.
    ///
    /// Core Graphics does the averaging: drawing into a 9×8 context with
    /// high-quality interpolation is a box filter, and it is both shorter and
    /// faster than doing it by hand over a few million pixels.
    private static func downsampleToGrey(_ image: UIImage) -> [Double]? {
        // `cgImage` ignores `imageOrientation`, and a photo straight off the
        // camera is almost never `.up`. Hashing the unrotated buffer would
        // give a portrait ticket a completely different hash on iOS than the
        // same ticket gets on Android — and these hashes are compared to each
        // other, across platforms, in `similar_tag_images()`. Straighten first.
        guard let cgImage = upright(image).cgImage else { return nil }

        let count = width * height
        var pixels = [UInt8](repeating: 0, count: count * 4)

        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        context.interpolationQuality = .high
        context.draw(
            cgImage,
            in: CGRect(x: 0, y: 0, width: width, height: height)
        )

        // Rec. 601 luma. Scale tickets are near-monochrome anyway, but
        // weighting properly keeps a red carbon copy from reading as
        // near-black.
        return (0..<count).map { i in
            let o = i * 4
            return 0.299 * Double(pixels[o])
                + 0.587 * Double(pixels[o + 1])
                + 0.114 * Double(pixels[o + 2])
        }
    }
}

/// Redraw a UIImage so its pixel buffer matches what you see.
///
/// Shared by the hash and the uploader: the JPEG that goes into the bucket has
/// to be upright too, or the office review screen shows a sideways ticket.
func upright(_ image: UIImage) -> UIImage {
    guard image.imageOrientation != .up else { return image }

    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true

    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
        image.draw(in: CGRect(origin: .zero, size: image.size))
    }
}
