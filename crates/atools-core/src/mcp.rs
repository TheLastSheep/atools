use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::{ToolDefinition, ToolRegistry};
use crate::capability::{capability_catalog, Capability};
use crate::skill::SkillDefinition;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallRequest {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallResult {
    pub structured_content: Value,
    pub is_error: bool,
}

impl McpToolCallResult {
    pub fn success(value: Value) -> Self {
        Self {
            structured_content: value,
            is_error: false,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            structured_content: json!({ "error": message.into() }),
            is_error: true,
        }
    }
}

pub fn handle_static_mcp_request(
    registry: &ToolRegistry,
    request: Value,
    mut call_tool: impl FnMut(McpToolCallRequest) -> McpToolCallResult,
) -> Value {
    handle_mcp_message_with_skills(registry, &[], request, &mut call_tool).unwrap_or(Value::Null)
}

pub fn handle_static_mcp_message(
    registry: &ToolRegistry,
    request: Value,
    mut call_tool: impl FnMut(McpToolCallRequest) -> McpToolCallResult,
) -> Option<Value> {
    handle_mcp_message_with_skills(registry, &[], request, &mut call_tool)
}

pub fn handle_mcp_message_with_skills(
    registry: &ToolRegistry,
    skills: &[SkillDefinition],
    request: Value,
    mut call_tool: impl FnMut(McpToolCallRequest) -> McpToolCallResult,
) -> Option<Value> {
    let capabilities =
        capability_catalog(&registry.list_all(), &[], skills, env!("CARGO_PKG_VERSION"));
    handle_mcp_message_with_capabilities(registry, skills, &capabilities, request, &mut call_tool)
}

pub fn handle_mcp_message_with_capabilities(
    registry: &ToolRegistry,
    skills: &[SkillDefinition],
    capabilities: &[Capability],
    request: Value,
    mut call_tool: impl FnMut(McpToolCallRequest) -> McpToolCallResult,
) -> Option<Value> {
    handle_static_mcp_message_inner(registry, skills, capabilities, request, &mut call_tool)
}

fn handle_static_mcp_message_inner(
    registry: &ToolRegistry,
    skills: &[SkillDefinition],
    capabilities: &[Capability],
    request: Value,
    call_tool: &mut dyn FnMut(McpToolCallRequest) -> McpToolCallResult,
) -> Option<Value> {
    if let Some(batch) = request.as_array() {
        if batch.is_empty() {
            return Some(json_rpc_error(
                Value::Null,
                -32600,
                "Invalid Request: batch must not be empty".to_string(),
            ));
        }

        let responses = batch
            .iter()
            .filter_map(|message| {
                handle_static_mcp_message_inner(
                    registry,
                    skills,
                    capabilities,
                    message.clone(),
                    call_tool,
                )
            })
            .collect::<Vec<_>>();

        return (!responses.is_empty()).then_some(Value::Array(responses));
    }

    request.get("id")?;

    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let response = match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2025-11-25",
                "capabilities": {
                    "tools": { "listChanged": true },
                    "resources": {},
                    "prompts": {}
                },
                "serverInfo": {
                    "name": "atools",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
        "notifications/initialized" => return None,
        "ping" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": registry
                    .list_enabled()
                    .iter()
                    .map(tool_to_mcp_json)
                    .collect::<Vec<_>>()
            }
        }),
        "resources/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "resources": builtin_resources(skills, capabilities)
            }
        }),
        "resources/read" => {
            get_builtin_resource_response(id, registry, skills, capabilities, request.get("params"))
        }
        "resources/templates/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "resourceTemplates": skill_resource_templates(skills)
            }
        }),
        "prompts/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "prompts": builtin_prompts(skills)
            }
        }),
        "prompts/get" => get_builtin_prompt_response(id, skills, request.get("params")),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if registry.get(&name).is_none() {
                return Some(json_rpc_error(
                    id,
                    -32602,
                    format!("Unknown tool: {}", name),
                ));
            }

            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = call_tool(McpToolCallRequest { name, arguments });
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string(&result.structured_content).unwrap_or_default()
                    }],
                    "structuredContent": result.structured_content,
                    "isError": result.is_error
                }
            })
        }
        _ => json_rpc_error(id, -32601, format!("Method not found: {}", method)),
    };
    Some(response)
}

