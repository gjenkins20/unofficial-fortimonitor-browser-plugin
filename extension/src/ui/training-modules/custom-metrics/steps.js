// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-244: Custom Metrics training module - tour content + quiz.
//
// Reuses the FMN-167 tour engine (steps + captions + anchors) so the
// in-page runtime experience matches Introduction to FortiMonitor. Content
// is authored from FortiMonitor 26.2.0 user guide pages 66910 (Custom
// Metric Management) and 382178 (Custom Metrics and Incidents).
//
// Anchor strategy: this module leans on conceptual centered cards (anchor:
// 'body') with the engine's floating fallback for the bulk of the tour
// because the Custom Metric management UI selectors have not been
// operator-confirmed yet (memory: operator_pairing_for_dom_anchors). The
// few page-level anchors below use the same anchorByText / anchorBySelector
// hint shape that intro-tour-bridge.js already resolves, so the same
// resolver can be reused if/when we extract a shared helper.
//
// Beta status: the tour content is shippable as-is; later QA passes will
// tighten anchors where the operator confirms selectors.

export const CUSTOM_METRICS_TOUR_STEPS = [
  {
    id: 'welcome',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p><strong>Custom Metrics in FortiMonitor.</strong> This walkthrough ',
      'covers what a custom metric is, when to reach for one, where the ',
      'management UI lives, and how the metric you author flows into ',
      "FortiMonitor's incident pipeline. A short 3-question check follows ",
      'at the end.</p>',
      '<p>Click <strong>Next</strong> to begin.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'what-is-a-custom-metric',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p>A <strong>custom metric</strong> is a measurement you define ',
      'yourself, evaluated on a schedule, scoped to the instances you ',
      'choose. FortiMonitor ships dozens of built-in metric types ',
      "(bandwidth, CPU, interface state, etc.); custom metrics fill the ",
      'gap when the value you care about is operationally meaningful ',
      'to your environment but not part of the stock catalog.</p>',
      '<p>Common shapes: a synthetic ping-time check against an internal ',
      'endpoint, a count derived from a JSON API response, the output of ',
      'an SNMP OID the stock catalog does not cover, or a value scraped ',
      'from a small helper script.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'when-to-use',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p><strong>When to use a custom metric:</strong></p>',
      '<ul>',
      '<li>The value is environment-specific (a queue depth on your ',
      'internal broker, a response-time floor against a vendor endpoint).</li>',
      '<li>You already have a script or API that returns the number and ',
      'want FortiMonitor to track it on a schedule, plot it, and alert ',
      'on it.</li>',
      '<li>The built-in plugin family does not expose the data point you ',
      'need (e.g., a derived ratio, a per-tenant rollup, a business KPI).</li>',
      '</ul>',
      '<p>If a built-in plugin already covers it, prefer the built-in - ',
      'they are tuned for FortiMonitor and surface in the standard UI ',
      'with less configuration.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'where-to-find-it',
    anchorByText: 'Monitoring',
    anchor_fallback: 'body',
    caption_html: [
      '<p>Custom Metric management lives under the <strong>Monitoring</strong> ',
      "section of the sidebar. The exact entry name and depth depends on ",
      "your tenant's UI version - look for a <em>Custom Metrics</em> ",
      'submenu or section header.</p>',
      '<p>From that page you can browse existing custom metrics, drill into ',
      "any one's history, and add a new metric type.</p>"
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'right'
  },
  {
    id: 'management-ui',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p>The <strong>Custom Metric Management</strong> view lists every ',
      'custom metric defined on this tenant. Each row shows the metric ',
      "name, the instance scope it is attached to, the evaluation ",
      'frequency, and the most recent value. Click any row to inspect the ',
      'configuration or recent history; use the <em>Add Custom Metric</em> ',
      'action to author a new one.</p>',
      '<p>Custom metrics that you no longer need can be deactivated from ',
      'this list - deactivation stops evaluation without deleting the ',
      'historical points already collected.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'configuration-fields',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p>When you author a custom metric, the configuration covers four ',
      'concerns:</p>',
      '<ol>',
      '<li><strong>Identity:</strong> name + description (shown in lists, ',
      'incident captions, dashboards).</li>',
      '<li><strong>Data source:</strong> the script, API, or SNMP OID ',
      'that returns the value. FortiMonitor evaluates the source on the ',
      'schedule you set and records the result.</li>',
      '<li><strong>Units + display:</strong> the unit string (e.g. "ms", ',
      '"count", "%") and any display formatting hints. This is what ',
      'shows up on graphs and in dashboard cards.</li>',
      '<li><strong>Scope:</strong> the instances or instance group the ',
      'metric attaches to. A custom metric can be attached to one ',
      'instance, to many, or to a server group as a default.</li>',
      '</ol>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'frequency-and-thresholds',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p><strong>Frequency</strong> is how often FortiMonitor evaluates ',
      'the metric. Short frequencies catch transient anomalies but cost ',
      'evaluation overhead; long frequencies are cheap but blur sharp ',
      'changes. The catalog default is one minute; many custom metrics ',
      'run at five minutes once tuned.</p>',
      '<p><strong>Thresholds</strong> turn raw numbers into actionable ',
      'state. Each threshold carries a severity (warning, critical), a ',
      'comparison (greater-than, less-than, equals, range), and a ',
      'timeline (how long the breach must persist before a state change ',
      'fires). Multiple thresholds on the same metric give you a ',
      'graduated response.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'custom-metrics-into-incidents',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p>A custom metric that breaches a threshold flows into the same ',
      '<strong>incident pipeline</strong> as every other FortiMonitor ',
      'alert. The incident inherits the metric name, the breaching value, ',
      'the threshold severity, and the instance the metric was scoped to. ',
      "From there it routes through your tenant's notification schedules, ",
      'shows up under <em>Incidents</em>, and respects acknowledgement ',
      'and resolve workflows like a built-in alert.</p>',
      '<p>This is the load-bearing reason to define a metric in ',
      'FortiMonitor instead of monitoring it elsewhere: the routing, ',
      'on-call rotation, and historical context are all already wired up.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'example-metric-callout',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p>An end-to-end <strong>example custom metric</strong> is checked ',
      'in under <code>docs/training/custom-metrics/</code>. It walks you ',
      'through wiring a small helper, attaching it to an instance, and ',
      "tracing the breach all the way to an incident. Open that doc when ",
      "you are ready to build your first one.</p>"
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'wrap-up',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p>You now know what a custom metric is, when to author one, how ',
      "the management UI is structured, and how custom metrics turn into ",
      'incidents.</p>',
      '<p>Click <strong>Next</strong> to take a short 3-question check.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  }
];

// Three multiple-choice questions covering the load-bearing concepts.
// Same shape as INTRO_TOUR_QUIZ in extension/src/ui/intro-tour/quiz.js so
// the existing renderer accepts them without modification.
export const CUSTOM_METRICS_QUIZ = Object.freeze([
  {
    id: 'q-purpose',
    prompt: 'A custom metric is the right tool when:',
    options: [
      { id: 'a', label: 'You want a different colour for the bandwidth graph.' },
      { id: 'b', label: 'The value you need is environment-specific or not in the built-in plugin catalog.', correct: true },
      { id: 'c', label: 'You want FortiMonitor to stop alerting on a built-in check.' },
      { id: 'd', label: 'You want to rename an existing incident type.' }
    ]
  },
  {
    id: 'q-threshold',
    prompt: 'A custom-metric threshold carries:',
    options: [
      { id: 'a', label: 'A severity, a comparison, and a timeline.', correct: true },
      { id: 'b', label: 'Only a severity.' },
      { id: 'c', label: 'A list of users to wake up.' },
      { id: 'd', label: 'The script source code that produced the value.' }
    ]
  },
  {
    id: 'q-incidents',
    prompt: 'When a custom metric breaches its threshold:',
    options: [
      { id: 'a', label: 'Nothing happens until you log into the metric page.' },
      { id: 'b', label: 'A separate notification channel is required.' },
      { id: 'c', label: 'It flows into the same incident pipeline as built-in alerts.', correct: true },
      { id: 'd', label: 'The metric is deleted automatically.' }
    ]
  }
]);

export const CUSTOM_METRICS_TOUR_CONSTANTS = Object.freeze({
  TOUR_ID: 'custom-metrics-fortimonitor',
  FLAG_KEY: 'fm:customMetricsTourEnabled',
  START_MESSAGE_TYPE: 'fm:custom-metrics-tour:start',
  // Landing page used when no FortiMonitor tab is open: lands operator on
  // a Monitoring-anchored URL so the where-to-find-it step has DOM to
  // attach to. Tenant URL pattern is the same across tenants; the
  // dispatch handler defaults to fortimonitor.forticloud.com.
  LANDING_PATH: '/dashboards'
});
