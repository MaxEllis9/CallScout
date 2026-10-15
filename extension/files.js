'use strict';

const DEFAULT_DEPENDENCIES = ['JUCE', 'Qt', 'third_party', 'third-party', '3rdparty', 'vendor', 'external', 'extern', 'node_modules'];
function visibleFile(uri, workspaceFolder, config) {
  if (config.showDependencies) return true;
  const parts = uri.path.split('/').map(part => part.toLowerCase());
  if (config.includedDependencyFolders.some(name => parts.includes(name.toLowerCase()))) return true;
  if (!workspaceFolder) return false;
  const relative = uri.path.slice(workspaceFolder.uri.path.length).split('/').map(part => part.toLowerCase());
  return !config.dependencyFolders.some(name => relative.includes(name.toLowerCase()));
}
module.exports = { DEFAULT_DEPENDENCIES, visibleFile };
