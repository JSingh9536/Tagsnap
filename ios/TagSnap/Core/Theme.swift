import SwiftUI

/// The palette, from the world the app lives in.
///
/// Asphalt and concrete, with signal blue for company trucks and hi-vis amber
/// for subhaulers. The two lane colours are the same ones the office console
/// and the deck use, so a driver, a reviewer, and a slide all mean the same
/// thing by the same colour.
///
/// Everything is sized for a phone held in one gloved hand in daylight:
/// nothing smaller than 15 points, high contrast throughout, and tap targets
/// no smaller than 44 points. Dark by default — a bright white screen in a
/// truck cab at night is genuinely unpleasant, and this app is used at 5 a.m.
enum Theme {

    static let background = Color(hex: 0x0F1720)
    static let surface = Color(hex: 0x18222E)
    static let raised = Color(hex: 0x22303F)
    static let line = Color(hex: 0x2E3E4F)

    static let text = Color(hex: 0xF2F6FA)
    static let muted = Color(hex: 0x9DB0C2)
    static let faint = Color(hex: 0x67788A)

    /// Company driver. Also the primary action colour.
    static let driver = Color(hex: 0x3FA7F5)
    /// Subhauler.
    static let subhauler = Color(hex: 0xF5A623)

    static let good = Color(hex: 0x3FBF6F)
    static let attention = Color(hex: 0xF5A623)
    static let bad = Color(hex: 0xE5484D)
    static let pending = Color(hex: 0x7B8FA3)

    static let radius: CGFloat = 12

    static func tint(for payee: PayeeType) -> Color {
        payee == .subhauler ? subhauler : driver
    }

    static func colour(for tone: TagStatus.Tone) -> Color {
        switch tone {
        case .pending: return pending
        case .attention: return attention
        case .good: return good
        case .bad: return bad
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// A big, unmissable button.
///
/// The capture button is pressed with a glove on, in the rain, while holding a
/// ticket. Nothing subtle survives that.
struct PrimaryButton: ButtonStyle {
    var tint: Color = Theme.driver
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(destructive ? Theme.text : Color.black)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(destructive ? Theme.bad : tint)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

struct SecondaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(Theme.text)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Theme.raised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

/// A status pill. The same words and colours the office console uses.
struct StatusPill: View {
    let status: TagStatus

    var body: some View {
        Text(status.driverLabel)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.colour(for: status.tone))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.colour(for: status.tone).opacity(0.15))
            .clipShape(Capsule())
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }
}

// MARK: - Formatting

enum Format {
    static func cents(_ value: Int?) -> String {
        guard let value else { return "—" }
        return (Double(value) / 100).formatted(.currency(code: "USD"))
    }

    static func tons(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.2f t", value)
    }

    static func date(_ iso: String?) -> String {
        guard let iso, !iso.isEmpty else { return "—" }

        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let date: Date? = iso.count == 10
            ? {
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd"
                f.timeZone = TimeZone(identifier: "UTC")
                return f.date(from: iso)
            }()
            : (parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso))

        guard let date else { return iso }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}
