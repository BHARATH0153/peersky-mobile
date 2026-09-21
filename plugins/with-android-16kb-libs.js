const { withAppBuildGradle } = require('@expo/config-plugins')

// react-native-bare-kit ships prebuilt addons for several versions of the same
// native module and the Android source set packages all of them, whether the
// Bare bundle links against them or not. libsodium-native.4.3.3.so is one of
// those leftovers: nothing references it any more (the tree resolves a single
// sodium-native 5.1.0 via the sodium-universal override in package.json) but it
// is still copied into the APK.
//
// It matters because that one file is built with 4 KB LOAD segment alignment
// while every other library in the APK is 16 KB. Google Play requires 16 KB
// page size support, and on a 16 KB device Android drops the whole app into
// page size compatibility mode over this single stale binary.
//
// Dropping it at packaging time is safe precisely because nothing links to it.
// Remove this plugin once react-native-bare-kit stops shipping the old build.
const EXCLUDED_LIBRARIES = ['**/libsodium-native.4.3.3.so']

const MARKER = 'PeerSky 16 KB page size'

function addJniLibExcludes (contents) {
  if (contents.includes(MARKER)) return contents

  const block = [
    '',
    'android {',
    '    packagingOptions {',
    '        jniLibs {',
    `            // ${MARKER}: drop stale 4 KB aligned prebuilts nothing links to.`,
    ...EXCLUDED_LIBRARIES.map((pattern) => `            excludes += '${pattern}'`),
    '        }',
    '    }',
    '}',
    ''
  ].join('\n')

  return `${contents.trimEnd()}\n${block}`
}

module.exports = function withAndroid16kbLibs (config) {
  return withAppBuildGradle(config, (androidConfig) => {
    if (androidConfig.modResults.language !== 'groovy') {
      throw new Error('The 16 KB alignment plugin expects a Groovy app/build.gradle.')
    }
    androidConfig.modResults.contents = addJniLibExcludes(androidConfig.modResults.contents)
    return androidConfig
  })
}

module.exports.addJniLibExcludes = addJniLibExcludes
module.exports.EXCLUDED_LIBRARIES = EXCLUDED_LIBRARIES
