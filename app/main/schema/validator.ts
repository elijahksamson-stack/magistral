/**
 * A minimal JSON Schema validator covering exactly the keyword subset used by
 * shared/schema/graph.schema.json.
 *
 * Why hand-rolled rather than ajv: ajv is not a declared dependency of this
 * project and adding one is out of scope. The schema uses a small, closed set
 * of keywords, so ~150 lines validates it faithfully — and validating against
 * the real schema file keeps it the single source of truth instead of
 * duplicating every rule as TypeScript guards.
 *
 * Supported: $ref (local "#/..." pointers), anyOf, type, enum, const, properties,
 * required, additionalProperties, items, minLength, minimum, maximum,
 * exclusiveMinimum, pattern.
 * `format` is parsed and ignored, as draft 2020-12 permits by default.
 */

export interface SchemaNode {
  readonly [keyword: string]: unknown;
}

export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: readonly string[] };

const MAX_REPORTED_ERRORS = 8;

type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

function matchesType(value: unknown, expected: JsonType): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'object') return actual === 'object' && typeof value === 'object';
  return actual === expected;
}

/** Resolve a local JSON pointer such as "#/$defs/node" against the root schema. */
function resolveRef(root: SchemaNode, ref: string): SchemaNode {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported $ref (only local pointers are supported): ${ref}`);
  }
  const segments = ref
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

  let cursor: unknown = root;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null) {
      throw new Error(`Unresolvable $ref: ${ref}`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor !== 'object' || cursor === null) {
    throw new Error(`Unresolvable $ref: ${ref}`);
  }
  return cursor as SchemaNode;
}

interface Context {
  readonly root: SchemaNode;
  readonly errors: string[];
}

function fail(ctx: Context, path: string, message: string): void {
  if (ctx.errors.length < MAX_REPORTED_ERRORS) {
    ctx.errors.push(`${path || '(root)'}: ${message}`);
  }
}

function checkScalarConstraints(ctx: Context, schema: SchemaNode, value: unknown, path: string): void {
  if (typeof value === 'string') {
    const minLength = schema.minLength;
    if (typeof minLength === 'number' && value.length < minLength) {
      fail(ctx, path, `shorter than minLength ${minLength}`);
    }
    const pattern = schema.pattern;
    if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) {
      fail(ctx, path, `does not match pattern ${pattern}`);
    }
    return;
  }
  if (typeof value !== 'number') return;

  const { minimum, maximum, exclusiveMinimum } = schema;
  if (typeof minimum === 'number' && value < minimum) fail(ctx, path, `below minimum ${minimum}`);
  if (typeof maximum === 'number' && value > maximum) fail(ctx, path, `above maximum ${maximum}`);
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
    fail(ctx, path, `not greater than ${exclusiveMinimum}`);
  }
}

function checkObject(ctx: Context, schema: SchemaNode, value: object, path: string): void {
  const record = value as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;

  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === 'string' && !(key in record)) {
        fail(ctx, path, `missing required property "${key}"`);
      }
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) fail(ctx, path, `unexpected property "${key}"`);
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (!(key in record)) continue;
    validateNode(ctx, childSchema, record[key], path ? `${path}.${key}` : key);
  }
}

function validateNode(ctx: Context, schema: SchemaNode, value: unknown, path: string): void {
  if (ctx.errors.length >= MAX_REPORTED_ERRORS) return;

  const ref = schema.$ref;
  if (typeof ref === 'string') {
    validateNode(ctx, resolveRef(ctx.root, ref), value, path);
    return;
  }

  /**
   * anyOf: the value must satisfy at least one branch.
   *
   * Needed so a field can accept an old and a new shape at once — `subConcepts`
   * holds bare strings in vaults written before notes existed, and objects
   * since. Failing those files rather than reading them would strand the
   * author's work behind a schema change they never made.
   *
   * Errors from failed branches are discarded: a value that satisfies one
   * branch is valid, and reporting the others would be noise.
   */
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const matched = anyOf.some((branch) => {
      const probe: Context = { root: ctx.root, errors: [] };
      validateNode(probe, branch as SchemaNode, value, path);
      return probe.errors.length === 0;
    });
    if (!matched) {
      fail(ctx, path, `did not match any accepted shape (received ${typeOf(value)})`);
    }
    return;
  }

  if ('const' in schema && value !== schema.const) {
    fail(ctx, path, `must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.includes(value as never)) {
    fail(ctx, path, `must be one of ${JSON.stringify(enumValues)}`);
    return;
  }

  const expectedType = schema.type;
  if (typeof expectedType === 'string' && !matchesType(value, expectedType as JsonType)) {
    fail(ctx, path, `expected ${expectedType}, received ${typeOf(value)}`);
    return;
  }

  checkScalarConstraints(ctx, schema, value, path);

  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === 'object') {
      value.forEach((item, index) =>
        validateNode(ctx, itemSchema as SchemaNode, item, `${path}[${index}]`),
      );
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    checkObject(ctx, schema, value, path);
  }
}

/**
 * Validate `value` against `schema`. `root` defaults to `schema` and is what
 * local `$ref` pointers resolve against — pass the whole document when
 * validating a `$defs` subschema.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: SchemaNode,
  root: SchemaNode = schema,
): ValidationResult {
  const ctx: Context = { root, errors: [] };
  try {
    validateNode(ctx, schema, value, '');
  } catch (error: unknown) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : 'Schema resolution failed'],
    };
  }
  return ctx.errors.length === 0 ? { valid: true } : { valid: false, errors: ctx.errors };
}
