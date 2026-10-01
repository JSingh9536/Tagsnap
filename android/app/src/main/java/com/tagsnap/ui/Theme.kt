package com.tagsnap.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tagsnap.net.PayeeType
import com.tagsnap.net.TagStatus

/**
 * The palette, from the world the app lives in.
 *
 * Asphalt and concrete, with signal blue for company trucks and hi-vis amber
 * for subhaulers. The two lane colours are the same ones the iOS app, the
 * office console and the deck use, so a driver, a reviewer, and a slide all
 * mean the same thing by the same colour.
 *
 * Everything is sized for a phone held in one gloved hand in daylight: nothing
 * smaller than 15sp, high contrast throughout, and tap targets no smaller than
 * 48dp. Dark always — a bright white screen in a truck cab at night is
 * genuinely unpleasant, and this app is used at 5 a.m.
 */
object TagSnapColors {
    val background = Color(0xFF0F1720)
    val surface = Color(0xFF18222E)
    val raised = Color(0xFF22303F)
    val line = Color(0xFF2E3E4F)

    val text = Color(0xFFF2F6FA)
    val muted = Color(0xFF9DB0C2)
    val faint = Color(0xFF67788A)

    /** Company driver. Also the primary action colour. */
    val driver = Color(0xFF3FA7F5)

    /** Subhauler. */
    val subhauler = Color(0xFFF5A623)

    val good = Color(0xFF3FBF6F)
    val attention = Color(0xFFF5A623)
    val bad = Color(0xFFE5484D)
    val pending = Color(0xFF7B8FA3)

    fun tint(payee: PayeeType): Color =
        if (payee == PayeeType.SUBHAULER) subhauler else driver

    fun tone(tone: TagStatus.Tone): Color = when (tone) {
        TagStatus.Tone.PENDING -> pending
        TagStatus.Tone.ATTENTION -> attention
        TagStatus.Tone.GOOD -> good
        TagStatus.Tone.BAD -> bad
    }
}

/**
 * Dark only, and not because dark mode is fashionable.
 *
 * Offering a light theme would mean maintaining two sets of contrast decisions
 * for a screen that is read outdoors in sunlight and in a cab before dawn. One
 * theme, tuned for both, is the better trade.
 */
@Composable
fun TagSnapTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = TagSnapColors.driver,
            onPrimary = Color.Black,
            secondary = TagSnapColors.subhauler,
            background = TagSnapColors.background,
            onBackground = TagSnapColors.text,
            surface = TagSnapColors.surface,
            onSurface = TagSnapColors.text,
            error = TagSnapColors.bad,
        ),
        content = content
    )
}

@Composable
fun Card(
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(TagSnapColors.surface, RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content
    )
}

/** A status pill. The same words and colours the office console uses. */
@Composable
fun StatusPill(status: TagStatus) {
    val colour = TagSnapColors.tone(status.tone)
    Text(
        text = status.driverLabel,
        color = colour,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .background(colour.copy(alpha = 0.15f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 5.dp)
    )
}
