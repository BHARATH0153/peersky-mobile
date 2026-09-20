const { withDangerousMod } = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// Xcode 27 refuses to build targets below iOS 15. react_native_post_install
// already raises pod native targets to RN's minimum, but it skips resource
// bundle targets, which keep their podspec's value (SDWebImage 9.0, RNSVG's
// filter bundle 12.4). Raise only those, and never lower a target that asks
// for a newer iOS than we do.
const DEPLOYMENT_TARGET = '16.0'

const POST_INSTALL_PATCH = `
    # react_native_post_install raises pod *native* targets to RN's minimum but
    # skips resource bundle targets, which keep whatever their podspec declared
    # (SDWebImage 9.0, RNSVG's filter bundle 12.4). Xcode 27 rejects anything
    # under 15.0. Raise only those; never lower a target that asks for more.
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        current = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current && current.to_f < ${DEPLOYMENT_TARGET}
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${DEPLOYMENT_TARGET}'
        end
      end
    end
`

module.exports = function withIosPodDeploymentTarget (config) {
  return withDangerousMod(config, ['ios', async (iosConfig) => {
    const podfilePath = path.join(iosConfig.modRequest.platformProjectRoot, 'Podfile')
    const podfile = fs.readFileSync(podfilePath, 'utf8')

    if (podfile.includes('IPHONEOS_DEPLOYMENT_TARGET')) return iosConfig

    const anchor = '      :ccache_enabled => ccache_enabled?(podfile_properties),\n    )\n'
    if (!podfile.includes(anchor)) {
      throw new Error('with-ios-pod-deployment-target: react_native_post_install anchor not found in Podfile')
    }

    fs.writeFileSync(podfilePath, podfile.replace(anchor, anchor + POST_INSTALL_PATCH))
    return iosConfig
  }])
}