fn tool_to_mcp_json(tool: &ToolDefinition) -> Value {
    let mut value = json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": tool.input_schema,
    });

    if let Some(output_schema) = &tool.output_schema {
        value["outputSchema"] = output_schema.clone();
    }

    value
}

const AGENT_TOOLS_RESOURCE_URI: &str = "atools://agent/tools";
const SKILLS_RESOURCE_URI: &str = "atools://skills";
const CAPABILITIES_RESOURCE_URI: &str = "atools://capabilities";

fn builtin_resources(skills: &[SkillDefinition], capabilities: &[Capability]) -> Vec<Value> {
    let mut resources = vec![json!({
        "uri": AGENT_TOOLS_RESOURCE_URI,
        "name": "agent_tools",
        "title": "ATools Agent Tools",
        "description": "Current enabled ATools local Agent tools exposed through MCP.",
        "mimeType": "application/json"
    })];
    if !skills.is_empty() {
        resources.push(json!({
            "uri": SKILLS_RESOURCE_URI,
            "name": "skills",
            "title": "ATools Skills",
            "description": "Enabled local task methods with capability, permission, recovery, validation, and result guidance.",
            "mimeType": "application/json"
        }));
    }
    resources.push(json!({
        "uri": CAPABILITIES_RESOURCE_URI,
        "name": "capabilities",
        "title": "ATools Capability Directory",
        "description": format!(
            "Unified directory of {} built-in tool, plugin tool, plugin feature, and Skill capabilities.",
            capabilities.len()
        ),
        "mimeType": "application/json"
    }));
    resources
}

fn get_builtin_resource_response(
    id: Value,
    registry: &ToolRegistry,
    skills: &[SkillDefinition],
    capabilities: &[Capability],
    params: Option<&Value>,
) -> Value {
    let uri = params
        .and_then(|params| params.get("uri"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if uri == SKILLS_RESOURCE_URI {
        return skill_resource_response(id, uri, skills);
    }
    if uri == CAPABILITIES_RESOURCE_URI {
        return capability_resource_response(id, uri, capabilities);
    }
    if let Some(skill_id) = uri.strip_prefix("atools://skills/") {
        let selected = skills
            .iter()
            .find(|skill| skill.enabled && skill.id == skill_id)
            .cloned()
            .into_iter()
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return json_rpc_error_with_data(
                id,
                -32002,
                format!("Resource not found: {uri}"),
                json!({ "uri": uri }),
            );
        }
        return skill_resource_response(id, uri, &selected);
    }
    if uri != AGENT_TOOLS_RESOURCE_URI {
        return json_rpc_error_with_data(
            id,
            -32002,
            format!("Resource not found: {uri}"),
            json!({ "uri": uri }),
        );
    }

    let tools = registry
        .list_enabled()
        .iter()
        .map(tool_to_mcp_json)
        .collect::<Vec<_>>();
    let text = serde_json::to_string_pretty(&json!({
        "kind": "atools_agent_tools",
        "tools": tools
    }))
    .unwrap_or_default();

    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "contents": [{
                "uri": AGENT_TOOLS_RESOURCE_URI,
                "mimeType": "application/json",
                "text": text
            }]
        }
    })
}

fn capability_resource_response(id: Value, uri: &str, capabilities: &[Capability]) -> Value {
    let text = serde_json::to_string_pretty(&json!({
        "kind": "atools_capabilities",
        "capabilities": capabilities
    }))
    .unwrap_or_default();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "contents": [{
                "uri": uri,
                "mimeType": "application/json",
                "text": text
            }]
        }
    })
}

