import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const schema = JSON.parse(await readFile(resolve(root, 'profiles/schema.json'), 'utf8'));
const schemaValidator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function schemaErrors() {
  return (schemaValidator.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message}`).join('; ');
}

export function validateProfileDocument(value, label = 'profile') {
  if (!schemaValidator(value)) throw new Error(`Profile schema validation failed at ${label}: ${schemaErrors()}`);
  return value;
}

export function parseProfileBytes(bytes, label = 'profile') {
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (error) { throw new Error(`Invalid profile JSON at ${label}: ${error instanceof Error ? error.message : String(error)}`); }
  return validateProfileDocument(value, label);
}
