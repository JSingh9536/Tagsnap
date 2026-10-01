package com.tagsnap.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tagsnap.core.Settings
import com.tagsnap.net.Api
import com.tagsnap.net.PayeeType
import com.tagsnap.net.Portal
import com.tagsnap.net.Profile
import com.tagsnap.net.Supabase
import com.tagsnap.net.SupabaseException
import com.tagsnap.push.TagSnapMessagingService
import com.tagsnap.store.Outbox
import com.tagsnap.store.Uploader
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Who is signed in, which door they came through, and whether the app is
 * locked.
 *
 * The portal question — "Driver or Subhauler?" — is asked before sign-in
 * because it changes what the sign-in screen says and it is the first thing
 * somebody handed a phone needs to answer. It is emphatically **not** what
 * grants the role.
 *
 * The flow is: pick a door → authenticate → ask the server who this actually is
 * → if the two disagree, sign back out and say which door to use. Letting the
 * picker grant the role would make choosing "Office" a privilege escalation,
 * which is the sort of thing that looks obviously wrong written down and
 * completely reasonable while you are building a login screen.
 */
class AppState(application: Application) : AndroidViewModel(application) {

    sealed interface Phase {
        data object Starting : Phase
        data object ChoosingPortal : Phase
        data class SigningIn(val portal: Portal) : Phase
        data object Ready : Phase
        data class WrongPortal(val actual: Portal) : Phase
    }

    private val settings = Settings(application)
    val outbox = Outbox(application)
    val uploader = Uploader(application, outbox)

    private val _phase = MutableStateFlow<Phase>(Phase.Starting)
    val phase: StateFlow<Phase> = _phase

    private val _profile = MutableStateFlow<Profile?>(null)
    val profile: StateFlow<Profile?> = _profile

    private val _locked = MutableStateFlow(false)
    val locked: StateFlow<Boolean> = _locked

    /** A tag id from a tapped notification, consumed by the navigation host. */
    private val _pendingTagId = MutableStateFlow<String?>(null)
    val pendingTagId: StateFlow<String?> = _pendingTagId

    var portal: Portal = Portal.DRIVER
        private set

    init {
        settings.lastPortal?.let { saved ->
            portal = runCatching { Portal.valueOf(saved) }.getOrDefault(Portal.DRIVER)
        }
        start()
    }

    private fun start() = viewModelScope.launch {
        uploader.refreshCount()

        if (!Supabase.isSignedIn) {
            _phase.value = Phase.ChoosingPortal
            return@launch
        }

        try {
            loadProfile()
        } catch (_: Exception) {
            // A session that cannot load a profile is a session for an account
            // that has been deactivated or deleted. Do not leave someone
            // staring at an empty list wondering.
            Supabase.signOut()
            _phase.value = Phase.ChoosingPortal
        }
    }

    fun choose(portal: Portal) {
        this.portal = portal
        settings.lastPortal = portal.name
        _phase.value = Phase.SigningIn(portal)
    }

    fun backToPortal() {
        _phase.value = Phase.ChoosingPortal
    }

    /** Fetch the profile and reconcile it against the door they picked. */
    suspend fun loadProfile() {
        val me = Api.myProfile()

        if (!me.active) {
            Supabase.signOut()
            _phase.value = Phase.ChoosingPortal
            throw SupabaseException.Server("This account has been deactivated.")
        }

        // Office and admin accounts are turned away from the phone entirely.
        // Their work is the review screen, which needs a wide layout and a
        // photo big enough to read a faded carbon copy on.
        if (me.role.portal == Portal.OFFICE) {
            Supabase.signOut()
            _profile.value = null
            _phase.value = Phase.WrongPortal(Portal.OFFICE)
            return
        }

        if (me.role.portal != portal) {
            Supabase.signOut()
            _profile.value = null
            _phase.value = Phase.WrongPortal(me.role.portal)
            return
        }

        _profile.value = me
        uploader.profile = me
        _locked.value = settings.biometricsEnabled
        _phase.value = Phase.Ready

        // Registered after sign-in rather than at launch: a device token
        // recorded against no profile is a token nothing can ever deliver to.
        TagSnapMessagingService.register()
        Uploader.schedule(getApplication())
    }

    fun signOut() = viewModelScope.launch {
        Supabase.signOut()
        _profile.value = null
        _phase.value = Phase.ChoosingPortal
    }

    fun lockIfEnabled() {
        if (settings.biometricsEnabled) _locked.value = true
    }

    fun unlock() {
        _locked.value = false
    }

    fun openTag(id: String) {
        _pendingTagId.value = id
    }

    fun consumePendingTag() {
        _pendingTagId.value = null
    }

    fun sync() = viewModelScope.launch { uploader.sync() }

    // ------------------------------------------------------------ filing a tag

    /**
     * Which payee this person's loads land on.
     *
     * Read from `profiles.role`, never from the portal picker, and it follows
     * the ticket all the way to the invoice. A subhauler's loads are a payable
     * to their *outfit* — you owe the company, not the individual behind the
     * wheel — which is why `subhaulerId` is the payee here and the person is
     * only who filed it.
     */
    val payeeType: PayeeType
        get() = _profile.value?.role?.payeeType ?: PayeeType.EMPLOYEE_DRIVER

    val driverId: String?
        get() = if (payeeType == PayeeType.EMPLOYEE_DRIVER) _profile.value?.id else null

    val subhaulerId: String?
        get() = if (payeeType == PayeeType.SUBHAULER) _profile.value?.subhaulerId else null
}
