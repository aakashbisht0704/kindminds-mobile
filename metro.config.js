const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Shruti and Mirage use the Cactus `.cact` container, and the bundled build
// carries the text model as a `.gguf`. Metro only packages explicitly
// registered asset extensions, so add both before the asset registry is built.
if (!config.resolver.assetExts.includes('cact')) {
  config.resolver.assetExts.push('cact');
}
if (!config.resolver.assetExts.includes('gguf')) {
  config.resolver.assetExts.push('gguf');
}

// The lite build must not carry 50 MB of model weights it cannot run. The
// source import stays the same; Metro swaps in an empty asset manifest.
const lite = process.env.EXPO_PUBLIC_KINDMINDS_LITE === '1' || process.env.KINDMINDS_LITE === '1';
if (lite) {
  const originalResolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === './model-assets') {
      return context.resolveRequest(context, './model-assets.lite', platform);
    }
    if (originalResolveRequest) {
      return originalResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;

// Gradle writes and deletes CMake scratch directories under android/ while it
// builds. Watching them crashes Metro with ENOENT the moment a build cleans up,
// which happens routinely after `assembleRelease`, so keep the watcher out.
{
  const patterns = [/[\/]android[\/](app[\/])?\.cxx[\/].*/];
  config.watcher = config.watcher ?? {};
  const existing = config.watcher.blockList;
  const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
  config.watcher.blockList = [...list, ...patterns];
}
