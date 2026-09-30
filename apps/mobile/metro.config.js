// Metro needs to be told about the monorepo, or it will not follow the symlink
// into packages/shared and will resolve two copies of React.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

// Look in the app's own node_modules first, then the hoisted root. Order
// matters: reversing it is how you end up with two Reacts and a runtime that
// insists hooks are being called outside a component.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
