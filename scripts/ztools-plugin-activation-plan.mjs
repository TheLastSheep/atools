import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildZToolsPluginRuntimeSampleReport } from "./ztools-plugin-runtime-sample-report.mjs";

function sanitizeId(value) {
  const sanitized = String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "plugin-smoke-sample";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function readManifest(plugin) {
  const text = await readFile(join(plugin.path, "plugin.json"), "utf8");
  return JSON.parse(text);
}

function featureList(manifest) {
  return Array.isArray(manifest?.features) ? manifest.features.filter((feature) => feature && typeof feature === "object") : [];
}

function commandList(feature) {
  return Array.isArray(feature?.cmds) ? feature.cmds : [];
}

function typedCommandLabel(command) {
  return typeof command?.label === "string" ? command.label : "";
}

function simpleRegexQuery(pattern) {
  const text = stringOrEmpty(pattern);
  const simple = text.match(/^\^([a-zA-Z0-9 _.-]+)\$$/);
  return simple ? simple[1] : "";
}

function overQuery(command) {
  const length = Number(command?.length || 0);
  return length > 0 ? "x".repeat(length) : "";
}

function triggerFromCommand(command) {
  if (typeof command === "string") {
    return {
      trigger_type: "text",
      query: command,
      command_type: "text",
      typed_payload: null,
      manual_reason: "",
    };
  }

  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return {
      trigger_type: "manual",
      query: "",
      command_type: "invalid",
      typed_payload: null,
      manual_reason: "unsupported command declaration",
    };
  }

  const type = stringOrEmpty(command.type) || "typed";
  if (type === "regex") {
    const query = simpleRegexQuery(command.match);
    return {
      trigger_type: query ? "regex" : "manual",
      query,
      command_type: "regex",
      typed_payload: { type, match: command.match || "", label: typedCommandLabel(command) },
      manual_reason: query ? "" : "requires regex input",
    };
  }
  if (type === "over") {
    const query = overQuery(command);
    return {
      trigger_type: query ? "over" : "manual",
      query,
      command_type: "over",
      typed_payload: { type, length: Number(command.length || 0), label: typedCommandLabel(command) },
      manual_reason: query ? "" : "requires minimum-length input",
    };
  }

  return {
    trigger_type: "typed_payload",
    query: "",
    command_type: type,
    typed_payload: { type, label: typedCommandLabel(command) },
    manual_reason: `requires ${type} payload`,
  };
}

function chooseFeatureAndTrigger(manifest, preferredCodes) {
  const features = featureList(manifest);
  const preferred = preferredCodes
    .map((code) => features.find((feature) => feature.code === code))
    .find(Boolean);
  const feature = preferred || features[0] || null;
  if (!feature) {
    return {
      feature: null,
      trigger: {
        trigger_type: "manual",
        query: "",
        command_type: "missing",
        typed_payload: null,
        manual_reason: "missing feature declaration",
      },
    };
  }

  const commands = commandList(feature);
  const textCommand = commands.find((command) => typeof command === "string");
  if (textCommand) return { feature, trigger: triggerFromCommand(textCommand) };

  const regexCommand = commands.find((command) => command && typeof command === "object" && command.type === "regex" && simpleRegexQuery(command.match));
  if (regexCommand) return { feature, trigger: triggerFromCommand(regexCommand) };

  const overCommand = commands.find((command) => command && typeof command === "object" && command.type === "over" && overQuery(command));
  if (overCommand) return { feature, trigger: triggerFromCommand(overCommand) };

  return { feature, trigger: triggerFromCommand(commands[0]) };
}

function renderSmokePlanForPlugin(plugin, feature) {
  const pluginName = stringOrEmpty(plugin.name);
  const featureCode = stringOrEmpty(feature?.code);
  if (pluginName === "ztools-developer-plugin" && featureCode === "ui.router") {
    return {
      safe: false,
      reason: "ztools-developer-plugin/ui.router blocks iframe smoke probe in srcdoc mode",
    };
  }
  return {
    safe: true,
    reason: "",
  };
}

