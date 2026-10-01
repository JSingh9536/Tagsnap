package com.tagsnap.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import com.tagsnap.core.Biometrics
import com.tagsnap.net.Portal
import com.tagsnap.net.Supabase
import kotlinx.coroutines.launch

/**
 * Driver or subhauler — asked before anything else.
 *
 * This is an affordance, not a permission. It changes what the sign-in screen
 * says and sets an expectation the server then confirms or contradicts. See
 * `AppState.loadProfile`, and `docs/ROLES.md` for why the two ledgers can never
 * share a document.
 */
@Composable
fun PortalScreen(state: AppState) {
    Column(
        Modifier.fillMaxSize().padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(Modifier.weight(1f))

        Text(
            "TagSnap",
            color = TagSnapColors.text,
            fontSize = 40.sp,
            fontWeight = FontWeight.ExtraBold
        )
        Text(
            "Photograph the ticket. That is the whole job.",
            color = TagSnapColors.muted,
            fontSize = 16.sp
        )

        Spacer(Modifier.weight(1f))

        Door(
            title = "Company driver",
            detail = "You drive one of our trucks and are paid on a settlement.",
            tint = TagSnapColors.driver,
            icon = Icons.Filled.LocalShipping,
        ) { state.choose(Portal.DRIVER) }

        Spacer(Modifier.height(14.dp))

        Door(
            title = "Subhauler",
            detail = "You haul for us under your own outfit and invoice us for it.",
            tint = TagSnapColors.subhauler,
            icon = Icons.Filled.Inventory2,
        ) { state.choose(Portal.SUBHAULER) }

        Text(
            "Office and admin accounts use the web console.",
            color = TagSnapColors.faint,
            fontSize = 14.sp,
            modifier = Modifier.padding(top = 24.dp, bottom = 32.dp)
        )
    }
}

@Composable
private fun Door(
    title: String,
    detail: String,
    tint: Color,
    icon: ImageVector,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(TagSnapColors.surface, RoundedCornerShape(12.dp))
            .border(1.dp, tint.copy(alpha = 0.35f), RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(18.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(30.dp))
        Spacer(Modifier.width(16.dp))
        Column {
            Text(title, color = TagSnapColors.text, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
            Text(detail, color = TagSnapColors.muted, fontSize = 14.sp)
        }
    }
}

/**
 * Sign in, phone number first.
 *
 * A phone number is the one identifier every driver already has, works with
 * gloves on, and does not require anybody to remember a password they set once
 * in an office. Email and password is the alternative, kept because
 * owner-operators often have a work email and prefer it.
 *
 * There is no sign-up. Accounts are created by an admin, because a self-serve
 * account on a payables system is a way for somebody to pay themselves.
 */
@Composable
fun SignInScreen(state: AppState, portal: Portal) {
    val scope = rememberCoroutineScope()
    val tint = if (portal == Portal.SUBHAULER) TagSnapColors.subhauler else TagSnapColors.driver

    var usePhone by remember { mutableStateOf(true) }
    var phone by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var codeSent by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val ready = if (usePhone) {
        if (codeSent) code.length >= 6 else phone.count { it.isDigit() } >= 10
    } else {
        email.contains("@") && password.length >= 6
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        Spacer(Modifier.height(24.dp))
        Text(
            if (portal == Portal.SUBHAULER) "Subhauler sign-in" else "Driver sign-in",
            color = TagSnapColors.text,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold
        )
        Text(
            "No account here? The office creates them.",
            color = TagSnapColors.muted,
            fontSize = 15.sp
        )

        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = usePhone,
                onClick = { usePhone = true },
                shape = SegmentedButtonDefaults.itemShape(0, 2)
            ) { Text("Phone") }
            SegmentedButton(
                selected = !usePhone,
                onClick = { usePhone = false },
                shape = SegmentedButtonDefaults.itemShape(1, 2)
            ) { Text("Email") }
        }

        if (usePhone) {
            OutlinedTextField(
                value = phone,
                onValueChange = { phone = it },
                enabled = !codeSent,
                label = { Text("Mobile number") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 20.sp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
            )
            if (codeSent) {
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text("The 6-digit code we just texted you") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 20.sp),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
                )
                TextButton(onClick = { codeSent = false; code = "" }) {
                    Text("Use a different number", color = tint)
                }
            }
        } else {
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
            )
        }

        error?.let { Text(it, color = TagSnapColors.bad, fontSize = 15.sp) }

        Button(
            onClick = {
                busy = true
                error = null
                scope.launch {
                    try {
                        when {
                            !usePhone -> {
                                Supabase.signIn(email, password)
                                state.loadProfile()
                            }
                            codeSent -> {
                                Supabase.verifyPhoneCode(phone, code)
                                state.loadProfile()
                            }
                            else -> {
                                Supabase.sendPhoneCode(phone)
                                codeSent = true
                            }
                        }
                    } catch (e: Exception) {
                        // Deliberately vague about *which* half was wrong.
                        // Saying "no such number" tells anyone holding the
                        // phone whose numbers are on the system.
                        error = e.message
                            ?: "That did not work. Check what you typed and try again."
                    }
                    busy = false
                }
            },
            enabled = ready && !busy,
            colors = ButtonDefaults.buttonColors(containerColor = tint),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
        ) {
            if (busy) {
                CircularProgressIndicator(color = Color.Black, modifier = Modifier.size(22.dp))
            } else {
                Text(
                    if (!usePhone) "Sign in" else if (codeSent) "Sign in" else "Text me a code",
                    color = Color.Black,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }

        TextButton(
            onClick = { state.backToPortal() },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Pick a different door", color = TagSnapColors.faint)
        }
    }
}

