package org.kindminds.kit

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors

/**
 * Bridges Shruti (speech) and Mirage (vision) to the Cactus 4.1 engine.
 *
 * The engine lives in its own `libcactusbridge.so`, loaded only when a model is
 * actually used. It is deliberately not part of `appmodules`: a fault in the
 * engine must not prevent the app from starting.
 */
class CactusEngineModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val worker = Executors.newSingleThreadExecutor()

  @Volatile
  private var libraryLoaded = false

  override fun getName(): String = "CactusEngine"

  @ReactMethod
  fun loadModel(path: String, promise: Promise) {
    worker.execute {
      try {
        ensureLibrary()
        val models = nativeLoadModel(path)
        if (models < 0) {
          promise.reject("cactus_load", errorText(null))
        } else {
          promise.resolve(models)
        }
      } catch (error: Throwable) {
        promise.reject("cactus_load", errorText(error))
      }
    }
  }

  @ReactMethod
  fun transcribe(wavPath: String, promise: Promise) {
    worker.execute {
      try {
        ensureLibrary()
        val json = nativeTranscribe(wavPath)
        if (json == null) {
          promise.reject("cactus_transcribe", errorText(null))
        } else {
          promise.resolve(json)
        }
      } catch (error: Throwable) {
        promise.reject("cactus_transcribe", errorText(error))
      }
    }
  }

  @ReactMethod
  fun describe(imagePath: String, optionsJson: String, promise: Promise) {
    worker.execute {
      try {
        ensureLibrary()
        val bitmap = decodeBitmap(imagePath)
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        bitmap.recycle()

        val rgb = ByteArray(width * height * 3)
        var index = 0
        for (pixel in pixels) {
          rgb[index++] = ((pixel shr 16) and 0xFF).toByte()
          rgb[index++] = ((pixel shr 8) and 0xFF).toByte()
          rgb[index++] = (pixel and 0xFF).toByte()
        }

        val json = nativeDescribe(rgb, width, height, optionsJson)
        if (json == null) {
          promise.reject("cactus_describe", errorText(null))
        } else {
          promise.resolve(json)
        }
      } catch (error: Throwable) {
        promise.reject("cactus_describe", errorText(error))
      }
    }
  }

  private fun ensureLibrary() {
    if (libraryLoaded) return
    synchronized(this) {
      if (!libraryLoaded) {
        System.loadLibrary("cactusbridge")
        libraryLoaded = true
      }
    }
  }

  /** Decode and, for very large photos, downscale before handing pixels to the engine. */
  private fun decodeBitmap(path: String): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw IllegalArgumentException("Could not read that image.")
    }

    var sample = 1
    while (bounds.outWidth / sample > 1024 || bounds.outHeight / sample > 1024) {
      sample *= 2
    }

    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeFile(path, options)
      ?: throw IllegalArgumentException("Could not decode that image.")
  }

  private fun errorText(error: Throwable?): String {
    val native = try {
      nativeLastError()
    } catch (_: Throwable) {
      null
    }
    if (!native.isNullOrBlank()) return native
    return error?.message ?: "The Cactus engine could not complete that request."
  }

  private external fun nativeLoadModel(path: String): Int
  private external fun nativeLastError(): String?
  private external fun nativeTranscribe(wavPath: String): String?
  private external fun nativeDescribe(rgb: ByteArray, width: Int, height: Int, optionsJson: String): String?
}
