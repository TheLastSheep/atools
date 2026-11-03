use super::{
    assess_metadata, focusable_field_fits, layout_is_safe, AssessmentMetadata,
    FOUNDATION_KVO_METHODS,
};

fn tao_metadata() -> AssessmentMetadata {
    AssessmentMetadata {
        actual_class: "TaoWindow".to_owned(),
        reported_class: "TaoWindow".to_owned(),
        actual_superclass: "NSWindow".to_owned(),
        actual_is_tao: true,
        reported_is_tao: true,
        actual_superclass_is_tao: false,
        actual_superclass_is_ns_window: true,
        tao_direct_superclass_is_ns_window: true,
        actual_instance_size: 536,
        tao_instance_size: 536,
        own_ivar_count: 1,
        own_method_names: vec![
            "canBecomeKeyWindow".to_owned(),
            "canBecomeMainWindow".to_owned(),
            "sendEvent:".to_owned(),
        ],
    }
}

fn kvo_metadata() -> AssessmentMetadata {
    AssessmentMetadata {
        actual_class: "NSKVONotifying_TaoWindow".to_owned(),
        reported_class: "TaoWindow".to_owned(),
        actual_superclass: "TaoWindow".to_owned(),
        actual_is_tao: false,
        reported_is_tao: true,
        actual_superclass_is_tao: true,
        actual_superclass_is_ns_window: false,
        tao_direct_superclass_is_ns_window: true,
        actual_instance_size: 536,
        tao_instance_size: 536,
        own_ivar_count: 0,
        own_method_names: FOUNDATION_KVO_METHODS
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
    }
}

#[test]
fn accepts_only_the_reviewed_plain_tao_window_shape() {
    let assessment = assess_metadata(tao_metadata()).expect("pinned TaoWindow metadata");
    assert_eq!(assessment.kind, "tao");
    assert_eq!(assessment.actual_class, "TaoWindow");
    assert_eq!(assessment.reported_class, "TaoWindow");
    assert_eq!(assessment.actual_superclass, "NSWindow");
    assert_eq!(assessment.actual_instance_size, 536);
    assert_eq!(assessment.tao_instance_size, 536);
    assert_eq!(assessment.own_ivar_count, 1);
    assert!(assessment.tao_direct_superclass_is_ns_window);
    assert!(assessment
        .own_method_names
        .windows(2)
        .all(|pair| pair[0] <= pair[1]));
}

#[test]
fn accepts_only_the_observed_foundation_content_view_kvo_shape() {
    let assessment = assess_metadata(kvo_metadata()).expect("observed Foundation KVO shape");
    assert_eq!(assessment.kind, "foundation-kvo-content-view");
    assert_eq!(assessment.actual_class, "NSKVONotifying_TaoWindow");
    assert_eq!(assessment.reported_class, "TaoWindow");
    assert_eq!(assessment.actual_superclass, "TaoWindow");
    assert_eq!(assessment.own_ivar_count, 0);
    assert_eq!(
        assessment.own_method_names,
        FOUNDATION_KVO_METHODS
            .iter()
            .map(|name| (*name).to_owned())
            .collect::<Vec<_>>()
    );
    assert!(assessment.tao_direct_superclass_is_ns_window);
}

#[test]
fn rejects_kvo_setter_or_metadata_deviations() {
    let mut extra_setter = kvo_metadata();
    extra_setter.own_method_names.push("setFrame:".to_owned());

    let mut added_ivar = kvo_metadata();
    added_ivar.own_ivar_count = 1;

    let mut larger_instance = kvo_metadata();
    larger_instance.actual_instance_size += 1;

    let mut wrong_logical_class = kvo_metadata();
    wrong_logical_class.reported_class = "NSWindow".to_owned();
    wrong_logical_class.reported_is_tao = false;

    let mut wrong_runtime_class = kvo_metadata();
    wrong_runtime_class.actual_class = "NSKVONotifying_OtherWindow".to_owned();

    let mut wrong_superclass = kvo_metadata();
    wrong_superclass.actual_superclass = "NSWindow".to_owned();
    wrong_superclass.actual_superclass_is_tao = false;

    let mut wrong_tao_parent = kvo_metadata();
    wrong_tao_parent.tao_direct_superclass_is_ns_window = false;

    let mut too_many_methods = kvo_metadata();
    too_many_methods
        .own_method_names
        .extend((0..29).map(|index| format!("method{index}")));

    for candidate in [
        extra_setter,
        added_ivar,
        larger_instance,
        wrong_logical_class,
        wrong_runtime_class,
        wrong_superclass,
        wrong_tao_parent,
        too_many_methods,
    ] {
        assert!(
            assess_metadata(candidate).is_none(),
            "unreviewed KVO metadata must fail closed"
        );
    }
}

