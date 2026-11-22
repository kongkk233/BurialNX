import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBundledModule, root } from './ts-bundle.mjs';

const schema = JSON.parse(await readFile(resolve(root, 'profiles/schema.json'), 'utf8'));
const schemaValidator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function schemaErrors() {
  return (schemaValidator.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message}`).join('; ');
}

function parseJson(bytes, file) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch (error) { throw new Error(`Invalid profile JSON at ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function profileApi() {
  return loadBundledModule('src/port-profile.ts');
}

export async function validateProfileFile(file) {
  const api = await profileApi();
  const absolute = resolve(file);
  const bytes = await readFile(absolute);
  const raw = parseJson(bytes, absolute);
  if (!schemaValidator(raw)) throw new Error(`Profile schema validation failed at ${absolute}: ${schemaErrors()}`);
  const profile = api.parsePortProfile(raw);
  return { path: absolute, profile };
}

function cliPath() {
  return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
}

if (import.meta.url === cliPath()) {
  const file = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  if (!file) {
    console.error('Usage: npm run profile:validate -- <profile.json>');
    process.exitCode = 2;
  } else {
    try {
      const result = await validateProfileFile(file);
      console.log(JSON.stringify({
        status: 'pass',
        tool: 'profile:validate',
        path: result.path,
        profile: result.profile,
      }, null, 2));
    } catch (error) {
      console.error(`profile validation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

export { root };
