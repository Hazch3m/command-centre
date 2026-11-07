import Capacitor
import UIKit

/// The app's web view, with Pacelife's native plugin added.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CCNativePlugin())
    }
}
