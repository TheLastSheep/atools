use std::{collections::BTreeMap, ffi::CStr};

use objc2::{
    runtime::{AnyClass, AnyProtocol, NSObjectProtocol},
    sel,
};
use objc2_app_kit::NSView;

#[derive(Clone, Debug)]
pub(super) struct TextInputMethodSnapshot {
    class_methods: BTreeMap<usize, bool>,
}

fn text_input_client_protocol() -> Option<&'static AnyProtocol> {
    let name = CStr::from_bytes_with_nul(b"NSTextInputClient\0").ok()?;
    AnyProtocol::get(name)
}

fn stable_client_class(runtime_class: &'static AnyClass) -> &'static AnyClass {
    let mut candidate = runtime_class;
    while let Some(superclass) = candidate.superclass() {
        if superclass.name().to_bytes() == b"WKWebView" {
            return candidate;
        }
        candidate = superclass;
    }
    runtime_class
}

fn visit(view: &NSView, protocol: &AnyProtocol, classes: &mut BTreeMap<usize, bool>) {
    if view.conformsToProtocol(protocol) {
        let class = stable_client_class(view.class());
        let identity = class as *const AnyClass as usize;
        classes.insert(identity, class.instance_method(sel!(windowLevel)).is_some());
    }
    for subview in view.subviews().iter() {
        visit(&subview, protocol, classes);
    }
}

pub(super) fn snapshot(root: &NSView) -> Option<TextInputMethodSnapshot> {
    let protocol = text_input_client_protocol()?;
    let mut class_methods = BTreeMap::new();
    visit(root, protocol, &mut class_methods);
    if class_methods.is_empty() {
        return None;
    }
    Some(TextInputMethodSnapshot { class_methods })
}

pub(super) fn added_since(
    before: Option<&TextInputMethodSnapshot>,
    after: Option<&TextInputMethodSnapshot>,
) -> Option<bool> {
    let before = before?;
    let after = after?;
    if before.class_methods.len() != after.class_methods.len()
        || before.class_methods.keys().ne(after.class_methods.keys())
    {
        return None;
    }

    let mut added = false;
    for (class, had_method) in &before.class_methods {
        let has_method = *after.class_methods.get(class)?;
        if *had_method && !has_method {
            return None;
        }
        added |= !had_method && has_method;
    }
    Some(added)
}

#[cfg(test)]
#[path = "runtime_methods_test.rs"]
mod tests;
