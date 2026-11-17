/**
 * JNI bridge to the Cactus 4.1 engine.
 *
 * The bundled Shruti (Whistle) and Mirage models are single-file `.cact`
 * deployment archives, which the 4.1 engine loads from memory. The React
 * Native Cactus wrapper in node_modules only understands the older unpacked
 * weight format and does not implement the Whistle/Mirage architectures, so
 * it cannot start either model. This bridge talks to the engine directly.
 */

#if defined(__aarch64__)

#include <android/log.h>
#include <jni.h>

#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>
#include <vector>

#include "cactus.h"

#define TAG "KindMindsCactus"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

std::mutex g_mutex;
std::string g_currentModel;
std::string g_lastError;

constexpr size_t kTranscribeBuffer = 1u << 20;   // 1 MiB
constexpr size_t kDescribeBuffer = 16u << 20;    // 16 MiB
constexpr int kThreads = 2;

std::string fromJString(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

jstring toJString(JNIEnv* env, const std::string& value) {
  return env->NewStringUTF(value.c_str());
}

void setError(const char* fallback) {
  const char* message = cactus_last_error();
  g_lastError = (message != nullptr && message[0] != '\0') ? message : fallback;
}

bool readFile(const std::string& path, std::vector<uint8_t>& out) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    g_lastError = "Could not open " + path;
    return false;
  }
  out.assign(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
  if (out.empty()) {
    g_lastError = "The model file is empty.";
    return false;
  }
  return true;
}

bool loadModelLocked(const std::string& path, int& models) {
  if (!g_currentModel.empty() && g_currentModel == path) {
    models = cactus_models();
    return true;
  }

  std::vector<uint8_t> bytes;
  if (!readFile(path, bytes)) return false;

  if (cactus_load(bytes.data(), bytes.size()) < 0) {
    setError("Cactus could not load that model.");
    g_currentModel.clear();
    LOGE("cactus_load failed: %s", g_lastError.c_str());
    return false;
  }

  cactus_set_threads(kThreads);
  models = cactus_models();
  g_currentModel = path;
  LOGI("loaded model %s (capabilities=%d)", path.c_str(), models);
  return true;
}

uint16_t readU16(const std::vector<uint8_t>& bytes, size_t offset) {
  return static_cast<uint16_t>(bytes[offset]) |
         static_cast<uint16_t>(bytes[offset + 1] << 8);
}

uint32_t readU32(const std::vector<uint8_t>& bytes, size_t offset) {
  return static_cast<uint32_t>(bytes[offset]) |
         (static_cast<uint32_t>(bytes[offset + 1]) << 8) |
         (static_cast<uint32_t>(bytes[offset + 2]) << 16) |
         (static_cast<uint32_t>(bytes[offset + 3]) << 24);
}

bool readWavPcm(const std::string& path, std::vector<float>& samples) {
  std::vector<uint8_t> bytes;
  if (!readFile(path, bytes)) return false;
  if (bytes.size() < 44 || std::memcmp(bytes.data(), "RIFF", 4) != 0 ||
      std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    g_lastError = "The recording is not a WAV file.";
    return false;
  }

  size_t formatOffset = 0;
  size_t dataOffset = 0;
  size_t dataSize = 0;
  size_t cursor = 12;
  while (cursor + 8 <= bytes.size()) {
    const uint32_t chunkSize = readU32(bytes, cursor + 4);
    const size_t payload = cursor + 8;
    if (payload + chunkSize > bytes.size()) break;
    if (std::memcmp(bytes.data() + cursor, "fmt ", 4) == 0) {
      formatOffset = payload;
    } else if (std::memcmp(bytes.data() + cursor, "data", 4) == 0) {
      dataOffset = payload;
      dataSize = chunkSize;
    }
    cursor = payload + chunkSize + (chunkSize & 1u);
  }

  if (formatOffset == 0 || dataOffset == 0 || dataSize == 0) {
    g_lastError = "The recording has no audio data.";
    return false;
  }

  const uint16_t format = readU16(bytes, formatOffset);
  const uint16_t channels = readU16(bytes, formatOffset + 2);
  const uint32_t sampleRate = readU32(bytes, formatOffset + 4);
  const uint16_t bits = readU16(bytes, formatOffset + 14);

  if (format != 1 || channels != 1 || bits != 16 || sampleRate != 16000) {
    g_lastError = "The recording is not 16 kHz mono 16-bit PCM.";
    return false;
  }

  const size_t count = dataSize / 2;
  samples.resize(count);
  for (size_t i = 0; i < count; ++i) {
    const int16_t value = static_cast<int16_t>(readU16(bytes, dataOffset + i * 2));
    samples[i] = static_cast<float>(value) / 32768.0f;
  }
  return true;
}

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL
Java_org_kindminds_kit_CactusEngineModule_nativeLoadModel(JNIEnv* env, jobject, jstring path) {
  std::lock_guard<std::mutex> lock(g_mutex);
  int models = 0;
  if (!loadModelLocked(fromJString(env, path), models)) return -1;
  return models;
}

JNIEXPORT jstring JNICALL
Java_org_kindminds_kit_CactusEngineModule_nativeLastError(JNIEnv* env, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return toJString(env, g_lastError);
}

JNIEXPORT jstring JNICALL
Java_org_kindminds_kit_CactusEngineModule_nativeTranscribe(JNIEnv* env, jobject, jstring wavPath) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_currentModel.empty()) {
    g_lastError = "No Cactus model is loaded.";
    return nullptr;
  }

  std::vector<float> samples;
  if (!readWavPcm(fromJString(env, wavPath), samples)) return nullptr;

  std::vector<char> buffer(kTranscribeBuffer, 0);
  const int code = cactus_transcribe(samples.data(), static_cast<int>(samples.size()), nullptr,
                                     nullptr, 0, buffer.data(), static_cast<int>(buffer.size()));
  if (code < 0) {
    setError("Cactus could not transcribe that recording.");
    LOGE("cactus_transcribe failed: %s", g_lastError.c_str());
    return nullptr;
  }
  return toJString(env, std::string(buffer.data()));
}

JNIEXPORT jstring JNICALL
Java_org_kindminds_kit_CactusEngineModule_nativeDescribe(JNIEnv* env, jobject, jbyteArray rgb,
                                                         jint width, jint height,
                                                         jstring optionsJson) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_currentModel.empty()) {
    g_lastError = "No Cactus model is loaded.";
    return nullptr;
  }
  if (rgb == nullptr || width <= 0 || height <= 0) {
    g_lastError = "The image has no pixels.";
    return nullptr;
  }

  const jsize length = env->GetArrayLength(rgb);
  if (length != width * height * 3) {
    g_lastError = "The image is not packed RGB.";
    return nullptr;
  }

  std::vector<unsigned char> pixels(static_cast<size_t>(length));
  env->GetByteArrayRegion(rgb, 0, length, reinterpret_cast<jbyte*>(pixels.data()));
  const std::string options = fromJString(env, optionsJson);

  std::vector<char> buffer(kDescribeBuffer, 0);
  const int code = cactus_describe(pixels.data(), width, height,
                                   options.empty() ? "{}" : options.c_str(), nullptr, nullptr,
                                   buffer.data(), static_cast<int>(buffer.size()));
  if (code < 0) {
    setError("Cactus could not describe that image.");
    LOGE("cactus_describe failed: %s", g_lastError.c_str());
    return nullptr;
  }
  return toJString(env, std::string(buffer.data()));
}

}  // extern "C"

#endif  // defined(__aarch64__)
