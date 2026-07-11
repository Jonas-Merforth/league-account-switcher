const pkg = require('./package.json');

module.exports = {
  ...pkg.build,
  appId: 'com.merforth.league-account-switcher.beta',
  productName: 'League Account Switcher Beta',
  artifactName: 'league-account-switcher-beta-${version}-${arch}.${ext}',
  directories: {
    ...pkg.build.directories,
    output: 'dist-beta'
  },
  extraMetadata: {
    buildChannel: 'beta',
    productName: 'League Account Switcher Beta',
    description: 'League Account Switcher Beta - Queue Relay Test Build'
  },
  publish: [],
  win: {
    ...pkg.build.win,
    executableName: 'League Account Switcher Beta',
    artifactName: 'league-account-switcher-beta-${version}-${arch}.${ext}'
  },
  nsis: {
    ...pkg.build.nsis,
    shortcutName: 'League Account Switcher Beta',
    uninstallDisplayName: 'League Account Switcher Beta'
  }
};
