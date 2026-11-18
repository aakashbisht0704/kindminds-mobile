package org.kindminds.kit

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.util.concurrent.Executors

/**
 * Copies a model that ships inside the APK's `assets/` into app storage.
 *
 * The text model is ~940 MiB, which is far beyond what Metro can package as a
 * JavaScript asset (Node cannot build a string that large), so it is placed in
 * `android/app/src/main/assets/models/` and streamed out here instead. The copy
 * is atomic: bytes go to `<destination>.part`, the size is checked, and only
 * then is the file renamed into place, so an interrupted copy never leaves a
 * half model that llama.cpp would try to load.
 *
 * The asset is stored uncompressed (`androidResources { noCompress 'gguf' }`),
 * so AssetManager streams it instead of inflating a gigabyte into memory.
 */
class ModelAssetModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val worker = Executors.newSingleThreadExecutor()

  override fun getName(): String = "ModelAsset"

  @ReactMethod
  fun copyAsset(assetPath: String, destination: String, expectedBytes: Double, promise: Promise) {
    worker.execute {
      val target = File(destination)
      val partial = File("$destination.part")
      try {
        target.parentFile?.mkdirs()
        if (partial.exists() && !partial.delete()) {
          promise.reject("model_asset", "The partial model file could not be replaced.")
          return@execute
        }

        var copied = 0L
        reactApplicationContext.assets.open(assetPath, android.content.res.AssetManager.ACCESS_STREAMING).use { input ->
          partial.outputStream().buffered(BUFFER_BYTES).use { output ->
            val buffer = ByteArray(BUFFER_BYTES)
            while (true) {
              val read = input.read(buffer)
              if (read <= 0) break
              output.write(buffer, 0, read)
              copied += read
            }
            output.flush()
          }
        }

        val expected = expectedBytes.toLong()
        if (expected > 0 && copied != expected) {
          partial.delete()
          promise.reject(
            "model_asset",
            "The included model copied $copied bytes, expected $expected.",
          )
          return@execute
        }

        if (target.exists() && !target.delete()) {
          partial.delete()
          promise.reject("model_asset", "The existing model file could not be replaced.")
          return@execute
        }
        if (!partial.renameTo(target)) {
          partial.delete()
          promise.reject("model_asset", "The included model could not be moved into place.")
          return@execute
        }
        promise.resolve(copied.toDouble())
      } catch (error: Throwable) {
        partial.delete()
        promise.reject("model_asset", error.message ?: "The included model could not be copied.")
      }
    }
  }

  companion object {
    private const val BUFFER_BYTES = 1 shl 20
  }
}
