use atools_core::skill::{
    SkillDefinition, SkillFailureMode, SkillResultSuggestion, SkillStep, SkillValidationRule,
};
use atools_core::Database;
use serde_json::json;

fn valid_skill() -> SkillDefinition {
    SkillDefinition::new(
        "compress-for-web".to_string(),
        "Compress images for web".to_string(),
        "Create web-ready images and verify the target size.".to_string(),
        "1.0.0".to_string(),
        vec!["compress images for web".to_string()],
        vec![
            "compress_images".to_string(),
            "open_or_reveal_path".to_string(),
        ],
        vec![
            SkillStep {
                id: "compress".to_string(),
                capability_id: "compress_images".to_string(),
                description: "Compress the selected images".to_string(),
                input: json!({ "format": "webp" }),
                optional: false,
            },
            SkillStep {
                id: "reveal".to_string(),
                capability_id: "open_or_reveal_path".to_string(),
                description: "Reveal the output when requested".to_string(),
                input: json!({ "reveal": true }),
                optional: true,
            },
        ],
        vec!["file.read".to_string(), "file.write".to_string()],
        vec![SkillFailureMode {
            code: "target_unmet".to_string(),
            description: "The requested byte target could not be reached".to_string(),
            recovery: vec!["Reduce dimensions or choose a lower quality target".to_string()],
            recovery_capability_id: Some("compress_images".to_string()),
        }],
        vec![SkillValidationRule {
            id: "target-size".to_string(),
            label: "Target size".to_string(),
            description: "Every output must meet max_bytes".to_string(),
            kind: "json_path".to_string(),
            config: json!({ "path": "$.items[*].target_met", "equals": true }),
            required: true,
        }],
        vec![SkillResultSuggestion {
            id: "image-grid".to_string(),
            label: "Preview compressed images".to_string(),
            kind: "artifact_renderer".to_string(),
            config: json!({ "renderer": "image_grid" }),
        }],
        "local".to_string(),
    )
    .expect("valid skill")
}

#[test]
fn skill_round_trips_and_can_be_disabled() {
    let db = Database::in_memory().expect("database");
    let skill = valid_skill();
    db.upsert_skill(&skill).expect("insert skill");

    let restored = db
        .get_skill(&skill.id)
        .expect("read skill")
        .expect("skill exists");
    assert_eq!(restored, skill);
    assert_eq!(db.list_skills(false, 10).expect("list").len(), 1);

    assert!(db
        .set_skill_enabled(&skill.id, false)
        .expect("disable skill"));
    assert!(db.list_skills(false, 10).expect("list enabled").is_empty());
    assert_eq!(db.list_skills(true, 10).expect("list all").len(), 1);
}

#[test]
fn skill_rejects_undeclared_step_capability() {
    let mut skill = valid_skill();
    skill.steps[0].capability_id = "unknown_tool".to_string();
    assert!(skill.validate().is_err());
}

#[test]
fn skill_requires_validation_and_result_guidance() {
    let mut skill = valid_skill();
    skill.validation.clear();
    assert!(skill.validate().is_err());

    let mut skill = valid_skill();
    skill.result_suggestions.clear();
    assert!(skill.validate().is_err());
}
