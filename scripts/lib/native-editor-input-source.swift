// Test-only controller for two explicitly authorized original-editor fixed-input cases.
// Only fixed typing actions may select ABC; restoration requires ownership of that selection.
import AppKit
import Carbon
import CryptoKit
import Darwin
import Foundation

enum ControllerError: Error { case rejected(String) }
enum FixedEditorOperation: String, CaseIterable {
    case plainAlpha = "plain-alpha", plainBeta = "plain-beta", jsonValid = "json-valid"
    case jsonFormat = "json-format", jsonMalformed = "json-malformed", jsonRecovery = "json-recovery"
    var requiresABC: Bool { self != .jsonFormat }
}
enum InputSourceRestorationDecision { case keepCurrent, restoreOriginal, unverified }
enum InputSourceDisposition: String {
    case preserved, restored, interveningChange = "intervening-change", unverified
    var verified: Bool { self == .preserved || self == .restored }
}
func inputSourceRestorationDecision(didSelectABC: Bool, observedSourceID: String?) -> InputSourceRestorationDecision {
    guard didSelectABC else { return .keepCurrent }
    guard let identity = observedSourceID else { return .unverified }
    return identity == "com.apple.keylayout.ABC" ? .restoreOriginal : .keepCurrent
}
func finalInputSourceDisposition(didSelectABC: Bool, originalSourceID: String,
                                 afterActionSourceID: String?, finalSourceID: String?,
                                 restorationStatus: OSStatus?) -> InputSourceDisposition {
    guard let afterActionID = afterActionSourceID, let finalID = finalSourceID else { return .unverified }
    switch inputSourceRestorationDecision(didSelectABC: didSelectABC, observedSourceID: afterActionID) {
    case .restoreOriginal:
        guard restorationStatus == noErr, finalID == originalSourceID else { return .unverified }
        return .restored
    case .keepCurrent:
        guard restorationStatus == nil else { return .unverified }
        return afterActionID == originalSourceID && finalID == originalSourceID ? .preserved : .interveningChange
    case .unverified:
        return .unverified
    }
}
func reject(_ message: String) throws -> Never { throw ControllerError.rejected(message) }
func sourceID(_ source: TISInputSource) throws -> String {
    guard let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
        try reject("Input source has no identity")
    }
    return Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
}
func currentSource() -> TISInputSource { TISCopyCurrentKeyboardInputSource().takeRetainedValue() }
func sources() -> [TISInputSource] {
    TISCreateInputSourceList(nil, false).takeRetainedValue() as! [TISInputSource]
}
func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
func validateTargetIdentity(_ bundle: String, _ pid: String) throws -> pid_t {
    guard bundle.range(of: "^dev\\.atools\\.fixture\\.dialog\\.[0-9a-f]{32}$", options: .regularExpression) != nil,
          let number = Int32(pid), number > 1
    else { try reject("Only an identified temporary app and a fixed editor operation are allowed") }
    return number
}
func validateTarget(_ bundle: String, _ pid: String, _ operation: String) throws -> (pid: pid_t, operation: FixedEditorOperation) {
    let number = try validateTargetIdentity(bundle, pid)
    guard let fixedOperation = FixedEditorOperation(rawValue: operation) else {
        try reject("Only an identified temporary app and a fixed editor operation are allowed")
    }
    return (number, fixedOperation)
}
func targetPreflight(_ bundle: String, _ pid: pid_t) -> [String: Bool] {
    let target = NSRunningApplication(processIdentifier: pid)
    let recordFound = target != nil
    let recordTerminated = target?.isTerminated == true
    errno = 0
    let processStatus = kill(pid, 0)
    let processPresent = processStatus == 0 || errno == EPERM
    let bundleMatches = target?.bundleIdentifier == bundle
    let frontmostMatches = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    return ["applicationRecordFound": recordFound, "recordTerminated": recordTerminated,
            "processPresent": processPresent, "bundleMatches": bundleMatches,
            "frontmostMatches": frontmostMatches,
            "guardPassed": recordFound && !recordTerminated && bundleMatches && frontmostMatches]
}
let targetPreflightScope = "AppKit application-record lookup and POSIX PID existence are separate observations"

