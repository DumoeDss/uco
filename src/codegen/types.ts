// Schema types for the GET /api/tools catalog the Unity-MCP server emits.

export interface ToolCatalogEntry {
  name: string;
  enabled: boolean;
  title?: string | null;
  description?: string | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
  readOnlyHint?: boolean | null;
  destructiveHint?: boolean | null;
  idempotentHint?: boolean | null;
  openWorldHint?: boolean | null;
  executionAffinity?: 'main-thread' | 'background' | 'either';
  threadSafeRead?: boolean;
  [member: string]: unknown;
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

/** Categorical kind we map each input property to for flag generation. */
export type FlagKind =
  | 'string'
  | 'enum-string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'vec3'
  | 'gameobject-ref'
  | 'object'
  | 'array';

export interface ResolvedProperty {
  name: string;
  required: boolean;
  description: string;
  kind: FlagKind;
  enumValues?: string[];
  minimum?: number;
  maximum?: number;
}
