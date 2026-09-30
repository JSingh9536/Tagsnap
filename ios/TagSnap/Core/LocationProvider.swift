import CoreLocation
import Foundation

/// Where a photo was taken.
///
/// Two uses, both of them free:
///
///   * `app.quarry_near_capture()` resolves the vendor when the printed name
///     on the ticket does not match anything on file — which is common with a
///     new quarry, and used to mean a reviewer typing it in by hand.
///   * a coordinate on the ticket is the beginning of the dispatch/GPS
///     cross-verification in `INGESTION.md` tier 3, which is the eventual
///     route to approving a clean load without anyone looking at it.
///
/// `whenInUse` only, and nothing is tracked in the background. The app wants
/// to know where one photograph was taken, not where a driver has been all
/// day, and the distinction is worth keeping — the second is a surveillance
/// system, would need to be disclosed as one, and buys nothing extra.
@MainActor
final class LocationProvider: NSObject, ObservableObject, CLLocationManagerDelegate {

    static let shared = LocationProvider()

    @Published private(set) var last: CLLocation?
    @Published private(set) var nearbyQuarry: NearbyQuarry?

    private let manager = CLLocationManager()

    override private init() {
        super.init()
        manager.delegate = self
        // Hundred metres is plenty: it is deciding which quarry, not where in
        // the yard, and the coarser setting is dramatically cheaper on battery.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func request() {
        guard manager.authorizationStatus == .notDetermined else {
            start()
            return
        }
        manager.requestWhenInUseAuthorization()
    }

    func start() {
        guard manager.authorizationStatus == .authorizedWhenInUse
                || manager.authorizationStatus == .authorizedAlways else { return }
        manager.startUpdatingLocation()
    }

    func stop() {
        manager.stopUpdatingLocation()
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in start() }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]
    ) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            self.last = location
            await self.lookUpQuarry(location)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Not worth telling a driver about. A capture with no coordinates is a
        // perfectly good capture; it just loses one free resolution signal.
        Log.detail("location failed: \(error.localizedDescription)")
    }

    private var lastLookup: Date?

    /// Ask the server which quarry this is, at most once a minute.
    private func lookUpQuarry(_ location: CLLocation) async {
        if let lastLookup, Date().timeIntervalSince(lastLookup) < 60 { return }
        lastLookup = Date()

        nearbyQuarry = try? await API.quarriesNearby(
            lat: location.coordinate.latitude,
            lng: location.coordinate.longitude
        ).first
    }
}
