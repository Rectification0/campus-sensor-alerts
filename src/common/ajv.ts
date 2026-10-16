import { Ajv } from 'ajv';
// ajv-formats is CommonJS: under NodeNext TypeScript types the default import as the whole
// module, whose `default` property is the plugin (module.exports.default === module.exports).
import addFormats from 'ajv-formats';

/**
 * Bodies are validated strictly: no type coercion and unknown properties are rejected
 * rather than silently removed. Query strings and params need coercion ("50" -> 50).
 */
export function createAjv({ coerce }: { coerce: boolean }): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    coerceTypes: coerce ? 'array' : false,
    removeAdditional: false,
    useDefaults: true,
  });
  addFormats.default(ajv);
  return ajv;
}
