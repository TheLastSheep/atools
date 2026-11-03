export type InstalledPlugin = {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  source_kind?: "builtin" | "imported" | "external";
  inventory_logo_path?: string | null;
  manifest: {
    title?: string | null;
    description?: string | null;
    features?: Array<{
      code: string;
      label?: string | null;
      explain?: string;
    }>;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
};

export type PluginProviderDescriptor = {
  id: string;
  pluginId: string;
  key: string;
  type: "translation" | "ocr";
  label: string;
  description?: string | null;
  source: "plugin";
  pluginName: string;
  pluginPath: string;
  pluginLogo?: string | null;
  enabled: boolean;
  isDefault: boolean;
};

export type ZToolsImportCandidate = {
  path: string;
  installation_id?: string | null;
  installation_key?: string | null;
  source_type: "directory" | "zpx" | "asar" | "zip";
  package_path?: string | null;
  entry_readiness?: string | null;
  headless?: boolean;
  name: string;
  title: string | null;
  version: string;
  features_count: number;
  platform_supported: boolean;
  main_exists: boolean;
  preload_exists: boolean;
  logo_exists: boolean;
  unsupported_cmd_types: string[];
  warnings: string[];
  errors: string[];
};

export type ZToolsImportFailure = {
  path: string;
  error: string;
};

export type ZToolsImportReport = {
  imported: string[];
  skipped: ZToolsImportCandidate[];
  failed: ZToolsImportFailure[];
};

