# Adds Command Centre's native plugin and entitlements to the Capacitor Xcode project.
require 'xcodeproj'
project = Xcodeproj::Project.open('ios/App/App.xcodeproj')
target = project.targets.find { |t| t.name == 'App' } or abort 'no App target'
group = project.main_group.find_subpath('App', false) or abort 'no App group'
%w[CCNativePlugin.swift MainViewController.swift].each do |f|
  next if group.files.any? { |r| r.path == f }
  target.add_file_references([group.new_reference(f)])
end
group.new_reference('App.entitlements') unless group.files.any? { |r| r.path == 'App.entitlements' }
target.build_configurations.each do |c|
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
  c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
  c.build_settings['TARGETED_DEVICE_FAMILY'] = '1'
end
project.save
puts 'Added the native plugin and Sign in with Apple to the project'
