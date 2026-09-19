// Metro config for the monorepo. Workspace packages are written for Node's
// ESM resolution (relative imports end in ".js" while sources are ".ts");
// Metro resolves those to the TypeScript sources here. Everything else is
// Expo's default monorepo-aware config.
const { getDefaultConfig } = require('expo/metro-config');
const fs = require('node:fs');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const base = path.resolve(path.dirname(context.originModulePath), moduleName.slice(0, -3));
    for (const ext of ['.ts', '.tsx']) {
      if (fs.existsSync(base + ext)) {
        return { type: 'sourceFile', filePath: base + ext };
      }
    }
  }
  return defaultResolveRequest ? defaultResolveRequest(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
