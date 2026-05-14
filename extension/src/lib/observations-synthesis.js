// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tenant Observations synthesis layer (FMN-133).
//
// Pure functions that derive the non-analyzer report sections directly
// from the ObservationsInventory and the ObservationsAnalysis. Ports of:
//   - _write_executive_summary  -> buildExecutiveSummary
//   - _write_feature_utilization -> buildFeatureUtilization
//   - _build_labs               -> buildLabs
//   - _write_raw_counts         -> buildRawCounts
//
// These live alongside the analyzers (observation-analyzers/) but are file-level
// utilities the viewer renders, not reusable analyzers in their own
// right.
//
// FMN-218 (2026-05-14): the prioritized-recommendations builder
// (`buildRecommendations`) was removed when the operator-visible
// "Recommendations" tab came out. Per-row analyzer findings now ship as
// neutral observations; there is no synthesized opinion layer.

/**
 * @typedef {{ title: string, time: string, feature: string, steps: string }} Lab
 * @typedef {{ key: string, value: string|number }} KvRow
 * @typedef {{ feature: string, count: string, assessment: string }} FeatureRow
 * @typedef {{ resource: string, count: number }} CountRow
 */

/**
 * Executive summary KV rows.
 *
 * @param {object} inventory
 * @param {object} analysis
 * @param {string} [customer]
 * @returns {KvRow[]}
 */
export function buildExecutiveSummary(inventory = {}, analysis = {}, customer = '') {
  const servers = arr(inventory.servers);
  const fabric = arr(inventory.fabric_connections);
  const groups = arr(inventory.server_groups);
  const outages = arr(inventory.outages);
  const active = outages.filter((o) => o?.active === true);
  const users = arr(inventory.users);
  const maint = arr(inventory.maintenance_windows);

  let deployModel;
  if (fabric.length > servers.length) deployModel = 'Fabric-Managed';
  else if (servers.length > 0) deployModel = 'Direct / Agent-Based';
  else deployModel = 'Unknown';

  const rows = [];
  if (customer) rows.push({ key: 'Customer', value: customer });
  rows.push({ key: 'Deployment Model', value: deployModel });
  rows.push({ key: 'Servers (Direct)', value: servers.length });
  rows.push({ key: 'Fabric Connections', value: fabric.length });
  rows.push({ key: 'Server Groups', value: groups.length });
  rows.push({ key: 'Active Incidents', value: active.length });

  if (active.length > 0) {
    const ids = active.slice(0, 5).map((o) => String(o?.id ?? ''));
    let idStr = ids.join(', ');
    if (active.length > 5) idStr += `, +${active.length - 5} more`;
    rows.push({ key: 'Active Incident IDs', value: idStr });
  }

  const crit = active.filter((o) => String(o?.severity ?? '').toLowerCase() === 'critical').length;
  const warn = active.filter((o) => String(o?.severity ?? '').toLowerCase() === 'warning').length;
  rows.push({ key: '  Critical', value: crit });
  rows.push({ key: '  Warning', value: warn });

  const acked = active.filter((o) => o?.acknowledged === true).length;
  const ackRate = active.length > 0
    ? `${((acked / active.length) * 100).toFixed(1)}%`
    : 'N/A';
  rows.push({ key: 'Acknowledgment Rate', value: ackRate });

  let status;
  if (crit > 0) status = crit >= 3 ? 'CRITICAL' : 'WARNING';
  else if (warn > 0) status = 'WARNING';
  else status = 'HEALTHY';
  rows.push({ key: 'Overall Status', value: status });

  const reasons = [];
  if (crit > 0) reasons.push(`${crit} critical incident(s) active`);
  const unacked = active.length - acked;
  if (unacked > 0) reasons.push(`${unacked} incident(s) not yet acknowledged`);
  if (reasons.length === 0) reasons.push('No active incidents');
  rows.push({ key: 'Status Reasoning', value: reasons.join('; ') });

  rows.push({ key: 'Users', value: users.length });
  rows.push({ key: 'Maintenance Windows (Total)', value: maint.length });

  // The Python source also adds an analyzer-derived row when the trending
  // result is materially worse than the prior period. Surfacing the
  // current trend label in the exec summary is a small helpful signal.
  const trend = analysis?.incidents?.trending;
  if (trend?.week_trend) rows.push({ key: 'Week-over-week', value: trend.week_trend });
  if (trend?.month_trend) rows.push({ key: 'Month-over-month', value: trend.month_trend });

  return rows;
}

/**
 * Feature utilization. Two sections: actively used vs. underutilized.
 *
 * @param {object} inventory
 * @returns {{ active: FeatureRow[], underutilized: FeatureRow[] }}
 */
