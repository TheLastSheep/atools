use std::{ffi::CStr, ptr};

use objc2::{
    encode::Encode,
    runtime::{AnyClass, Bool},
    sel, ClassType,
};
use objc2_app_kit::{NSPanel, NSWindow};
use serde::Serialize;

use super::RawAToolsMainPanel;

const TAO_WINDOW_CLASS: &str = "TaoWindow";
const FOUNDATION_KVO_CLASS: &str = "NSKVONotifying_TaoWindow";
const PANEL_CLASS: &str = "AToolsMainPanel";
const MAX_ASSESSED_METHODS: usize = 32;
const FOUNDATION_KVO_METHODS: [&str; 4] = ["_isKVOA", "class", "dealloc", "setContentView:"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginalClassAssessment {
    pub(crate) kind: &'static str,
    pub(crate) actual_class: String,
    pub(crate) reported_class: String,
    pub(crate) actual_superclass: String,
    pub(crate) actual_instance_size: usize,
    pub(crate) tao_instance_size: usize,
    pub(crate) own_ivar_count: usize,
    pub(crate) own_method_names: Vec<String>,
    pub(crate) tao_direct_superclass_is_ns_window: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LayoutFacts {
    pub(super) is_safe: bool,
    pub(super) original_instance_size: usize,
    pub(super) panel_instance_size: usize,
    pub(super) ns_panel_own_ivar_count: usize,
    pub(super) focusable_offset: usize,
    pub(super) original_class_assessment: Option<OriginalClassAssessment>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AssessmentMetadata {
    actual_class: String,
    reported_class: String,
    actual_superclass: String,
    actual_is_tao: bool,
    reported_is_tao: bool,
    actual_superclass_is_tao: bool,
    actual_superclass_is_ns_window: bool,
    tao_direct_superclass_is_ns_window: bool,
    actual_instance_size: usize,
    tao_instance_size: usize,
    own_ivar_count: usize,
    own_method_names: Vec<String>,
}

pub(super) fn cstr(value: &'static [u8]) -> &'static CStr {
    CStr::from_bytes_with_nul(value).expect("fixed Objective-C name must be NUL-terminated")
}

fn class_name(class: &AnyClass) -> String {
    class.name().to_string_lossy().into_owned()
}

pub(super) fn reported_class(window: &NSWindow) -> &'static AnyClass {
    // SAFETY: NSObject's `-class` returns an immortal Objective-C Class object.
    unsafe { objc2::msg_send![window, class] }
}

pub(super) fn is_expected_panel_class(class: &AnyClass) -> bool {
    class.name().to_bytes() == PANEL_CLASS.as_bytes()
}

pub(super) fn required_instance_getters_owned(class: &AnyClass) -> [bool; 2] {
    let methods = class.instance_methods();
    [sel!(canBecomeKeyWindow), sel!(canBecomeMainWindow)].map(|selector| {
        methods
            .iter()
            .any(|method| method.name().name() == selector.name())
    })
}

fn assessment_metadata(
    actual: &'static AnyClass,
    reported: &'static AnyClass,
) -> Option<AssessmentMetadata> {
    let tao = AnyClass::get(cstr(b"TaoWindow\0"))?;
    let ns_window = NSWindow::class();
    let actual_superclass = actual.superclass()?;
    let tao_superclass = tao.superclass();
    let own_method_names = actual
        .instance_methods()
        .iter()
        .map(|method| method.name().name().to_string_lossy().into_owned())
        .collect();
    Some(AssessmentMetadata {
        actual_class: class_name(actual),
        reported_class: class_name(reported),
        actual_superclass: class_name(actual_superclass),
        actual_is_tao: ptr::eq(actual, tao),
        reported_is_tao: ptr::eq(reported, tao),
        actual_superclass_is_tao: ptr::eq(actual_superclass, tao),
        actual_superclass_is_ns_window: ptr::eq(actual_superclass, ns_window),
        tao_direct_superclass_is_ns_window: tao_superclass
            .is_some_and(|superclass| ptr::eq(superclass, ns_window)),
        actual_instance_size: actual.instance_size(),
        tao_instance_size: tao.instance_size(),
        own_ivar_count: actual.instance_variables().len(),
        own_method_names,
    })
}

fn assess_metadata(mut metadata: AssessmentMetadata) -> Option<OriginalClassAssessment> {
    metadata.own_method_names.sort_unstable();
    if metadata.own_method_names.len() > MAX_ASSESSED_METHODS
        || metadata.actual_instance_size != metadata.tao_instance_size
        || !metadata.tao_direct_superclass_is_ns_window
    {
        return None;
    }

    let actual_methods: Vec<&str> = metadata
        .own_method_names
        .iter()
        .map(String::as_str)
        .collect();
    let kind = if metadata.actual_class == TAO_WINDOW_CLASS
        && metadata.reported_class == TAO_WINDOW_CLASS
        && metadata.actual_is_tao
        && metadata.reported_is_tao
        && metadata.actual_superclass == "NSWindow"
        && metadata.actual_superclass_is_ns_window
    {
        "tao"
    // Support only the exact Foundation content-view KVO wrapper observed for TaoWindow.
    } else if metadata.actual_class == FOUNDATION_KVO_CLASS
        && !metadata.actual_is_tao
        && metadata.reported_class == TAO_WINDOW_CLASS
        && metadata.reported_is_tao
        && metadata.actual_superclass == TAO_WINDOW_CLASS
        && metadata.actual_superclass_is_tao
        && metadata.own_ivar_count == 0
        && actual_methods.as_slice() == FOUNDATION_KVO_METHODS.as_slice()
    {
        "foundation-kvo-content-view"
    } else {
        return None;
    };

    Some(OriginalClassAssessment {
        kind,
        actual_class: metadata.actual_class,
        reported_class: metadata.reported_class,
        actual_superclass: metadata.actual_superclass,
        actual_instance_size: metadata.actual_instance_size,
        tao_instance_size: metadata.tao_instance_size,
        own_ivar_count: metadata.own_ivar_count,
        own_method_names: metadata.own_method_names,
        tao_direct_superclass_is_ns_window: metadata.tao_direct_superclass_is_ns_window,
    })
}

pub(super) fn focusable_field_fits(
    bool_encoding: bool,
    offset: Option<usize>,
    original_size: usize,
    ns_window_size: usize,
    panel_size: usize,
    ns_panel_size: usize,
    field_width: usize,
) -> Option<usize> {
    if !bool_encoding || original_size < ns_window_size {
        return None;
    }
    let offset = offset?;
    let field_end = offset.checked_add(field_width)?;
    (offset >= ns_panel_size && panel_size <= offset && field_end <= original_size)
        .then_some(offset)
}

pub(super) fn layout_facts(
    actual: &'static AnyClass,
    reported: &'static AnyClass,
    panel: &'static AnyClass,
) -> Option<LayoutFacts> {
    let ns_window = NSWindow::class();
    let ns_panel = NSPanel::class();
    let focusable = actual.instance_variable(cstr(b"focusable\0"))?;
    let expected_encoding = <Bool as Encode>::ENCODING;
    let bool_encoding =
        expected_encoding.equivalent_to_str(focusable.type_encoding().to_str().ok()?);
    let original_size = actual.instance_size();
    let panel_size = panel.instance_size();
    let ns_panel_size = ns_panel.instance_size();
    let focusable_offset = focusable_field_fits(
        bool_encoding,
        usize::try_from(focusable.offset()).ok(),
        original_size,
        ns_window.instance_size(),
        panel_size,
        ns_panel_size,
        std::mem::size_of::<Bool>(),
    )?;
    let ns_panel_own_ivar_count = ns_panel.instance_variables().len();
    let original_class_assessment = assess_metadata(assessment_metadata(actual, reported)?);
    let panel_direct_superclass = panel
        .superclass()
        .is_some_and(|superclass| ptr::eq(superclass, ns_panel));
    let [can_become_key, can_become_main] = required_instance_getters_owned(panel);
    let is_safe = layout_is_safe(
        original_class_assessment.is_some(),
        is_expected_panel_class(panel),
        panel_direct_superclass,
        can_become_key && can_become_main,
        panel.instance_variables().is_empty(),
        ns_panel_own_ivar_count == 0,
        original_size,
        panel_size,
        ns_panel_size,
        focusable_offset,
        std::mem::size_of::<Bool>(),
    );
    Some(LayoutFacts {
        is_safe,
        original_instance_size: original_size,
        panel_instance_size: panel_size,
        ns_panel_own_ivar_count,
        focusable_offset,
        original_class_assessment,
    })
}

pub(super) fn layout_is_safe(
    allowed_original_class: bool,
    exact_panel_class: bool,
    panel_direct_superclass: bool,
    panel_owns_required_getters: bool,
    panel_owns_no_ivars: bool,
    ns_panel_owns_no_ivars: bool,
    original_size: usize,
    panel_size: usize,
    ns_panel_size: usize,
    focusable_offset: usize,
    focusable_width: usize,
) -> bool {
    let Some(focusable_end) = focusable_offset.checked_add(focusable_width) else {
        return false;
    };
    allowed_original_class
        && exact_panel_class
        && panel_direct_superclass
        && panel_owns_required_getters
        && panel_owns_no_ivars
        && ns_panel_owns_no_ivars
        && panel_size <= original_size
        && focusable_offset >= ns_panel_size
        && panel_size <= focusable_offset
        && focusable_end <= original_size
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
