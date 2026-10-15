'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_DEPENDENCIES, visibleFile } = require('./files');
const config = { showDependencies: false, includedDependencyFolders: [], dependencyFolders: DEFAULT_DEPENDENCIES };
for (const root of ['/Users/dev/project', '/C:/Work/project']) {
  test(`filters dependencies and permits selected libraries for ${root}`, () => {
    const folder = { uri: { path: root } };
    assert.equal(visibleFile({ path: root + '/source/main.cpp' }, folder, config), true);
    assert.equal(visibleFile({ path: root + '/JUCE/modules/audio.h' }, folder, config), false);
    assert.equal(visibleFile({ path: '/SDK/Qt/include/object.h' }, undefined, config), false);
    assert.equal(visibleFile({ path: root + '/JUCE/modules/audio.h' }, folder, { ...config, includedDependencyFolders: ['JUCE'] }), true);
    assert.equal(visibleFile({ path: '/SDK/Qt/include/object.h' }, undefined, { ...config, includedDependencyFolders: ['Qt'] }), true);
    assert.equal(visibleFile({ path: '/SDK/system.h' }, undefined, { ...config, showDependencies: true }), true);
  });
}
