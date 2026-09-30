import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    // Firebase Messaging needs google-services.json, which is per-project and
    // not committed. The plugin is applied only when that file exists, so a
    // fresh checkout builds and runs without push rather than failing at
    // configuration time with a message about a missing JSON file.
}

/**
 * Where this build points.
 *
 * `local.properties` wins over `gradle.properties`, so a developer can point a
 * debug build at their own project without touching a tracked file.
 */
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun setting(key: String): String =
    localProperties.getProperty(key)
        ?: project.findProperty(key) as String?
        ?: error("$key is not set. See android/local.properties.example.")

val hasFirebase = rootProject.file("app/google-services.json").exists()
if (hasFirebase) apply(plugin = "com.google.gms.google-services")

android {
    namespace = "com.tagsnap"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.tagsnap.field"
        // API 26 (Android 8.0, 2017). A phone that lives in a truck is
        // frequently a very old phone, and ML Kit's bundled text recognition
        // runs happily down here. Below 26 the platform lacks adaptive icons
        // and a working java.time, and the device is a decade old.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "SUPABASE_URL", "\"${setting("SUPABASE_URL")}\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"${setting("SUPABASE_ANON_KEY")}\"")
        buildConfigField("boolean", "HAS_PUSH", hasFirebase.toString())
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)

    // The two that replaced a paid vision API. Both on-device, both free at
    // any volume, both work with the phone in aeroplane mode.
    implementation(libs.mlkit.text.recognition)
    implementation(libs.mlkit.document.scanner)

    implementation(libs.play.services.location)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.biometric)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    // Always compiled in, even when google-services.json is absent. The
    // library compiles fine without it; only the *plugin* needs the JSON, and
    // only to generate the project ids. Keeping the dependency unconditional
    // means the manifest can name the messaging service unconditionally, and a
    // fresh checkout builds and runs — just without push, which is stated on
    // the account screen rather than failing silently.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
    // The real org.json, not the android.jar stub that returns defaults. The
    // parser builds its payload with JSONObject, and a test asserting against
    // a stub would pass while shipping an empty extraction.
    testImplementation("org.json:json:20240303")
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.espresso.core)
}
