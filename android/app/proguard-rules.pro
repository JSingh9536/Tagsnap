# R8 rules.
#
# Short, because there is very little reflection in this app. The two things
# that need help are kotlinx.serialization, which generates serializers R8
# cannot see are used, and the model classes those serializers name.

# --- kotlinx.serialization ---------------------------------------------------
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Every @Serializable model and its generated serializer. Without this, R8
# strips the serializer and every response decodes as an empty list — which
# looks exactly like "the driver has no tickets" rather than like a crash.
-keep,includedescriptorclasses class com.tagsnap.net.**$$serializer { *; }
-keepclassmembers class com.tagsnap.net.** {
    *** Companion;
}
-keepclasseswithmembers class com.tagsnap.net.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# --- ML Kit -------------------------------------------------------------------
# The bundled text recognition model is loaded by name at runtime.
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# --- OkHttp -------------------------------------------------------------------
-dontwarn okhttp3.**
-dontwarn okio.**

# --- WorkManager --------------------------------------------------------------
# The worker is instantiated reflectively from a class name in the database.
-keep class com.tagsnap.store.UploadWorker { *; }
