/**
 * The slice of the DSH plugin API this plugin uses, declared locally.
 *
 * The harness packages are peer dependencies provided by the host at runtime,
 * so declaring the surface here keeps this repository buildable without a DSH
 * installation checked out beside it. Every shape below was read from the
 * shipped `.d.ts` files of an installed harness rather than guessed:
 *
 * - `ToolRuntime.register` — `@deepseek-ai/dsh-tools`, returns a
 *   fiber-scoped disposer, implemented as `layers.effect(...)`.
 * - `ToolDefinition.output` is **mandatory**: registration throws
 *   `tool "<name>" must declare output { schema, render, presentationMeta? }`
 *   when it is missing.
 * - The parameter schema is `@deepseek-ai/dsh-tools`' own JSON-value DSL, *not*
 *   schemastery. Requiredness is a per-property `required: true`.
 * - Reading `ctx.<service>` without declaring it in `inject` throws
 *   `cannot get property "<prop>" without inject`.
 *
 * @module
 */

/** A model-facing content block. */
export interface ContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/** One property in a tool's parameter object. */
export interface ParameterSpec {
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly description?: string;
  /** Requiredness is declared per property, not in a sibling array. */
  readonly required?: boolean;
}

/** A JSON-value schema, as the tool registry expects it. */
export interface ValueSchema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
}

/** Context handed to a tool's `execute`. */
export interface ToolRunContext {
  readonly signal: AbortSignal;
  readonly callId?: string;
}

/** The mandatory output declaration. `execute` returns the canonical value; `render` formats it. */
export interface OutputSpec<Args> {
  readonly schema: ValueSchema;
  readonly render: (args: Args, value: unknown) => readonly ContentBlock[];
}

/** The call-presentation hint shown in the transcript. */
export interface CallPresentation {
  readonly card: string;
  readonly title: string;
  readonly kind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other';
}

/** One tool definition. */
export interface ToolDefinition<Args> {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Readonly<Record<string, ParameterSpec>>;
  /** Mandatory: registration throws when the output declaration is absent. */
  readonly output: OutputSpec<Args>;
  readonly execute: (args: Args, context: ToolRunContext) => Promise<unknown>;
  readonly presentCall?: (args: Args) => CallPresentation;
}

/** The tool service, reached through `ctx.tools`. */
export interface ToolRuntime {
  register<Args>(definition: ToolDefinition<Args>): () => void;
}

/** The cordis context, restricted to what this plugin touches. */
export interface Context {
  readonly tools: ToolRuntime;
}

/** Identity helper mirroring `defineTool`, which only adds type inference. */
export function defineTool<Args>(definition: ToolDefinition<Args>): ToolDefinition<Args> {
  return definition;
}
