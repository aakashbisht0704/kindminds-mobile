/**
 * `cactus-react-native` is not used on Android.
 *
 * Its bundled engine implements Whisper, Moonshine, Parakeet and LFM2-VL, but
 * not the Whistle (Shruti) or Mirage architectures. Voice and vision go through
 * the native Cactus 4.1 bridge in android/app/src/main/cpp instead, so the
 * package is excluded to avoid shipping a second, incompatible engine.
 */
module.exports = {
  dependencies: {
    'cactus-react-native': {
      platforms: {
        android: null,
      },
    },
  },
};