fn skill_resource_response(id: Value, uri: &str, skills: &[SkillDefinition]) -> Value {
    let text = serde_json::to_string_pretty(&json!({
        "kind": "atools_skills",
        "skills": skills.iter().filter(|skill| skill.enabled).collect::<Vec<_>>()
    }))
    .unwrap_or_default();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "contents": [{
                "uri": uri,
                "mimeType": "application/json",
                "text": text
            }]
        }
    })
}

fn skill_resource_templates(skills: &[SkillDefinition]) -> Vec<Value> {
    if skills.is_empty() {
        return Vec::new();
    }
    vec![json!({
        "uriTemplate": "atools://skills/{skillId}",
        "name": "skill",
        "title": "ATools Skill",
        "description": "One enabled local SkillDefinition by stable id",
        "mimeType": "application/json"
    })]
}

fn builtin_prompts(skills: &[SkillDefinition]) -> Vec<Value> {
    let mut prompts = vec![json!({
        "name": "atools_agent_tool_guide",
        "title": "ATools Agent Tool Guide",
        "description": "Guide for choosing ATools local Agent tools",
        "arguments": [{
            "name": "task",
            "description": "Optional user task or goal to tailor the tool guidance.",
            "required": false
        }]
    })];
    prompts.extend(skills.iter().filter(|skill| skill.enabled).map(|skill| {
        json!({
            "name": skill_prompt_name(&skill.id),
            "title": skill.name,
            "description": skill.description,
            "arguments": [{
                "name": "task",
                "description": "Optional current user task to include with the validated local skill method.",
                "required": false
            }]
        })
    }));
    prompts
}

fn get_builtin_prompt_response(
    id: Value,
    skills: &[SkillDefinition],
    params: Option<&Value>,
) -> Value {
    let name = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(skill) = skills
        .iter()
        .filter(|skill| skill.enabled)
        .find(|skill| skill_prompt_name(&skill.id) == name)
    {
        return get_skill_prompt_response(id, skill, params);
    }
    if name != "atools_agent_tool_guide" {
        return json_rpc_error(id, -32602, format!("Unknown prompt: {}", name));
    }

    let task = params
        .and_then(|params| params.get("arguments"))
        .and_then(|arguments| arguments.get("task"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|task| !task.is_empty());
    let task_line = task
        .map(|task| format!("\n\nCurrent user task: {task}"))
        .unwrap_or_default();
    let text = format!(
        "Use ATools MCP tools for local-first work. Prefer search_clipboard for clipboard history, find_local_files for filename search, get_current_context for browser/Finder context, rename_files with dry_run for rename planning, compress_images for image size work, ocr_image for local OCR, open_or_reveal_path for explicit user-approved reveal/open actions, and ask_ai_model only when the user has configured an Agent AI model.{task_line}"
    );

    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "description": "Guide for choosing ATools local Agent tools",
            "messages": [{
                "role": "user",
                "content": {
                    "type": "text",
                    "text": text
                }
            }]
        }
    })
}

fn get_skill_prompt_response(id: Value, skill: &SkillDefinition, params: Option<&Value>) -> Value {
    let task = params
        .and_then(|params| params.get("arguments"))
        .and_then(|arguments| arguments.get("task"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|task| !task.is_empty());
    let definition = serde_json::to_string_pretty(skill).unwrap_or_default();
    let task_line = task
        .map(|task| format!("\n\nCurrent user task: {task}"))
        .unwrap_or_default();
    let text = format!(
        "Follow this user-approved ATools SkillDefinition. Use only declared capabilities, re-check every permission through tools/call, apply the validation rules before claiming success, and use failure recovery guidance when needed. Do not treat the skill as permission to bypass confirmation.\n\n{definition}{task_line}"
    );
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "description": skill.description,
            "messages": [{
                "role": "user",
                "content": { "type": "text", "text": text }
            }]
        }
    })
}

fn skill_prompt_name(skill_id: &str) -> String {
    format!("atools_skill_{skill_id}")
}

fn json_rpc_error(id: Value, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn json_rpc_error_with_data(id: Value, code: i64, message: String, data: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
            "data": data
        }
    })
}