#[test]
fn rejects_plain_tao_identity_or_layout_deviations() {
    let mut candidates = Vec::new();

    let mut wrong_actual = tao_metadata();
    wrong_actual.actual_class = "SubclassOfTaoWindow".to_owned();
    candidates.push(wrong_actual);

    let mut wrong_reported = tao_metadata();
    wrong_reported.reported_class = "NSWindow".to_owned();
    wrong_reported.reported_is_tao = false;
    candidates.push(wrong_reported);

    let mut wrong_superclass = tao_metadata();
    wrong_superclass.actual_superclass = "NSObject".to_owned();
    wrong_superclass.actual_superclass_is_ns_window = false;
    candidates.push(wrong_superclass);

    let mut wrong_tao_parent = tao_metadata();
    wrong_tao_parent.tao_direct_superclass_is_ns_window = false;
    candidates.push(wrong_tao_parent);

    let mut larger_instance = tao_metadata();
    larger_instance.actual_instance_size += 1;
    candidates.push(larger_instance);

    for candidate in candidates {
        assert!(
            assess_metadata(candidate).is_none(),
            "plain TaoWindow deviations must fail closed"
        );
    }
}

#[test]
fn assessment_serialization_has_the_frozen_nine_fields() {
    let assessment = assess_metadata(kvo_metadata()).expect("observed KVO metadata");
    let value = serde_json::to_value(assessment).expect("assessment is serializable");
    let mut keys: Vec<_> = value
        .as_object()
        .expect("assessment serializes as an object")
        .keys()
        .cloned()
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "actualClass",
            "actualInstanceSize",
            "actualSuperclass",
            "kind",
            "ownIvarCount",
            "ownMethodNames",
            "reportedClass",
            "taoDirectSuperclassIsNsWindow",
            "taoInstanceSize",
        ]
        .iter()
        .map(|key| (*key).to_owned())
        .collect::<Vec<_>>()
    );
}

#[test]
fn focusable_metadata_keeps_type_and_offset_bounds_strict() {
    assert_eq!(
        focusable_field_fits(true, Some(528), 536, 528, 528, 528, 1),
        Some(528)
    );
    assert!(focusable_field_fits(false, Some(528), 536, 528, 528, 528, 1).is_none());
    assert!(focusable_field_fits(true, None, 536, 528, 528, 528, 1).is_none());
    assert!(focusable_field_fits(true, Some(usize::MAX), 536, 528, 528, 528, 1).is_none());
    assert!(focusable_field_fits(true, Some(527), 536, 528, 528, 528, 1).is_none());
    assert!(focusable_field_fits(true, Some(536), 536, 528, 528, 528, 1).is_none());
}

#[test]
fn panel_layout_still_rejects_overlapping_and_unmeasured_regions() {
    let safe = [true; 6];
    assert!(layout_is_safe(
        safe[0], safe[1], safe[2], safe[3], safe[4], safe[5], 536, 528, 528, 528, 1
    ));
    assert!(!layout_is_safe(
        safe[0], safe[1], safe[2], safe[3], safe[4], false, 536, 528, 528, 528, 1
    ));
    assert!(!layout_is_safe(
        safe[0], safe[1], safe[2], safe[3], safe[4], safe[5], 536, 529, 528, 528, 1
    ));
}
