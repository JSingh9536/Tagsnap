package com.tagsnap.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tagsnap.core.Format
import com.tagsnap.net.Api
import com.tagsnap.net.Invoice
import com.tagsnap.net.InvoiceStatus
import com.tagsnap.net.SupabaseException
import com.tagsnap.net.Tag
import com.tagsnap.net.TagStatus

/**
 * What you are owed.
 *
 * The number people actually open this app for is "approved, not yet invoiced"
 * — the work that is definitely going to be paid but has not been paid yet. It
 * goes at the top in the largest type on the screen.
 *
 * Everything here is derived from tags this person can already see, so there is
 * no separate endpoint and no way for it to disagree with the ticket list. A
 * pay figure that contradicts the tickets it came from generates exactly the
 * phone call this app exists to stop.
 */
@Composable
fun PayScreen(state: AppState) {

    var tags by remember { mutableStateOf<List<Tag>>(emptyList()) }
    var invoices by remember { mutableStateOf<List<Invoice>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            tags = Api.myTags(limit = 300)
            invoices = Api.invoices()
        } catch (_: SupabaseException.SignedOut) {
            state.signOut()
        } catch (_: Exception) {
            error = "Could not refresh. Showing what was last loaded."
        }
        loading = false
    }

    if (loading && tags.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = TagSnapColors.driver)
        }
        return
    }

    val tint = TagSnapColors.tint(state.payeeType)
    val approved = tags.filter { it.status == TagStatus.APPROVED }
    val waiting = tags.filter {
        it.status != TagStatus.APPROVED &&
            it.status != TagStatus.INVOICED &&
            it.status != TagStatus.REJECTED
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        Text(
            "Pay",
            color = TagSnapColors.text,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold
        )

        Card {
            Text("Approved, not yet invoiced", color = TagSnapColors.muted, fontSize = 14.sp)
            Text(
                Format.cents(approved.sumOf { it.computedPayCents ?: 0 }),
                color = tint,
                fontSize = 46.sp,
                fontWeight = FontWeight.ExtraBold
            )
            Text(
                "${approved.size} load${if (approved.size == 1) "" else "s"} · " +
                    Format.tons(approved.sumOf { it.netTons ?: 0.0 }),
                color = TagSnapColors.muted,
                fontSize = 15.sp
            )
            Text(state.payeeType.ledgerLabel, color = TagSnapColors.faint, fontSize = 13.sp)
        }

        Card {
            Text("Still with the office", color = TagSnapColors.muted, fontSize = 14.sp)
            Text(
                "${waiting.size}",
                color = TagSnapColors.text,
                fontSize = 30.sp,
                fontWeight = FontWeight.Bold
            )
            Text(
                "Nothing is owed on these until somebody approves them.",
                color = TagSnapColors.faint,
                fontSize = 14.sp
            )
        }

        if (invoices.isNotEmpty()) {
            Text(
                "Invoices",
                color = TagSnapColors.faint,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold
            )
            invoices.forEach { invoice ->
                Card {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(
                                "${Format.date(invoice.periodStart)} – ${Format.date(invoice.periodEnd)}",
                                color = TagSnapColors.text,
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Text(
                                invoice.status.name.lowercase().replaceFirstChar { it.uppercase() },
                                color = if (invoice.status == InvoiceStatus.PAID)
                                    TagSnapColors.good else TagSnapColors.muted,
                                fontSize = 13.sp
                            )
                        }
                        Text(
                            Format.cents(invoice.totalCents),
                            color = TagSnapColors.text,
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }

        error?.let { Text(it, color = TagSnapColors.bad, fontSize = 14.sp) }

        Text(
            "These figures come from our rate table, not from anything printed on the " +
                "ticket. The dollar amount on a scale ticket is the quarry billing their " +
                "customer — it is not what you are paid.",
            color = TagSnapColors.faint,
            fontSize = 13.sp
        )
    }
}
