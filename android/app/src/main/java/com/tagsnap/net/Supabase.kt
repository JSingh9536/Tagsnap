package com.tagsnap.net

import android.content.Context
import android.util.Log
import com.tagsnap.BuildConfig
import com.tagsnap.core.SecureStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * A small Supabase client, written here rather than imported.
 *
 * The reason is not purity. This app talks to four documented, stable HTTP APIs
 * — GoTrue, PostgREST, Storage, and Edge Functions — and needs a few hundred
 * lines to do it. Against that: an SDK dependency to keep version-matched, in
 * an app whose whole point is that it keeps working in a truck cab with no
 * signal. The trade is not close.
 *
 * What this deliberately does not have: a query builder, a realtime socket, and
 * an offline cache. Reads are plain PostgREST URLs, live updates are
 * pull-to-refresh and a push notification, and the offline story is the outbox
 * in `store/Outbox.kt`, which is a different and simpler problem than a general
 * cache.
 */
object Supabase {

    private const val TAG = "TagSnap/net"

    private val url = BuildConfig.SUPABASE_URL.trimEnd('/')
    private val anonKey = BuildConfig.SUPABASE_ANON_KEY

    private val rest = "$url/rest/v1"
    private val auth = "$url/auth/v1"
    private val storage = "$url/storage/v1"
    private val functions = "$url/functions/v1"

    const val IMAGE_BUCKET = "tag-images"

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    private val client = OkHttpClient.Builder()
        // A driver at a quarry has one bar and a lot of concrete around them.
        // Long enough to survive that; short enough that a dead zone does not
        // hang the UI behind a spinner for a minute.
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val jsonMedia = "application/json".toMediaType()
    private val jpegMedia = "image/jpeg".toMediaType()

    private lateinit var store: SecureStore
    private val refreshLock = Mutex()

    fun init(context: Context) {
        store = SecureStore(context)
    }

    // ---------------------------------------------------------------- session

    val isSignedIn: Boolean get() = store.refreshToken != null
    val currentUserId: String? get() = store.userId

    private fun persist(body: JSONObject) {
        store.accessToken = body.getString("access_token")
        store.refreshToken = body.getString("refresh_token")
        store.expiresAt = System.currentTimeMillis() + body.getLong("expires_in") * 1000
        body.optJSONObject("user")?.optString("id")?.takeIf { it.isNotEmpty() }?.let {
            store.userId = it
        }
    }

    suspend fun signOut() = withContext(Dispatchers.IO) {
        // Best effort. If the network call fails the local session is still
        // destroyed, which is the part that matters on a phone someone just
        // handed back.
        store.accessToken?.let { token ->
            runCatching {
                client.newCall(
                    Request.Builder()
                        .url("$auth/logout")
                        .post(ByteArray(0).toRequestBody())
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .build()
                ).execute().close()
            }
        }
        store.clear()
    }

    /**
     * A valid access token, refreshing first if it is about to expire.
     *
     * The mutex is doing real work. Two screens loading at once would otherwise
     * both notice the expiry and both refresh, and GoTrue rotates refresh
     * tokens — so the second call would present one the first had already
     * consumed, and the driver would be signed out mid-shift.
     */
    private suspend fun validToken(): String = refreshLock.withLock {
        val token = store.accessToken
        if (token != null && store.expiresAt - System.currentTimeMillis() > 60_000) {
            return@withLock token
        }
        val refresh = store.refreshToken ?: throw SupabaseException.SignedOut

        val response = withContext(Dispatchers.IO) {
            client.newCall(
                Request.Builder()
                    .url("$auth/token?grant_type=refresh_token")
                    .post(
                        JSONObject().put("refresh_token", refresh)
                            .toString().toRequestBody(jsonMedia)
                    )
                    .header("apikey", anonKey)
                    .build()
            ).execute()
        }

        response.use {
            if (!it.isSuccessful) {
                // A refused refresh means the session is genuinely over —
                // revoked, expired, or the account was deactivated. Clear it
                // rather than retrying into a loop.
                store.clear()
                throw SupabaseException.SignedOut
            }
            val body = JSONObject(it.body!!.string())
            persist(body)
            body.getString("access_token")
        }
    }

    // ---------------------------------------------------------------- sign in

    /**
     * Phone OTP. The lead path in the field: gloves on, no work email, and a
     * phone number is the one identifier every driver already has.
     */
    suspend fun sendPhoneCode(phone: String) {
        postAuth("otp", JSONObject().put("phone", normalisePhone(phone)).put("create_user", false))
    }

    suspend fun verifyPhoneCode(phone: String, code: String) {
        val body = postAuth(
            "verify",
            JSONObject()
                .put("phone", normalisePhone(phone))
                .put("token", code)
                .put("type", "sms")
        )
        persist(body)
    }

    /** Email and password, for owner-operators who have one and prefer it. */
    suspend fun signIn(email: String, password: String) {
        val body = postAuth(
            "token?grant_type=password",
            JSONObject().put("email", email.trim()).put("password", password)
        )
        persist(body)
    }

    /**
     * US-centric on purpose: this is a regional haul operation, and a driver
     * typing their own number will not type `+1`.
     */
    private fun normalisePhone(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return when {
            digits.length == 10 -> "+1$digits"
            digits.length == 11 && digits.startsWith("1") -> "+$digits"
            raw.startsWith("+") -> raw
            else -> "+$digits"
        }
    }

