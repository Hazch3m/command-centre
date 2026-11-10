import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import HealthKit
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
        CAPPluginMethod(name: "healthAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthAuthorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthWorkouts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthWorkoutDetail", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthDaily", returnType: CAPPluginReturnPromise),
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

    // MARK: Apple Health (read only): runs, heart rate, routes, resting HR, HRV, sleep, VO2 max

    private let health = HKHealthStore()
    private static let bpm = HKUnit.count().unitDivided(by: .minute())
    private static func ms(_ d: Date) -> Double { d.timeIntervalSince1970 * 1000 }

    @objc func healthAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func healthAuthorize(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health isn't available on this device")
            return
        }
        var read: Set<HKObjectType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
        let ids: [HKQuantityTypeIdentifier] = [.heartRate, .distanceWalkingRunning, .restingHeartRate, .heartRateVariabilitySDNN, .vo2Max, .activeEnergyBurned]
        for id in ids { if let t = HKObjectType.quantityType(forIdentifier: id) { read.insert(t) } }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { read.insert(sleep) }
        health.requestAuthorization(toShare: nil, read: read) { ok, error in
            if let error = error { call.reject(error.localizedDescription); return }
            call.resolve(["ok": ok])
        }
    }

    /// Running workouts since a time (ms), oldest first, with average and max heart rate.
    @objc func healthWorkouts(_ call: CAPPluginCall) {
        let since = Date(timeIntervalSince1970: (call.getDouble("since") ?? 0) / 1000)
        let limit = call.getInt("limit") ?? 400
        let pred = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForWorkouts(with: .running),
            HKQuery.predicateForSamples(withStart: since, end: nil, options: []),
        ])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        let q = HKSampleQuery(sampleType: .workoutType(), predicate: pred, limit: limit, sortDescriptors: [sort]) { _, samples, error in
            if let error = error { call.reject(error.localizedDescription); return }
            let ws = (samples as? [HKWorkout]) ?? []
            var out: [[String: Any]] = ws.map { w in
                var o: [String: Any] = [
                    "uuid": w.uuid.uuidString,
                    "start": CCNativePlugin.ms(w.startDate),
                    "end": CCNativePlugin.ms(w.endDate),
                    "duration": w.duration,
                    "distance": w.totalDistance?.doubleValue(for: .meter()) ?? 0,
                    "source": w.sourceRevision.source.name,
                    "indoor": (w.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber)?.boolValue ?? false,
                ]
                if let e = w.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity { o["elevation"] = e.doubleValue(for: .meter()) }
                if let tz = w.metadata?[HKMetadataKeyTimeZone] as? String { o["timeZone"] = tz }
                return o
            }
            guard let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate), !ws.isEmpty else {
                call.resolve(["workouts": out])
                return
            }
            let group = DispatchGroup()
            let lock = NSLock()
            for (i, w) in ws.enumerated() {
                group.enter()
                let p = HKQuery.predicateForSamples(withStart: w.startDate, end: w.endDate, options: [])
                let sq = HKStatisticsQuery(quantityType: hrType, quantitySamplePredicate: p, options: [.discreteAverage, .discreteMax]) { _, st, _ in
                    lock.lock()
                    if let a = st?.averageQuantity()?.doubleValue(for: CCNativePlugin.bpm) { out[i]["avgHr"] = a }
                    if let m = st?.maximumQuantity()?.doubleValue(for: CCNativePlugin.bpm) { out[i]["maxHr"] = m }
                    lock.unlock()
                    group.leave()
                }
                self.health.execute(sq)
            }
            group.notify(queue: .main) { call.resolve(["workouts": out]) }
        }
        health.execute(q)
    }

    /// One workout's heart rate, distance and route samples: [time ms, value…].
    @objc func healthWorkoutDetail(_ call: CAPPluginCall) {
        guard let s = call.getString("uuid"), let id = UUID(uuidString: s) else {
            call.reject("missing workout id")
            return
        }
        let q = HKSampleQuery(sampleType: .workoutType(), predicate: HKQuery.predicateForObject(with: id), limit: 1, sortDescriptors: nil) { _, samples, error in
            guard let w = samples?.first as? HKWorkout else {
                call.reject(error?.localizedDescription ?? "That workout isn't in Apple Health any more")
                return
            }
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let during = HKQuery.predicateForSamples(withStart: w.startDate, end: w.endDate, options: [])
            let group = DispatchGroup()
            let lock = NSLock()
            var hr: [[Double]] = []
            var dist: [[Double]] = []
            var route: [[Double]] = []
            if let t = HKQuantityType.quantityType(forIdentifier: .heartRate) {
                group.enter()
                self.health.execute(HKSampleQuery(sampleType: t, predicate: during, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, ss, _ in
                    let xs = (ss as? [HKQuantitySample] ?? []).map { [CCNativePlugin.ms($0.startDate), $0.quantity.doubleValue(for: CCNativePlugin.bpm)] }
                    lock.lock(); hr = xs; lock.unlock()
                    group.leave()
                })
            }
            if let t = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning) {
                group.enter()
                self.health.execute(HKSampleQuery(sampleType: t, predicate: during, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, ss, _ in
                    let xs = (ss as? [HKQuantitySample] ?? []).map { [CCNativePlugin.ms($0.endDate), $0.quantity.doubleValue(for: .meter())] }
                    lock.lock(); dist = xs; lock.unlock()
                    group.leave()
                })
            }
            group.enter()
            self.health.execute(HKSampleQuery(sampleType: HKSeriesType.workoutRoute(), predicate: HKQuery.predicateForObjects(from: w), limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, rs, _ in
                guard let r = rs?.first as? HKWorkoutRoute else { group.leave(); return }
                var pts: [[Double]] = []
                var left = true
                let rq = HKWorkoutRouteQuery(route: r) { _, locs, done, err in
                    for l in locs ?? [] { pts.append([CCNativePlugin.ms(l.timestamp), l.coordinate.latitude, l.coordinate.longitude, l.altitude, l.speed]) }
                    if (done || err != nil) && left {
                        left = false
                        lock.lock(); route = pts; lock.unlock()
                        group.leave()
                    }
                }
                self.health.execute(rq)
            })
            group.notify(queue: .main) { call.resolve(["hr": hr, "dist": dist, "route": route]) }
        }
        health.execute(q)
    }

    /// Daily resting heart rate, HRV (SDNN), VO2 max and last night's sleep since a time (ms).
    @objc func healthDaily(_ call: CAPPluginCall) {
        let cal = Calendar.current
        let since = cal.startOfDay(for: Date(timeIntervalSince1970: (call.getDouble("since") ?? 0) / 1000))
        let now = Date()
        let fmt = DateFormatter()
        fmt.calendar = cal
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        var days: [String: [String: Double]] = [:]
        let lock = NSLock()
        let group = DispatchGroup()
        func daily(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit, _ key: String) {
            guard let t = HKQuantityType.quantityType(forIdentifier: id) else { return }
            group.enter()
            let q = HKStatisticsCollectionQuery(quantityType: t, quantitySamplePredicate: HKQuery.predicateForSamples(withStart: since, end: now, options: []), options: .discreteAverage, anchorDate: since, intervalComponents: DateComponents(day: 1))
            q.initialResultsHandler = { _, res, _ in
                res?.enumerateStatistics(from: since, to: now) { st, _ in
                    if let v = st.averageQuantity()?.doubleValue(for: unit) {
                        lock.lock(); days[fmt.string(from: st.startDate), default: [:]][key] = v; lock.unlock()
                    }
                }
                group.leave()
            }
            health.execute(q)
        }
        daily(.restingHeartRate, CCNativePlugin.bpm, "rhr")
        daily(.heartRateVariabilitySDNN, .secondUnit(with: .milli), "hrv")
        daily(.vo2Max, HKUnit(from: "ml/(kg*min)"), "vo2")
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            group.enter()
            let q = HKSampleQuery(sampleType: sleep, predicate: HKQuery.predicateForSamples(withStart: since.addingTimeInterval(-86400), end: now, options: []), limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, ss, _ in
                // Time asleep (any stage; not in bed or awake), counted to the day you woke up.
                let inBed = HKCategoryValueSleepAnalysis.inBed.rawValue
                let awake: Int = { if #available(iOS 16.0, *) { return HKCategoryValueSleepAnalysis.awake.rawValue } else { return -1 } }()
                var bySource: [String: [String: Double]] = [:]
                for x in (ss as? [HKCategorySample] ?? []) where x.value != inBed && x.value != awake {
                    let day = fmt.string(from: x.endDate)
                    bySource[x.sourceRevision.source.bundleIdentifier, default: [:]][day, default: 0] += x.endDate.timeIntervalSince(x.startDate)
                }
                // Several apps can record the same night: take the one with the most sleep each night, not the sum.
                var best: [String: Double] = [:]
                for (_, perDay) in bySource { for (d, v) in perDay { best[d] = max(best[d] ?? 0, v) } }
                lock.lock()
                for (d, v) in best { days[d, default: [:]]["sleep"] = v }
                lock.unlock()
                group.leave()
            }
            health.execute(q)
        }
        group.notify(queue: .main) {
            call.resolve(["days": days.keys.sorted().map { d -> [String: Any] in var o: [String: Any] = days[d]!; o["date"] = d; return o }])
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