export function buildFeatureUtilization(inventory = {}) {
  const servers = arr(inventory.servers);
  const fabric = arr(inventory.fabric_connections);
  const dashboards = arr(inventory.dashboards);
  const maint = arr(inventory.maintenance_windows);
  const onsights = arr(inventory.onsights);
  const nodes = arr(inventory.monitoring_nodes);
  const schedules = arr(inventory.notification_schedules);
  const dem = arr(inventory.dem_applications);
  const templates = arr(inventory.server_templates);
  const cloud = arr(inventory.cloud_credentials);
  const contactGroups = arr(inventory.contact_groups);
  const compound = arr(inventory.compound_services);
  const snmp = arr(inventory.snmp_credentials);
  const rotating = arr(inventory.rotating_contacts);
  const statusPages = arr(inventory.status_pages);

  const active = [];
  if (fabric.length > 0) {
    active.push({
      feature: 'Server Monitoring (Fabric)',
      count: `${fabric.length} fabric connections`,
      assessment: `Servers managed via ${fabric.length} Fortinet Fabric integration(s).`
    });
  } else if (servers.length > 0) {
    active.push({
      feature: 'Server Monitoring (Direct)',
      count: `${servers.length} servers`,
      assessment: `${servers.length} server(s) directly monitored.`
    });
  }
  if (dashboards.length > 0) active.push(featRow('Dashboards', dashboards.length, `${dashboards.length} dashboard(s) configured.`));
  if (maint.length > 0) active.push(featRow('Maintenance Windows', maint.length, `${maint.length} maintenance window(s) in history.`));
  if (onsights.length > 0) active.push(featRow('OnSights', onsights.length, `${onsights.length} OnSight(s) deployed.`));
  if (fabric.length > 0) active.push(featRow('Fabric Connections', fabric.length, `${fabric.length} Fortinet fabric integration(s) active.`));
  if (schedules.length > 0) active.push(featRow('Alert Timelines', schedules.length, `${schedules.length} alert timeline(s) configured.`));
  if (nodes.length > 0) active.push(featRow('Monitoring Nodes', nodes.length, `${nodes.length} external monitoring node(s) available.`));
  if (templates.length > 0) active.push(featRow('Server Templates', templates.length, `${templates.length} template(s) configured.`));
  if (contactGroups.length > 0) active.push(featRow('Contact Groups', contactGroups.length, `${contactGroups.length} contact group(s) configured.`));

  const underutilized = [];
  if (dem.length === 0) underutilized.push({ feature: 'DEM Applications', count: '0', assessment: 'No DEM applications. Missing end-user experience visibility.' });
  if (templates.length < 5) underutilized.push({ feature: 'Server Templates', count: String(templates.length), assessment: `Only ${templates.length} template(s). Templates standardize monitoring.` });
  if (cloud.length === 0) underutilized.push({ feature: 'Cloud Discovery', count: '0', assessment: 'No cloud discovery. Auto-discovery of cloud resources not enabled.' });
  if (contactGroups.length === 0) underutilized.push({ feature: 'Contact Groups', count: '0', assessment: 'No contact groups. Alerts not routed to teams.' });
  if (compound.length === 0) underutilized.push({ feature: 'Compound Services', count: '0', assessment: 'No business-service aggregation for SLA reporting.' });
  if (snmp.length === 0) underutilized.push({ feature: 'SNMP Monitoring', count: '0', assessment: 'No SNMP credentials. Network device depth monitoring unavailable.' });
  if (rotating.length === 0) underutilized.push({ feature: 'Rotating Contacts (On-Call)', count: '0', assessment: 'No on-call rotations. Manual alert handling 24/7.' });
  if (statusPages.length === 0) underutilized.push({ feature: 'Status Pages', count: '0', assessment: 'No public status pages for stakeholder communication.' });

  return { active, underutilized };
}

/**
 * Quick-lab / exercise list. Ports Python _build_labs.
 *
 * @param {object} inventory
 * @returns {Lab[]}
 */