extension FixedEditorOperation {
    var bindingPhase: String { rawValue.components(separatedBy: "-").last! }
    var bindingCase: String { rawValue.hasPrefix("plain-") ? "local-plain-text" : "local-json-editor" }
    var bindingOrdinal: Int {
        switch self { case .plainAlpha, .jsonValid: return 1; case .plainBeta, .jsonFormat: return 2
        case .jsonMalformed: return 3; case .jsonRecovery: return 4 }
    }
}
func isNonce(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil }
struct EditorBinding: Equatable {
    let pid: Int32, caseId: String, phase: String, actionOrdinal: Int, documentNonce: String, armNonce: String
    var json: [String: Any] { ["pid": pid, "caseId": caseId, "phase": phase, "actionOrdinal": actionOrdinal,
                              "documentNonce": documentNonce, "armNonce": armNonce] }
    static func parse(_ raw: Any) throws -> EditorBinding {
        guard let value = raw as? [String: Any], Set(value.keys) == Set(["pid", "caseId", "phase", "actionOrdinal", "documentNonce", "armNonce"]),
              let pid = value["pid"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID(), pid.int32Value > 1,
              pid.doubleValue == Double(pid.int32Value),
              let ordinal = value["actionOrdinal"] as? NSNumber, CFGetTypeID(ordinal) != CFBooleanGetTypeID(),
              ordinal.doubleValue == Double(ordinal.intValue),
              let caseId = value["caseId"] as? String, let phase = value["phase"] as? String,
              let document = value["documentNonce"] as? String, isNonce(document),
              let arm = value["armNonce"] as? String, isNonce(arm),
              FixedEditorOperation.allCases.contains(where: { $0.bindingCase == caseId && $0.bindingPhase == phase && $0.bindingOrdinal == ordinal.intValue })
        else { try reject("Invalid fixed editor binding") }
        return EditorBinding(pid: pid.int32Value, caseId: caseId, phase: phase, actionOrdinal: ordinal.intValue,
                             documentNonce: document, armNonce: arm)
    }
    static func ready(_ data: Data, pid: Int32, operation: FixedEditorOperation) throws -> EditorBinding {
        guard data.count <= 4096 else { try reject("Editor exchange exceeded budget") }
        let value = try parse(JSONSerialization.jsonObject(with: data))
        guard value.pid == pid, value.caseId == operation.bindingCase, value.phase == operation.bindingPhase,
              value.actionOrdinal == operation.bindingOrdinal else { try reject("Foreign or stale editor ready binding") }
        return value
    }
}
func validateEditorAck(_ data: Data, binding: EditorBinding, requestNonce: String) throws {
    guard data.count <= 4096, isNonce(requestNonce),
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(value.keys) == Set(["binding", "requestNonce", "passed"]),
          let returnedNonce = value["requestNonce"] as? String, returnedNonce == requestNonce,
          let passed = value["passed"] as? NSNumber, CFGetTypeID(passed) == CFBooleanGetTypeID(), passed.boolValue,
          try EditorBinding.parse(value["binding"] as Any) == binding
    else { try reject("Missing, rejected, foreign or stale editor acknowledgement") }
}
final class PrivateEditorExchange {
    let descriptor: Int32, root: String, device: dev_t, inode: ino_t
    init(_ path: String) throws {
        var info = stat()
        let resolved = realpath(path, nil)
        let canonicalPath = resolved.map { String(cString: $0) }
        if let resolved { free(resolved) }
        guard path.hasPrefix("/private/tmp/"), canonicalPath == path, lstat(path, &info) == 0,
              info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o777 == 0o700, info.st_uid == geteuid()
        else { try reject("Owned canonical private editor exchange directory required") }
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { try reject("Private editor exchange open failed") }
        var opened = stat()
        guard fstat(fd, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else {
            close(fd); try reject("Private editor exchange changed")
        }
        descriptor = fd; root = path; device = opened.st_dev; inode = opened.st_ino
    }
    deinit { close(descriptor) }
    func verifyRoot() throws {
        var value = stat()
        guard lstat(root, &value) == 0, value.st_dev == device, value.st_ino == inode,
              value.st_mode & S_IFMT == S_IFDIR, value.st_mode & 0o777 == 0o700, value.st_uid == geteuid()
        else { try reject("Private editor exchange changed") }
    }
    func read(_ name: String, optional: Bool = false) throws -> Data? {
        try verifyRoot()
        let fd = openat(descriptor, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && optional && errno == ENOENT { return nil }
        guard fd >= 0 else { try reject("Editor exchange file unavailable") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(),
              info.st_nlink == 1, info.st_size <= 4096 else { try reject("Invalid bounded editor exchange file") }
        var bytes = [UInt8](repeating: 0, count: 4097), total = 0
        while total < bytes.count {
            let remaining = bytes.count - total
            let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: total), remaining) }
            if count < 0 { if errno == EINTR { continue }; try reject("Editor exchange read failed") }
            if count == 0 { break }
            total += count
        }
        guard total <= 4096 else { try reject("Editor exchange exceeded budget") }
        return Data(bytes.prefix(total))
    }
    func request(binding: EditorBinding, nonce: String) throws {
        try verifyRoot()
        guard isNonce(nonce) else { try reject("Invalid handshake nonce") }
        var value = binding.json; value["requestNonce"] = nonce
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard bytes.count <= 4096 else { try reject("Editor exchange exceeded budget") }
        let pending = "request." + nonce + ".pending"
        let fd = openat(descriptor, pending, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { try reject("Private editor request creation failed") }
        defer { close(fd); unlinkat(descriptor, pending, 0) }
        var written = 0
        while written < bytes.count {
            let count = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: written), bytes.count - written) }
            if count < 0 { if errno == EINTR { continue }; try reject("Private editor request write failed") }
            guard count > 0 else { try reject("Private editor request write failed") }
            written += count
        }
        guard renameat(descriptor, pending, descriptor, "request.json") == 0 else { try reject("Private editor request publish failed") }
    }
    func awaitAck(binding: EditorBinding, nonce: String, deadline: TimeInterval) throws {
        while ProcessInfo.processInfo.systemUptime < deadline {
            if let bytes = try read("ack.json", optional: true) {
                // A previous phase's acknowledgement is never accepted; wait for native atomic replacement.
                if (try? validateEditorAck(bytes, binding: binding, requestNonce: nonce)) != nil { return }
                if let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                   value["requestNonce"] as? String == nonce { try validateEditorAck(bytes, binding: binding, requestNonce: nonce) }
            }
            usleep(20_000)
        }
        try reject("Post-click editor handshake deadline")
    }
}
enum ControllerStage: String, CaseIterable {
    case targetPreflight = "target-preflight", exchangeReady = "exchange-ready", abcSelectStart = "abc-select-start"
    case abcSelectCompleted = "abc-select-completed", abcVerified = "abc-verified", clickStart = "click-start"
    case clickCompleted = "click-completed", handshakeRequest = "post-click-handshake-request", handshakeAck = "post-click-handshake-ack"
    case selectAllStart = "select-all-start", selectAllCompleted = "select-all-completed", typingStart = "fixed-typing-start"
    case typingCompleted = "fixed-typing-completed", actionExit = "action-exit", restoreStart = "restore-start", restoreCompleted = "restore-completed"
}
final class ControllerTimeline {
    let started = ProcessInfo.processInfo.systemUptime
    var entries: [[String: Any]] = [], overflow = false
    func record(_ stage: ControllerStage) {
        guard entries.count < 32 else { overflow = true; return }
        entries.append(["stage": stage.rawValue, "elapsedMs": (ProcessInfo.processInfo.systemUptime - started) * 1000])
    }
    func acceptScriptStages(_ data: Data, dispatch: String) throws {
        let allowed: [ControllerStage] = dispatch == "click" ? [.clickStart, .clickCompleted]
            : [.selectAllStart, .selectAllCompleted, .typingStart, .typingCompleted]
        var values: [ControllerStage] = []
        for line in String(decoding: data.prefix(8192), as: UTF8.self).split(separator: "\n") {
            let value = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.hasPrefix("stage:") { continue }
            guard let stage = ControllerStage(rawValue: String(value.dropFirst(6))), allowed.contains(stage) else {
                try reject("Fixed script stage protocol rejected")
            }
            values.append(stage)
        }
        for value in values { record(value) }
        guard data.count <= 8192, values == allowed else { try reject("Fixed script stage protocol rejected") }
    }
}
func verifyReviewedScript(_ scriptURL: URL, digest: String) throws {
    let allowed = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("native-editor-fixed-input.applescript")
    guard scriptURL.standardizedFileURL == allowed.standardizedFileURL,
          !((try scriptURL.resourceValues(forKeys: [.isSymbolicLinkKey])).isSymbolicLink ?? true),
          SHA256.hash(data: try Data(contentsOf: scriptURL)).map({ String(format: "%02x", $0) }).joined() == digest
    else { try reject("Only the adjacent unchanged reviewed fixed-input controller is allowed") }
}
func dispatchFixedStage(args: [String], stage: String, timeline: ControllerTimeline, actionDeadline: TimeInterval) throws -> Int32 {
    try verifyReviewedScript(URL(fileURLWithPath: args[6]), digest: args[7])
    guard actionDeadline > ProcessInfo.processInfo.systemUptime else { try reject("Fixed action total deadline") }
    let process = Process(), stdout = Pipe(), stderr = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [args[6], args[1], args[2], args[3], args[4], args[5], stage]
    process.standardOutput = stdout; process.standardError = stderr
    try process.run()
    let deadline = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
    let remaining = min(6, actionDeadline - ProcessInfo.processInfo.systemUptime)
    DispatchQueue.global().asyncAfter(deadline: .now() + max(0, remaining), execute: deadline)
    process.waitUntilExit(); deadline.cancel()
    let stages = stderr.fileHandleForReading.readDataToEndOfFile()
    _ = stdout.fileHandleForReading.readDataToEndOfFile()
    // Parse only fixed stage lines; arbitrary AppleScript output never enters the report.
    if process.terminationStatus == 0 { try timeline.acceptScriptStages(stages, dispatch: stage) }
    else { try? timeline.acceptScriptStages(stages, dispatch: stage) }
    guard process.terminationStatus == 0 else { try reject("Fixed AppleScript action failed") }
    return process.terminationStatus
}

