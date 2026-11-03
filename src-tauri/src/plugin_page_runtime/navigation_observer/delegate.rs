use super::{snapshot, Observer};
use block2::DynBlock;
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, DefinedClass, MainThreadOnly,
    Message,
};
use objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol};
use objc2_web_kit::{
    WKDownload, WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate,
    WKNavigationResponse, WKNavigationResponsePolicy, WKWebView,
};

pub(super) struct DelegateIvars {
    pub(super) original: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
    observer: Observer,
}

// The original Wry 0.55.1 delegate implements precisely these seven selectors.
// In particular, do not add the preferences policy overload: WebKit would stop
// invoking the original action policy selector.
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    pub(super) struct NavigationObserverDelegate;

    unsafe impl NSObjectProtocol for NavigationObserverDelegate {}

    unsafe impl WKNavigationDelegate for NavigationObserverDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn action_policy(
            &self,
            view: &WKWebView,
            action: &WKNavigationAction,
            handler: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            // The observer may synchronously close its window. Keep this
            // invocation's objects alive until the original policy returns.
            let delegate = self.retain();
            let view = view.retain();
            let action = action.retain();
            let observation = snapshot::navigation(&action);
            // A Rust observer must not unwind through Objective-C or suppress
            // Wry's decision handler. It cannot change the native policy.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                (delegate.ivars().observer)(observation);
            }));
            unsafe {
                delegate
                    .ivars()
                    .original
                    .webView_decidePolicyForNavigationAction_decisionHandler(
                        &view, &action, handler,
                    )
            }
        }

        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn response_policy(
            &self,
            view: &WKWebView,
            response: &WKNavigationResponse,
            handler: &DynBlock<dyn Fn(WKNavigationResponsePolicy)>,
        ) {
            unsafe {
                self.ivars()
                    .original
                    .webView_decidePolicyForNavigationResponse_decisionHandler(
                        view, response, handler,
                    )
            }
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, view: &WKWebView, navigation: Option<&WKNavigation>) {
            unsafe {
                self.ivars()
                    .original
                    .webView_didFinishNavigation(view, navigation)
            }
        }

        #[unsafe(method(webView:didCommitNavigation:))]
        fn did_commit(&self, view: &WKWebView, navigation: Option<&WKNavigation>) {
            unsafe {
                self.ivars()
                    .original
                    .webView_didCommitNavigation(view, navigation)
            }
        }

        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_download(
            &self,
            view: &WKWebView,
            action: &WKNavigationAction,
            download: &WKDownload,
        ) {
            unsafe {
                self.ivars()
                    .original
                    .webView_navigationAction_didBecomeDownload(view, action, download)
            }
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_download(
            &self,
            view: &WKWebView,
            response: &WKNavigationResponse,
            download: &WKDownload,
        ) {
            unsafe {
                self.ivars()
                    .original
                    .webView_navigationResponse_didBecomeDownload(view, response, download)
            }
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn process_terminated(&self, view: &WKWebView) {
            unsafe {
                self.ivars()
                    .original
                    .webViewWebContentProcessDidTerminate(view)
            }
        }
    }
);

impl NavigationObserverDelegate {
    pub(super) fn new(
        original: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
        observer: Observer,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let delegate = mtm
            .alloc::<Self>()
            .set_ivars(DelegateIvars { original, observer });
        // SAFETY: NSObject initialization follows allocation on the main thread.
        unsafe { msg_send![super(delegate), init] }
    }

    pub(super) fn original(&self) -> &ProtocolObject<dyn WKNavigationDelegate> {
        &self.ivars().original
    }
}
