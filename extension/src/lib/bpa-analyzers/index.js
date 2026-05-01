// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit analyzers (FMN-132). Pure-JS port of the five Python analyzer
// classes from fortimonitor_audit.py. Each analyzer is a pure function
// over the BpaInventory dict produced by FMN-131's BpaFetcher; no IO,
// no DOM, no chrome.* APIs.
//
// FMN-133 (the in-browser viewer) consumes the combined output from
// runAllAnalyzers().

import { analyzeIncidents } from './incident.js';
import { analyzeUsers } from './user.js';
import { analyzeInstances } from './instance.js';
import { analyzeTemplates } from './template.js';
import { analyzeMonitoringPolicy } from './monitoring-policy.js';

export { analyzeIncidents, analyzeUsers, analyzeInstances, analyzeTemplates, analyzeMonitoringPolicy };

/**
 * @typedef {Object} BpaAnalysis
 * @property {import('./incident.js').IncidentResult} incidents
 * @property {import('./user.js').UserResult} users
 * @property {import('./instance.js').InstanceResult} instances
 * @property {import('./template.js').TemplateResult} templates
 * @property {import('./monitoring-policy.js').MonitoringPolicyResult} monitoring_policy
 */

/**
 * Run every analyzer on the inventory. Order matches the Python script's
 * report-writing order (Incident, User, Instance, Template, Policy) so
 * downstream UI tabs land in a predictable sequence.
 *
 * @param {Object} inventory  BpaInventory from FMN-131's BpaFetcher
 * @returns {BpaAnalysis}
 */
export function runAllAnalyzers(inventory = {}) {
  return {
    incidents: analyzeIncidents(inventory),
    users: analyzeUsers(inventory),
    instances: analyzeInstances(inventory),
    templates: analyzeTemplates(inventory),
    monitoring_policy: analyzeMonitoringPolicy(inventory)
  };
}