/**
 * You came through the wrong door.
 *
 * Shown after a successful sign-in whose profile disagrees with the portal that
 * was picked. The account is already signed back out by the time this appears —
 * see `AppState.loadProfile`.
 */
@Composable
fun WrongPortalScreen(state: AppState, actual: Portal) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            Icons.Filled.Undo, null,
            tint = TagSnapColors.attention,
            modifier = Modifier.size(52.dp)
        )
        Spacer(Modifier.height(20.dp))
        Text(
            if (actual == Portal.OFFICE) "This app is for the field" else "Wrong door",
            color = TagSnapColors.text,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold
        )
        Spacer(Modifier.height(12.dp))
        Text(
            when (actual) {
                Portal.OFFICE ->
                    "Your account reviews and approves tickets. That work happens in the " +
                        "office console in a browser, where the photo is big enough to read."
                Portal.DRIVER ->
                    "Your account is set up as a company driver. Sign in through the Driver door."
                Portal.SUBHAULER ->
                    "Your account is set up as a subhauler. Sign in through the Subhauler door."
            },
            color = TagSnapColors.muted,
            fontSize = 17.sp
        )
        Spacer(Modifier.height(28.dp))
        Button(
            onClick = { state.backToPortal() },
            colors = ButtonDefaults.buttonColors(containerColor = TagSnapColors.driver),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
        ) { Text("Start again", color = Color.Black, fontSize = 18.sp) }
    }
}

/**
 * The screen over everything when the app comes back from the background.
 *
 * Opt-in — see `Biometrics`. It covers the content rather than replacing it, so
 * unlocking puts the driver back exactly where they were rather than resetting
 * them to the front door mid-shift.
 */
@Composable
fun LockScreen(state: AppState) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var failed by remember { mutableStateOf(false) }

    suspend fun tryUnlock() {
        val activity = context as? FragmentActivity ?: return
        val ok = Biometrics.authenticate(activity, "Unlock TagSnap")
        failed = !ok
        if (ok) state.unlock()
    }

    LaunchedEffect(Unit) { tryUnlock() }

    Box(
        Modifier
            .fillMaxSize()
            // Opaque, not a blur. A blurred screenshot of somebody's pay screen
            // is still a screenshot of somebody's pay screen.
            .background(TagSnapColors.background),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                Icons.Filled.Lock, null,
                tint = TagSnapColors.driver,
                modifier = Modifier.size(44.dp)
            )
            Spacer(Modifier.height(20.dp))
            Text(
                "TagSnap is locked",
                color = TagSnapColors.text,
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold
            )
            if (failed) {
                Spacer(Modifier.height(8.dp))
                Text("That did not unlock it.", color = TagSnapColors.bad, fontSize = 15.sp)
            }
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = { scope.launch { tryUnlock() } },
                colors = ButtonDefaults.buttonColors(containerColor = TagSnapColors.driver)
            ) { Text("Unlock", color = Color.Black, fontSize = 18.sp) }
            TextButton(onClick = { state.signOut() }) {
                Text("Sign out instead", color = TagSnapColors.faint)
            }
        }
    }
}
