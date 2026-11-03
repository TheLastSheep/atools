import Cocoa
import WebKit

final class ResultReceiver: NSObject, WKScriptMessageHandler {
    var finished = false
    var persistent = true
    func finish(_ value: [String: Any]) {
        if finished { return }
        finished = true
        var report = value
        report["nativeNonPersistentDataStore"] = !persistent
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            print("WK_TRANSPORT_RESULT " + text)
            fflush(stdout)
        }
        NSApplication.shared.terminate(nil)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let value = message.body as? [String: Any] else { return }
        finish(value)
    }
}

guard CommandLine.arguments.count == 2 else { fatalError("Expected HTML fixture path") }
let html = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let receiver = ResultReceiver()
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
configuration.userContentController.add(receiver, name: "transportResult")
receiver.persistent = configuration.websiteDataStore.isPersistent
let webview = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 320), configuration: configuration)
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 640, height: 320),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "ATools temporary original-plugin check"
window.contentView = webview
window.makeKeyAndOrderFront(nil)
webview.loadHTMLString(html, baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 35) {
    receiver.finish(["passed": false, "error": "WKWebView fixture timed out after 35 seconds"])
}
app.run()
