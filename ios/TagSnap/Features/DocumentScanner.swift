import SwiftUI
import UIKit
import VisionKit

/// Apple's document scanner, wrapped for SwiftUI.
///
/// This is the second half of the "imaging costs nothing" answer, and it is
/// worth more to accuracy than any amount of parser tuning.
/// `VNDocumentCameraViewController` finds the edges of the paper, corrects the
/// perspective, crops away the truck seat and the dashboard, and boosts
/// contrast on a faded carbon copy — before Vision ever sees it. It ships with
/// iOS, and it is what the Notes app uses.
///
/// A ticket photographed at an angle across a lap, run through this, reads
/// like a flatbed scan. The same photo straight from `UIImagePickerController`
/// reads like a photo taken at an angle across a lap.
///
/// It also gives the driver something valuable for free: automatic capture the
/// moment the paper is square in frame, so the whole interaction is hold the
/// ticket up, wait half a second, done.
struct DocumentScanner: UIViewControllerRepresentable {

    /// Called with the cropped, deskewed page. Multi-page is not offered —
    /// one ticket is one tag, and a two-page scan would mean two loads on one
    /// record, which is exactly the ambiguity the duplicate controls exist to
    /// avoid.
    let onScan: (UIImage) -> Void
    let onCancel: () -> Void

    static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan, onCancel: onCancel)
    }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        private let onScan: (UIImage) -> Void
        private let onCancel: () -> Void

        init(onScan: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onScan = onScan
            self.onCancel = onCancel
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            // Only the first page. If somebody scanned two, the second is
            // discarded rather than silently attached to this tag.
            guard scan.pageCount > 0 else {
                onCancel()
                return
            }
            onScan(scan.imageOfPage(at: 0))
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onCancel()
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController, didFailWithError error: Error
        ) {
            Log.error("document scanner failed: \(error.localizedDescription)")
            onCancel()
        }
    }
}

/// The plain camera, for the handful of devices where the document scanner is
/// not supported.
///
/// Rare — it needs an A12 or newer, which means an iPhone XR and up — but a
/// driver whose phone cannot scan should still be able to file a ticket. The
/// read will be worse and more of their tickets will land in review, and that
/// is a much better outcome than the app refusing to work.
struct PlainCamera: UIViewControllerRepresentable {

    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate,
                             UINavigationControllerDelegate {
        private let onCapture: (UIImage) -> Void
        private let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                onCancel()
                return
            }
            onCapture(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
