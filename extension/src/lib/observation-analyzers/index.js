// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tenant Observations analyzers (FMN-132). Pure-JS port of the five Python analyzer
// classes from fortimonitor_audit.py. Each analyzer is a pure function
// over the ObservationsInventory dict produced by FMN-131's ObservationsFetcher; no IO,
// no DOM, no chrome.* APIs.
//
// FMN-133 (the in-browser viewer) consumes the combined output from
// runAllAnalyzers().

import { analyzeIncidents } from './incident.js';
import { analyzeUsers } from './user.js';
import { analyzeInstances } from './instance.js';
import { analyzeTemplates } from './template.js';
import { analyzeMonitoringPolicy } from './monitoring-policy.js';
import { analyzeNoise } from './noise.js';
import { analyzerKeysForSections } from '../observations-section-deps.js';

export { analyzeIncidents, analyzeUsers, analyzeInstances, analyzeTemplates, analyzeMonitoringPolicy, analyzeNoise };

/**
 * @typedef {Object} ObservationsAnalysis
 * @property {import('./incident.js').IncidentResult} [incidents]
 * @property {import('./user.js').UserResult} [users]
 * @property {import('./instance.js').InstanceResult} [instances]
 * @property {import('./template.js').TemplateResult} [templates]
 * @property {import('./monitoring-policy.js').MonitoringPolicyResult} [monitoring_policy]
 * @property {import('./noise.js').NoiseResult} [noise]
 */

/**
 * Run analyzers on the inventory. Order matches the Python script's
 * report-writing order (Incident, User, Instance, Template, Policy) so
 * downstream UI tabs land in a predictable sequence.
 *
 * FMN-149: when `sections` is supplied and not ["all"], only the
 * requested analyzers run. Skipped analyzers' result keys are absent
 * (not empty) - the viewer's tab-filter relies on `key in analysis` to
 * decide whether to surface the corresponding tab.
 *
 * @param {Object} inventory  ObservationsInventory from FMN-131's ObservationsFetcher
 * @param {object} [options]
 * @param {string[]} [options.sections]
 * @returns {ObservationsAnalysis}
 */
export function runAllAnalyzers(inventory = {}, { sections } = {}) {
  const wanted = analyzerKeysForSections(sections);
  /** @type {ObservationsAnalysis} */
  const out = {};
  if (wanted.has('incidents')) out.incidents = analyzeIncidents(inventory);
  if (wanted.has('users')) out.users = analyzeUsers(inventory);
  if (wanted.has('instances')) out.instances = analyzeInstances(inventory);
  if (wanted.has('templates')) out.templates = analyzeTemplates(inventory);
  if (wanted.has('monitoring_policy')) out.monitoring_policy = analyzeMonitoringPolicy(inventory);
  // FMN-156: noise analyzer feeds the Noise Analysis tab. It reads the
  // same outages list the IncidentAnalyzer does, so its top-level key
  // requirement maps to the existing 'noise-analysis' section -> outages.
  if (wanted.has('noise')) out.noise = analyzeNoise(inventory);
  return out;
}