func main() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["inspect"] {
        let identity = try sourceID(currentSource())
        try output(["currentInputSourceID": identity,
                    "abcEnabled": try sources().contains { try sourceID($0) == "com.apple.keylayout.ABC" },
                    "changedInputSource": false])
        return
    }
    if args.count == 3, args[0] == "target-inspect" {
        let pid = try validateTargetIdentity(args[1], args[2])
        try output(["targetPreflight": targetPreflight(args[1], pid), "targetPreflightScope": targetPreflightScope])
        return
    }
    guard args.count == 8, ["validate", "execute"].contains(args[0]) else {
        try reject("Usage: inspect | target-inspect bundle-id pid | validate/execute bundle-id pid operation x y reviewed-script expected-sha256")
    }
    let target = try validateTarget(args[1], args[2], args[3])
    let pid = target.pid, operation = target.operation
    // Desktop-global macOS coordinates may be negative; current owned-window bounds still gate dispatch.
    guard let x = Int(args[4]), let y = Int(args[5]), (-32768...32768).contains(x), (-32768...32768).contains(y),
          args[6].hasPrefix("/"), args[7].range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        try reject("Absolute pinned script and bounded observed coordinates required")
    }
    let scriptURL = URL(fileURLWithPath: args[6])
    try verifyReviewedScript(scriptURL, digest: args[7])
    if args[0] == "validate" {
        try output(["validated": true, "changedInputSource": false, "targetPID": pid, "operation": args[3],
                    "requiresABC": operation.requiresABC, "didSelectABC": false, "actualRestorationAttempted": false])
        return
    }
    let preflight = targetPreflight(args[1], pid)
    guard preflight["guardPassed"] == true else {
        try output(["targetPreflight": preflight, "targetPreflightScope": targetPreflightScope])
        try reject("Only the live foreground temporary app may receive fixed input")
    }
    let timeline = ControllerTimeline(); timeline.record(.targetPreflight)
    guard let exchangeRoot = ProcessInfo.processInfo.environment["ATOOLS_NATIVE_EDITOR_INPUT_EXCHANGE"] else {
        try reject("Private editor exchange required before fixed input")
    }
    let exchange = try PrivateEditorExchange(exchangeRoot)
    let binding = try EditorBinding.ready(exchange.read("ready.json")!, pid: pid, operation: operation)
    timeline.record(.exchangeReady)
    let actionDeadline = timeline.started + 16
    let original = currentSource(), originalID = try sourceID(original)
    var report: [String: Any] = ["originalInputSourceID": originalID, "targetPID": pid,
                                "targetBundleID": args[1], "operation": args[3], "point": [x, y],
                                "changedInputSource": false, "rawInputRecorded": false,
                                "requiresABC": operation.requiresABC, "didSelectABC": false,
                                "actualRestorationAttempted": false,
                                "targetPreflight": preflight, "targetPreflightScope": targetPreflightScope]
    var actionError: Error?
    var didSelectABC = false
    let priorInterrupt = signal(SIGINT, SIG_IGN)
    let priorTermination = signal(SIGTERM, SIG_IGN)
    defer { signal(SIGINT, priorInterrupt); signal(SIGTERM, priorTermination) }
    do {
        if operation.requiresABC {
            guard let abc = try sources().first(where: { try sourceID($0) == "com.apple.keylayout.ABC" }) else {
                try reject("Enabled ABC source required")
            }
            if originalID != "com.apple.keylayout.ABC" {
                timeline.record(.abcSelectStart)
                guard TISSelectInputSource(abc) == noErr else { try reject("ABC selection failed") }
                didSelectABC = true
                report["changedInputSource"] = true
                report["didSelectABC"] = true
                timeline.record(.abcSelectCompleted)
            }
            guard try sourceID(currentSource()) == "com.apple.keylayout.ABC" else { try reject("ABC selection unverified") }
            timeline.record(.abcVerified)
        }
        guard targetPreflight(args[1], pid)["guardPassed"] == true else { try reject("Target ownership lost before click") }
        report["actionExitCode"] = try dispatchFixedStage(args: args, stage: "click", timeline: timeline, actionDeadline: actionDeadline)
        let requestNonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        timeline.record(.handshakeRequest)
        try exchange.request(binding: binding, nonce: requestNonce)
        try exchange.awaitAck(binding: binding, nonce: requestNonce,
                              deadline: min(actionDeadline, ProcessInfo.processInfo.systemUptime + 3))
        timeline.record(.handshakeAck)
        guard targetPreflight(args[1], pid)["guardPassed"] == true else { try reject("Target ownership lost after handshake") }
        if operation.requiresABC {
            guard try sourceID(currentSource()) == "com.apple.keylayout.ABC" else { try reject("ABC ownership lost before typing") }
            report["actionExitCode"] = try dispatchFixedStage(args: args, stage: "type", timeline: timeline, actionDeadline: actionDeadline)
        }
    } catch { actionError = error }
    timeline.record(.actionExit)
    timeline.record(.restoreStart)
    // Do not overwrite a different source selected by the user while the action was running.
    let afterActionID = try? sourceID(currentSource())
    report["inputSourceAfterActionID"] = afterActionID as Any? ?? NSNull()
    var restorationStatus: OSStatus?
    switch inputSourceRestorationDecision(didSelectABC: didSelectABC, observedSourceID: afterActionID) {
    case .restoreOriginal:
        report["actualRestorationAttempted"] = true
        restorationStatus = TISSelectInputSource(original)
        report["restoreStatus"] = restorationStatus
    case .keepCurrent:
        if afterActionID != nil && afterActionID != originalID { report["interveningInputSourceChange"] = true }
    case .unverified:
        break
    }
    let afterRestoreID = try? sourceID(currentSource())
    let disposition = finalInputSourceDisposition(didSelectABC: didSelectABC, originalSourceID: originalID,
        afterActionSourceID: afterActionID, finalSourceID: afterRestoreID, restorationStatus: restorationStatus)
    report["finalInputSourceID"] = afterRestoreID as Any? ?? NSNull()
    report["inputSourceDisposition"] = disposition.rawValue
    report["inputSourceVerified"] = disposition.verified
    report["restoredOriginalInputSource"] = afterRestoreID == originalID
    timeline.record(.restoreCompleted)
    report["stageTimeline"] = timeline.entries
    report["stageTimelineOverflow"] = timeline.overflow
    report["actionFailed"] = actionError != nil
    report["passed"] = actionError == nil && disposition.verified && !timeline.overflow
    try output(report)
    if let error = actionError { throw error }
    guard disposition.verified else { try reject("Input source restoration or preservation unverified") }
}
do { try main() } catch {
    fputs("Fixed editor controller rejected: \(error)\n", stderr)
    exit(1)
}