export function buildLabs(inventory = {}) {
  const labs = [];
  const contactGroups = arr(inventory.contact_groups);
  const compound = arr(inventory.compound_services);
  const dem = arr(inventory.dem_applications);
  const snmp = arr(inventory.snmp_credentials);
  const statusPages = arr(inventory.status_pages);
  const cloud = arr(inventory.cloud_credentials);

  if (contactGroups.length === 0) labs.push({
    title: 'Populate Contact Groups & Test Alert Routing',
    time: '15 min',
    feature: 'Contact Groups + Notification Routing',
    steps:
      '1. Assign existing contacts to the appropriate contact groups.\n' +
      '2. Map contact groups to server groups or notification schedules.\n' +
      '3. Test by triggering a test alert and verifying routing.'
  });
  if (compound.length === 0) labs.push({
    title: 'Build a Business-Critical Compound Service',
    time: '20 min',
    feature: 'Compound Services for SLA Reporting',
    steps:
      "1. Identify a logical business service (e.g., 'Email Suite').\n" +
      '2. Create a compound service and add relevant server checks.\n' +
      '3. Review the unified availability dashboard.'
  });
  if (dem.length === 0) labs.push({
    title: 'Deploy a DEM Application for SaaS Monitoring',
    time: '20 min',
    feature: 'Digital Experience Monitoring',
    steps:
      '1. Navigate to DEM Applications and create a new application.\n' +
      '2. Select a critical SaaS service (e.g., Microsoft 365).\n' +
      '3. Configure monitoring locations and review results.'
  });
  if (snmp.length === 0) labs.push({
    title: 'SNMP Discovery on Network Devices',
    time: '20 min',
    feature: 'SNMP Resource Monitoring',
    steps:
      '1. Create an SNMP credential (community string or v3 auth).\n' +
      '2. Select a network device and run SNMP discovery.\n' +
      '3. Review discovered resources and add thresholds.'
  });
  if (statusPages.length === 0) labs.push({
    title: 'Create a Public Status Page',
    time: '15 min',
    feature: 'Status Pages',
    steps:
      '1. Create a new status page with a meaningful name.\n' +
      '2. Add key services or compound services.\n' +
      '3. Share the URL with stakeholders.'
  });
  if (cloud.length === 0) labs.push({
    title: 'Enable Cloud Auto-Discovery',
    time: '25 min',
    feature: 'Cloud Discovery (AWS/Azure/GCP)',
    steps:
      '1. Add a cloud credential (e.g., AWS IAM role or Azure service principal).\n' +
      '2. Run a cloud discovery scan.\n' +
      '3. Review discovered resources and enable monitoring.'
  });

  // Always-included labs (Python source includes these unconditionally).
  labs.push({
    title: 'Deploy an Automated Countermeasure',
    time: '20 min',
    feature: 'Automated Remediation / Self-Healing',
    steps:
      '1. Select a network service check on a server with recurring outages.\n' +
      '2. Create a countermeasure script (e.g., restart service).\n' +
      '3. Test by simulating an outage.'
  });
  labs.push({
    title: 'Path Monitoring for Network Troubleshooting',
    time: '15 min',
    feature: 'Path Monitoring / Traceroute Analysis',
    steps:
      '1. Create a path monitoring config for a frequently alerting server.\n' +
      '2. Review hop data and latency.\n' +
      '3. Identify network bottlenecks.'
  });

  return labs;
}

/**
 * Raw counts table. Ports the Python _write_raw_counts row list.
 *
 * @param {object} inventory
 * @returns {CountRow[]}
 */
export function buildRawCounts(inventory = {}) {
  const servers = arr(inventory.servers);
  const active = servers.filter((s) => s?.status === 'active');
  const paused = servers.filter((s) => s?.status === 'paused');
  const inactive = servers.filter((s) => s?.status === 'inactive');
  return [
    { resource: 'Servers (Direct)', count: servers.length },
    { resource: '  Active', count: active.length },
    { resource: '  Paused', count: paused.length },
    { resource: '  Inactive', count: inactive.length },
    { resource: 'Fabric Connections', count: arr(inventory.fabric_connections).length },
    { resource: 'Server Groups (total)', count: arr(inventory.server_groups).length },
    { resource: 'Dashboards', count: arr(inventory.dashboards).length },
    { resource: 'OnSights', count: arr(inventory.onsights).length },
    { resource: 'Alert Timelines', count: arr(inventory.notification_schedules).length },
    { resource: 'Monitoring Nodes', count: arr(inventory.monitoring_nodes).length },
    { resource: 'DEM Applications', count: arr(inventory.dem_applications).length },
    { resource: 'Server Templates', count: arr(inventory.server_templates).length },
    { resource: 'Cloud Discovery', count: arr(inventory.cloud_credentials).length },
    { resource: 'Contact Groups', count: arr(inventory.contact_groups).length },
    { resource: 'Compound Services', count: arr(inventory.compound_services).length },
    { resource: 'SNMP Monitoring', count: arr(inventory.snmp_credentials).length },
    { resource: 'Rotating Contacts (On-Call)', count: arr(inventory.rotating_contacts).length },
    { resource: 'Status Pages', count: arr(inventory.status_pages).length }
  ];
}

function arr(v) { return Array.isArray(v) ? v : []; }
function featRow(feature, n, assessment) {
  return { feature, count: String(n), assessment };
}
