/**
 * Compares a decision's input contract with a form definition.
 *
 * Both are draft-07 JSON Schemas for the request's `context` (youmssi/donka,
 * docs/artifact-format.md#input-contracts). A field is a property at any
 * depth, named by its dotted path; array items add `[]` (`loans[].amount`).
 * Only what decides whether a form's submission reaches the rules intact is
 * compared: which fields exist, their type, and whether they are required.
 */

type Schema = Record<string, unknown>;

export interface Field {
  path: string;
  /** Sorted JSON types; empty when the schema accepts any type. */
  types: string[];
  required: boolean;
}

export type DifferenceKind = 'missing' | 'unknown' | 'renamed' | 'type' | 'required';

export interface Difference {
  field: string;
  kind: DifferenceKind;
  message: string;
  /** For `renamed`: the form's name for the field. */
  form?: string;
}

const isObject = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A form library's definition often wraps the schema with its own keys
 * (`{ "schema": …, "uiSchema": … }`); the schema is what is compared.
 */
export const schemaOf = (definition: unknown): Schema | null => {
  if (!isObject(definition)) {
    return null;
  }
  if (!('properties' in definition) && !('type' in definition) && isObject(definition.schema)) {
    return definition.schema;
  }
  return 'properties' in definition || definition.type === 'object' ? definition : null;
};

/** Follows local references (`#/definitions/…`); anything else is left as is. */
const resolveRef = (schema: Schema, root: Schema): Schema => {
  let current = schema;
  for (let hops = 0; typeof current.$ref === 'string' && current.$ref.startsWith('#') && hops < 32; hops += 1) {
    let target: unknown = root;
    for (const segment of current.$ref.slice(1).split('/').filter(Boolean)) {
      const key = decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
      target = isObject(target) ? target[key] : undefined;
    }
    if (!isObject(target)) {
      return current;
    }
    current = target;
  }
  return current;
};

const typesOf = (schema: Schema): string[] => {
  const { type } = schema;
  if (typeof type === 'string') {
    return [type];
  }
  return Array.isArray(type) ? type.filter((item): item is string => typeof item === 'string').sort() : [];
};

/** Every field of a schema, depth first, in declaration order. */
export const fieldsOf = (root: Schema): Field[] => {
  const fields: Field[] = [];
  const walk = (node: Schema, prefix: string, depth: number) => {
    const schema = resolveRef(node, root);
    if (depth > 32) {
      return;
    }
    const items = isObject(schema.items) ? resolveRef(schema.items, root) : undefined;
    if (items && prefix) {
      walk(items, `${prefix}[]`, depth + 1);
    }
    if (!isObject(schema.properties)) {
      return;
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!isObject(child)) {
        continue;
      }
      const path = prefix ? `${prefix}.${name}` : name;
      fields.push({ path, types: typesOf(resolveRef(child, root)), required: required.has(name) });
      walk(child, path, depth + 1);
    }
  };
  walk(root, '', 0);
  return fields;
};

/** A form may be stricter than the contract: an integer field feeds a number. */
const typeFits = (form: string[], contract: string[]): boolean =>
  contract.length === 0 ||
  (form.length > 0 &&
    form.every((type) => contract.includes(type) || (type === 'integer' && contract.includes('number'))));

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('.')));
const describeTypes = (types: string[]): string => (types.length > 0 ? types.join(' or ') : 'any type');

/** Every difference between the contract and the form, in the contract's order, then the form's extras. */
export const compare = (contract: Schema, form: Schema): Difference[] => {
  const contractFields = fieldsOf(contract);
  const formFields = new Map(fieldsOf(form).map((field) => [field.path, field]));
  const known = new Set(contractFields.map((field) => field.path));
  const extras = [...formFields.values()].filter((field) => !known.has(field.path));
  // A field inside one already reported missing is not reported again.
  const reported: string[] = [];
  const differences: Difference[] = [];

  for (const field of contractFields) {
    if (reported.some((path) => field.path.startsWith(`${path}.`) || field.path.startsWith(`${path}[]`))) {
      continue;
    }
    const match = formFields.get(field.path);
    if (!match) {
      reported.push(field.path);
      // One field gone and one of the same type arrived beside it reads as a rename.
      const renamed = extras.findIndex(
        (extra) => parentOf(extra.path) === parentOf(field.path) && extra.types.join() === field.types.join(),
      );
      if (renamed !== -1) {
        const [extra] = extras.splice(renamed, 1);
        if (extra) {
          reported.push(extra.path);
          differences.push({
            field: field.path,
            kind: 'renamed',
            form: extra.path,
            message: `the form has "${extra.path}" instead (renamed?)`,
          });
          continue;
        }
      }
      differences.push({ field: field.path, kind: 'missing', message: 'in the contract, not in the form' });
      continue;
    }
    if (!typeFits(match.types, field.types)) {
      differences.push({
        field: field.path,
        kind: 'type',
        message: `contract: ${describeTypes(field.types)}, form: ${describeTypes(match.types)}`,
      });
    }
    if (field.required !== match.required) {
      differences.push({
        field: field.path,
        kind: 'required',
        message: field.required
          ? 'required by the contract, optional in the form'
          : 'required in the form, optional in the contract',
      });
    }
  }

  for (const extra of extras) {
    if (reported.some((path) => extra.path.startsWith(`${path}.`) || extra.path.startsWith(`${path}[]`))) {
      continue;
    }
    reported.push(extra.path);
    differences.push({ field: extra.path, kind: 'unknown', message: 'in the form, not in the contract' });
  }

  return differences;
};

/** Presentation hints Studio keeps beside the standard keywords; validation ignores them. */
const hintsOf = (schema: Schema): Schema => (isObject(schema['x-donka']) ? schema['x-donka'] : {});

/** `{ "en": …, "fr": … }`, falling back to English. */
const localized = (value: unknown, lang: string): string | undefined => {
  const text = isObject(value) ? (value[lang] ?? value.en) : undefined;
  return typeof text === 'string' ? text : undefined;
};

/**
 * A starting form definition: the contract itself, with each field's label and
 * help in `lang` as the standard `title` and `description` that JSON Schema
 * form libraries display, and properties in their `order`.
 */
export const formFromContract = (contract: Schema, lang: string): Schema => {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(convert);
    }
    if (!isObject(node)) {
      return node;
    }
    const result: Schema = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = key === 'properties' && isObject(value) ? convertProperties(value) : convert(value);
    }
    const hints = hintsOf(node);
    const title = localized(hints.label, lang);
    const description = localized(hints.help, lang);
    if (title && result.title === undefined) {
      result.title = title;
    }
    if (description && result.description === undefined) {
      result.description = description;
    }
    return result;
  };
  const convertProperties = (properties: Schema): Schema =>
    Object.fromEntries(
      Object.entries(properties)
        .map(([name, value], index) => {
          const order = isObject(value) ? hintsOf(value).order : undefined;
          return { name, value: convert(value), rank: typeof order === 'number' ? order : Infinity, index };
        })
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(({ name, value }) => [name, value]),
    );
  return convert(contract) as Schema;
};
