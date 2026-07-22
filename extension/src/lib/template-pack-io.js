// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-298: template-pack export / import envelope + filename derivation.
//
// A "template pack" is the portable, client-anonymized artifact produced by
// template-anonymizer.js. It is deliberately separate from the observations
// snapshot format (snapshot-io.js) so a pack is unambiguously distinguishable
// from a snapshot on load, and so bumping one format never touches the other.
//
// Envelope shape (formatVersion=1):
//   {
//     format: 'fmn-template-pack',
//     formatVersion: 1,
//     exportedAt: '<ISO timestamp>',
//     extensionVersion: '<manifest version string or null>',
//     pack: {
//       schema: 1,
//       anonymized: true,
//       templateCount: <N>,
//       inventory: {
//         server_templates: [...],
//         server_group_details: {...},
//         template_monitoring_configs: {...}
//       }
//     }
//   }
//
// The pack carries NO customer name, subdomain, or origin - anonymization
// means the file (and its filename) reveal nothing about the source tenant.
//
// wrapTemplatePack ENFORCES anonymization (FMN-298 review, Finding 6): it runs
// assertAnonymizedInventory() before stamping `anonymized: true`, so a raw or
// mis-wired inventory throws at export instead of shipping a mislabeled leak.
// The guarantee therefore lives in the module that makes the claim, not only
// at the one UI call site.

import { assertAnonymizedInventory } from './template-anonymizer.js';

export const FORMAT_NAME = 'fmn-template-pack';
export const FORMAT_VERSION = 1;
export const PACK_SCHEMA = 1;
export const SUPPORTED_PACK_SCHEMAS = [1];

export class TemplatePackError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'TemplatePackError';
    this.code = code || 'invalid';
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Wrap an anonymized template-slice inventory in a transport envelope.
 * @param {{server_templates:Object[], server_group_details:Object, template_monitoring_configs:Object}} inventory
 */
export function wrapTemplatePack(inventory, { extensionVersion = null, now } = {}) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw new TemplatePackError('Refusing to export an empty template pack.', { code: 'empty' });
  }
  const templates = inventory.server_templates;
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new TemplatePackError('Refusing to export a template pack with no templates.', { code: 'empty' });
  }
  // Enforce anonymization before we will label the pack anonymized.
  try {
    assertAnonymizedInventory(inventory);
  } catch (err) {
    throw new TemplatePackError(
      `Refusing to export: ${err?.message || 'inventory is not anonymized'}.`,
      { code: 'not-anonymized' }
    );
  }
  const exportedAt = (now instanceof Date ? now : new Date()).toISOString();
  return {
    format: FORMAT_NAME,
    formatVersion: FORMAT_VERSION,
    exportedAt,
    extensionVersion: extensionVersion || null,
    pack: {
      schema: PACK_SCHEMA,
      anonymized: true,
      templateCount: templates.length,
      inventory: {
        server_templates: templates,
        server_group_details: isObject(inventory.server_group_details) ? inventory.server_group_details : {},
        template_monitoring_configs: isObject(inventory.template_monitoring_configs) ? inventory.template_monitoring_configs : {},
      },
    },
  };
}

/**
 * Validate + unwrap a parsed envelope. Hard-errors (does not silently
 * migrate) on an unknown format, a newer file format version, or a pack
 * schema this build does not understand.
 * @returns {{ pack: Object, envelope: Object }}
 */
export function unwrapTemplatePack(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TemplatePackError('File is not a valid template pack envelope.', { code: 'not-envelope' });
  }
  if (envelope.format !== FORMAT_NAME) {
    throw new TemplatePackError(
      `Unknown file format "${envelope.format ?? ''}". Expected "${FORMAT_NAME}".`,
      { code: 'wrong-format', detail: envelope.format ?? null }
    );
  }
  if (envelope.formatVersion !== FORMAT_VERSION) {
    throw new TemplatePackError(
      `Unsupported template pack file version ${envelope.formatVersion ?? '?'}. This extension build supports version ${FORMAT_VERSION}.`,
      { code: 'wrong-format-version', detail: envelope.formatVersion ?? null }
    );
  }
  const pack = envelope.pack;
  if (!pack || typeof pack !== 'object') {
    throw new TemplatePackError('Envelope is missing its pack payload.', { code: 'missing-pack' });
  }
  if (!SUPPORTED_PACK_SCHEMAS.includes(pack.schema)) {
    throw new TemplatePackError(
      `Unsupported template pack schema ${pack.schema ?? '?'}. This extension build understands schema ${SUPPORTED_PACK_SCHEMAS.join(', ')}.`,
      { code: 'wrong-schema', detail: pack.schema ?? null }
    );
  }
  if (!isObject(pack.inventory) || !Array.isArray(pack.inventory.server_templates)) {
    throw new TemplatePackError('Template pack is missing its template inventory.', { code: 'missing-inventory' });
  }
  return { pack, envelope };
}

/**
 * Parse the JSON string a file picker handed us, funnelling every failure
 * into a single TemplatePackError type.
 */
export function parseTemplatePackJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TemplatePackError(
      `File is not valid JSON: ${err?.message || 'parse failed'}.`,
      { code: 'not-json' }
    );
  }
  return unwrapTemplatePack(parsed);
}

/**
 * Identity-free filename for an exported pack. By design it carries no
 * tenant/customer identifier - only a UTC minute-resolution timestamp to
 * keep multiple exports distinct.
 */
export function templatePackFilename({ now } = {}) {
  const stamp = formatStamp((now instanceof Date ? now : new Date()).toISOString());
  return `fmn-template-pack-${stamp}.json`;
}

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatStamp(new Date().toISOString());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
