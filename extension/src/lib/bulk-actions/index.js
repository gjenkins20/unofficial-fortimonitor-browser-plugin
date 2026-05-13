// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: action registry for the Bulk Action Composer.
//
// New actions plug in here. Each module exports the same shape:
//   { id, label, description, requires, writeMethod,
//     validate(params),
//     describe(target, params) -> { prev, next, willChange, note?, error? },
//     commit(target, params, { client }) -> { status, ... } }

import * as addTag from './add-tag.js';
import * as removeTag from './remove-tag.js';
import * as applyTemplate from './apply-template.js';
import * as applyBestPracticeFabric from './apply-best-practice-fabric.js';
import * as profileAndCreateTemplates from './profile-and-create-templates.js';

export const ACTIONS = [addTag, removeTag, applyTemplate, applyBestPracticeFabric, profileAndCreateTemplates];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function getAction(id) {
  return BY_ID.get(id) || null;
}

export function listActions() {
  return ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    requires: a.requires,
    writeMethod: a.writeMethod
  }));
}
