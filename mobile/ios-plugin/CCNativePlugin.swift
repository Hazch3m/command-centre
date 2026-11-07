import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import UIKit
import WebKit

/// Pacelife's own native abilities for the web app inside:
/// - signInWithApple: Apple's sign-in sheet; returns Apple's identity token (checked by the sync service).
/// - garminLogin: Garmin's real sign-in page in its own window; returns the one-time ticket Garmin gives
///   at the end (the password never touches the app).
@objc(CCNativePlugin)
public class CCNativePlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "CCNativePlugin"
    public let jsName = "CCNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signInWithApple", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "garminLogin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAuth", returnType: CAPPluginReturnPromise),
    ]
    private var appleCall: CAPPluginCall?
    private var appleController: ASAuthorizationController?

    // MARK: Sign in with Apple

    @objc func signInWithApple(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("missing nonce")
            return
        }
        let hashed = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email]
            request.nonce = hashed
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.appleCall = call
            self.appleController = controller
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.identityToken,
              let token = String(data: data, encoding: .utf8)
        else {
            appleCall?.reject("Apple didn't return a sign-in token")
            appleCall = nil
            return
        }
        appleCall?.resolve(["identityToken": token, "email": credential.email ?? ""])
        appleCall = nil
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        if let e = error as? ASAuthorizationError, e.code == .canceled {
            appleCall?.reject("cancelled", "CANCELLED")
        } else {
            appleCall?.reject(error.localizedDescription)
        }
        appleCall = nil
    }

    // MARK: Other sign-ins (Google): Apple's secure sign-in sheet, which Google allows (embedded web views it blocks)

    private var authSession: ASWebAuthenticationSession?

    @objc func openAuth(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s), url.scheme == "https" else {
            call.reject("bad url")
            return
        }
        let scheme = call.getString("scheme") ?? "commandcentre"
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                self.authSession = nil
                if let callback = callback {
                    call.resolve(["url": callback.absoluteString])
                } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    call.reject("cancelled", "CANCELLED")
                } else {
                    call.reject(error?.localizedDescription ?? "Sign-in didn't finish")
                }
            }
            session.presentationContextProvider = self
            self.authSession = session
            session.start()
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    // MARK: Garmin sign-in

    @objc func garminLogin(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s), url.scheme == "https", url.host == "sso.garmin.com" else {
            call.reject("not Garmin's sign-in page")
            return
        }
        DispatchQueue.main.async {
            let login = GarminLoginController(url: url) { ticket in
                if let t = ticket {
                    call.resolve(["ticket": t])
                } else {
                    call.reject("cancelled", "CANCELLED")
                }
            }
            let nav = UINavigationController(rootViewController: login)
            nav.isModalInPresentation = true
            self.bridge?.viewController?.present(nav, animated: true)
        }
    }
}

/// Garmin's sign-in page. Stops at the redirect to connect.garmin.com/app?ticket=ST-… and hands the ticket back.
final class GarminLoginController: UIViewController, WKNavigationDelegate {
    private let url: URL
    private let done: (String?) -> Void
    private var finished = false
    private var web: WKWebView!
    private let spinner = UIActivityIndicatorView(style: .medium)

    init(url: URL, done: @escaping (String?) -> Void) {
        self.url = url
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Sign in to Garmin"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
        navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: view.bounds, configuration: config)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.navigationDelegate = self
        view.addSubview(web)
        spinner.startAnimating()
        web.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = navigationAction.request.url, u.host == "connect.garmin.com",
           let ticket = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "ticket" })?.value,
           ticket.hasPrefix("ST-") {
            decisionHandler(.cancel)
            finish(ticket)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { spinner.startAnimating() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { spinner.stopAnimating() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { spinner.stopAnimating() }

    @objc private func cancel() { finish(nil) }

    private func finish(_ ticket: String?) {
        guard !finished else { return }
        finished = true
        dismiss(animated: true) { self.done(ticket) }
    }
}