async function activationPlanFromPlugin(plugin, order, options) {
  const manifest = await readManifest(plugin);
  const { feature, trigger } = chooseFeatureAndTrigger(manifest, plugin.feature_codes);
  const expectedInstallId = sanitizeId(plugin.name);

  return {
    order,
    name: plugin.name,
    title: plugin.title,
    runtime_status: plugin.runtime_status,
    score: plugin.score,
    source_path: plugin.path,
    expected_install_id: expectedInstallId,
    install: {
      command: "install_ztools_plugin",
      source_path: plugin.path,
      install_root: options.installRoot,
      overwrite: true,
      expected_plugin_id: expectedInstallId,
    },
    enable: {
      expected_enabled_after_import: true,
      required_before_activation: true,
    },
    activation: {
      feature_code: stringOrEmpty(feature?.code),
      feature_label: stringOrEmpty(feature?.label) || stringOrEmpty(feature?.explain) || stringOrEmpty(feature?.code),
      trigger_type: trigger.trigger_type,
      command_type: trigger.command_type,
      query: trigger.query,
      typed_payload: trigger.typed_payload,
      manual_reason: trigger.manual_reason,
    },
    assertions: {
      plugin_path_exists: true,
      main_exists: true,
      preload_checked: true,
      entry_resources_ok: plugin.entry.missing_local_resources.length === 0 && plugin.entry.external_resources.length === 0,
      runtime_status: plugin.runtime_status,
    },
    render_smoke: renderSmokePlanForPlugin(plugin, feature),
    risks: plugin.warnings,
    cleanup: {
      uninstall_plugin_id: expectedInstallId,
      remove_plugin_data: true,
      remove_installed_files: true,
    },
  };
}

function summarize(runtimeReport, plans) {
  return {
    scanned_plugins: runtimeReport.summary.scanned_plugins,
    launchable_plugins: runtimeReport.summary.launchable_plugins,
    planned_samples: plans.length,
    ready_plans: plans.filter((plan) => plan.runtime_status === "ready").length,
    risk_plans: plans.filter((plan) => plan.runtime_status === "risk").length,
    blocked_skipped: runtimeReport.summary.blocked_plugins,
    text_trigger_plans: plans.filter((plan) => plan.activation.trigger_type === "text").length,
    regex_trigger_plans: plans.filter((plan) => plan.activation.trigger_type === "regex").length,
    typed_payload_plans: plans.filter((plan) => plan.activation.trigger_type === "typed_payload").length,
    manual_trigger_plans: plans.filter((plan) => plan.activation.trigger_type === "manual").length,
    cleanup_required: plans.length > 0,
  };
}

export async function buildZToolsPluginActivationPlan(source, options = {}) {
  const root = resolve(source);
  const maxSamples = Number(options.maxSamples ?? 10);
  const installRoot = options.installRoot || "/tmp/atools-ztools-plugin-smoke";
  const runtimeReport = await buildZToolsPluginRuntimeSampleReport(root, {
    generatedAt: options.generatedAt,
    maxCandidates: maxSamples,
  });
  const plans = [];
  for (const plugin of runtimeReport.sample_candidates) {
    plans.push(await activationPlanFromPlugin(plugin, plans.length + 1, { installRoot }));
  }

  return {
    generated_at: options.generatedAt || new Date().toISOString(),
    source: root,
    install_root: installRoot,
    summary: summarize(runtimeReport, plans),
    activation_plans: plans,
  };
}

export async function writeZToolsPluginActivationPlan(report, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    source: process.env.ZTOOLS_PLUGIN_ACTIVATION_SOURCE || "../ZTools-plugins/plugins",
    output: "",
    json: false,
    maxSamples: 10,
    installRoot: "/tmp/atools-ztools-plugin-smoke",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source") {
      options.source = args[index + 1] || options.source;
      index += 1;
    } else if (arg === "--output") {
      options.output = args[index + 1] || "";
      index += 1;
    } else if (arg === "--limit" || arg === "--max-samples") {
      options.maxSamples = Number(args[index + 1] || options.maxSamples);
      index += 1;
    } else if (arg === "--install-root") {
      options.installRoot = args[index + 1] || options.installRoot;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

function printHumanSummary(report) {
  const summary = report.summary;
  console.log(`ZTools activation plan source: ${report.source}`);
  console.log(`Plans: ${summary.planned_samples} samples from ${summary.launchable_plugins} launchable plugins (${summary.blocked_skipped} blocked skipped)`);
  console.log(`Runtime status: ${summary.ready_plans} ready, ${summary.risk_plans} risk`);
  console.log(`Triggers: ${summary.text_trigger_plans} text, ${summary.regex_trigger_plans} regex, ${summary.typed_payload_plans} typed payload, ${summary.manual_trigger_plans} manual`);
  if (report.activation_plans.length > 0) {
    console.log(`Top plan: ${report.activation_plans[0].name} -> ${report.activation_plans[0].activation.feature_code} (${report.activation_plans[0].activation.trigger_type})`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildZToolsPluginActivationPlan(args.source, {
    maxSamples: args.maxSamples,
    installRoot: args.installRoot,
  });
  if (args.output) {
    await writeZToolsPluginActivationPlan(report, args.output);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanSummary(report);
  }
}
