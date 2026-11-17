const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Shruti and Mirage use the Cactus `.cact` container. Metro only packages
// explicitly registered asset extensions, so add it before the asset registry
// is built.
if (!config.resolver.assetExts.includes('cact')) {
  config.resolver.assetExts.push('cact');
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