    private suspend fun postAuth(path: String, body: JSONObject): JSONObject =
        withContext(Dispatchers.IO) {
            client.newCall(
                Request.Builder()
                    .url("$auth/$path")
                    .post(body.toString().toRequestBody(jsonMedia))
                    .header("apikey", anonKey)
                    .build()
            ).execute().use { response ->
                val text = response.body?.string().orEmpty()
                check(response, text, "sign in")
                if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        }

    // --------------------------------------------------------------- PostgREST

    /**
     * A read. `query` is the raw PostgREST query string.
     *
     * There is no filter argument by design. Every read in this app is scoped
     * by Row Level Security rather than by a WHERE clause the client remembered
     * to add: a driver gets their own tags because the database says so. A
     * forgotten filter here would be a cosmetic bug; a forgotten policy would
     * be a data leak, and there is no way to forget a policy.
     */
    suspend fun selectRaw(table: String, query: String): String = withContext(Dispatchers.IO) {
        client.newCall(
            authorised(Request.Builder().url("$rest/$table?$query")).build()
        ).execute().use { response ->
            val text = response.body?.string().orEmpty()
            check(response, text, "loading $table")
            text
        }
    }

    suspend inline fun <reified T> select(table: String, query: String): List<T> =
        json.decodeFromString(selectRaw(table, query))

    suspend fun insert(table: String, values: JSONObject, upsert: Boolean = false) =
        withContext(Dispatchers.IO) {
            client.newCall(
                authorised(
                    Request.Builder()
                        .url("$rest/$table")
                        .post(values.toString().toRequestBody(jsonMedia))
                        .header(
                            "Prefer",
                            if (upsert) "return=minimal,resolution=merge-duplicates"
                            else "return=minimal"
                        )
                ).build()
            ).execute().use { response ->
                check(response, response.body?.string().orEmpty(), "saving to $table")
            }
        }

    /**
     * Call a database function.
     *
     * This is how the app writes anything with rules attached —
     * `apply_extraction`, `extraction_failed` — so the rules live in one place
     * that a client cannot route around.
     */
    suspend fun rpc(name: String, args: JSONObject): String = withContext(Dispatchers.IO) {
        client.newCall(
            authorised(
                Request.Builder()
                    .url("$rest/rpc/$name")
                    .post(args.toString().toRequestBody(jsonMedia))
            ).build()
        ).execute().use { response ->
            val text = response.body?.string().orEmpty()
            check(response, text, name)
            text
        }
    }

    suspend inline fun <reified T> rpcAs(name: String, args: JSONObject): T =
        json.decodeFromString(rpc(name, args))

    // ----------------------------------------------------------------- storage

    /**
     * Upload one photo to the private bucket.
     *
     * `x-upsert` makes this idempotent: a retry after a dropped connection
     * overwrites the same object rather than creating a second one, which
     * matters because the retry path is the normal path in the field.
     */
    suspend fun uploadImage(bytes: ByteArray, path: String) = withContext(Dispatchers.IO) {
        client.newCall(
            authorised(
                Request.Builder()
                    .url("$storage/object/$IMAGE_BUCKET/$path")
                    .post(bytes.toRequestBody(jpegMedia))
                    .header("x-upsert", "true")
            ).build()
        ).execute().use { response ->
            check(response, response.body?.string().orEmpty(), "uploading the photo")
        }
    }

    /**
     * A short-lived URL for one image, minted by an edge function rather than
     * by the client, so the TTL and the permission check live server-side where
     * nobody can lengthen either.
     */
    suspend fun signedImageUrl(path: String): String {
        val body = callFunction("sign-image", JSONObject().put("path", path))
        return JSONObject(body).getString("url")
    }

    suspend fun callFunction(name: String, body: JSONObject): String =
        withContext(Dispatchers.IO) {
            client.newCall(
                authorised(
                    Request.Builder()
                        .url("$functions/$name")
                        .post(body.toString().toRequestBody(jsonMedia))
                ).build()
            ).execute().use { response ->
                val text = response.body?.string().orEmpty()
                check(response, text, name)
                text
            }
        }

    // ---------------------------------------------------------------- plumbing

    private suspend fun authorised(builder: Request.Builder): Request.Builder {
        val token = validToken()
        return builder
            .header("apikey", anonKey)
            .header("Authorization", "Bearer $token")
    }

    /**
     * Turn an HTTP failure into something a driver can act on.
     *
     * PostgREST error bodies are precise and completely unreadable to anyone
     * who has not seen one before. The two that actually reach a driver — a
     * duplicate ticket and an RLS refusal — get plain sentences; everything
     * else gets a generic line and the detail goes to the log.
     */
    private fun check(response: Response, body: String, context: String) {
        if (response.isSuccessful) return

        Log.w(TAG, "$context failed ${response.code}")

        val duplicate = body.contains("23505") || body.contains("duplicate key")
        throw when {
            duplicate -> SupabaseException.Duplicate
            response.code == 401 || response.code == 403 -> SupabaseException.NotPermitted
            response.code == 429 || body.contains("53400") ->
                SupabaseException.Server("Too many at once. Give it a minute.")
            else -> SupabaseException.Server("Could not finish $context (${response.code}).")
        }
    }
}

sealed class SupabaseException(message: String) : Exception(message) {
    data object SignedOut : SupabaseException("Your session has ended. Sign in again.")
    data object NotPermitted : SupabaseException("You are not allowed to do that.")
    data object Duplicate : SupabaseException("That ticket has already been filed.")
    class Server(message: String) : SupabaseException(message)
}
