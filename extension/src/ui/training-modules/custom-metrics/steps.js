// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-244: Custom Metrics training module - tour content + quiz.
//
// Reuses the FMN-167 tour engine (steps + captions + anchors) so the
// in-page runtime experience matches Introduction to FortiMonitor.
//
// Content shape (FMN-244 QA rewrite, 2026-05-26): the conceptual intro runs
// through the management-UI overview, then the tour PIVOTS TO HANDS-ON against
// the real Custom Metrics page. Every page fact below was captured live from
// fortimonitor.forticloud.com/config/ListCustomMetrics (tools/qa/fmn-244-
// capture-custom-metrics.mjs), not from docs - the earlier draft's authoring
// dialog and threshold framing were fabricated and are corrected here.
//
// Verified live UI facts:
//   - Location: sidebar Monitoring > Advanced Metrics; page title "Custom
//     Metrics"; URL /config/ListCustomMetrics. Sub-tabs: Custom Metrics /
//     Custom Perfmon Metrics.
//   - List columns: Plugin Textkey, Metric Textkey, Category, Name, Units,
//     Boolean Values. Per-row kebab menu. "Add Custom Metric" button.
//   - Add Custom Metric -> "Metric Configuration" dialog has exactly six
//     required fields: Plugin Textkey, Metric Textkey, Category, Name,
//     Metric Type (Number / Boolean / Percent), Units, plus Save. NO
//     threshold or frequency fields - those are NOT set on this surface.
//   - Thresholds/frequency for a custom metric are configured per-instance
//     (monitoring config) or via Monitoring Policies once the metric is
//     attached, exactly like any built-in metric (alert_items model,
//     FMN-135).
//
// Anchor strategy: sidebar steps anchor by text ("Advanced Metrics", present
// on every page); the dialog step anchors the "Add Custom Metric" button with
// a body fallback; conceptual cards use anchor:'body'. The dispatch landing
// page is /config/ListCustomMetrics so a fresh tour resolves these anchors.

export const CUSTOM_METRICS_TOUR_STEPS = [
  {
    id: 'welcome',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p><strong>Custom Metrics in FortiMonitor.</strong> This walkthrough ',
      'covers what a custom metric is, when to reach for one, where the ',
      'management UI lives, and how to author one on the real Custom Metrics ',
      'page. A short 3-question check follows at the end.</p>',
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
    anchorByText: 'Advanced Metrics',
    anchor_fallback: 'body',
    caption_html: [
      '<p>Custom metrics live under <strong>Monitoring &rsaquo; Advanced ',
      'Metrics</strong> in the sidebar (URL <code>/config/ListCustomMetrics</code>). ',
      'The page is titled <strong>Custom Metrics</strong> and has two tabs: ',
      '<em>Custom Metrics</em> and <em>Custom Perfmon Metrics</em>.</p>',
      '<p>Click <strong>Advanced Metrics</strong> if you want to follow ',
      'along on the real page as we go.</p>'
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
      '<p>The <strong>Custom Metrics</strong> list shows every custom metric ',
      'type defined on this tenant. Each row carries the <strong>Plugin ',
      'Textkey</strong>, <strong>Metric Textkey</strong>, <strong>Category', '</strong>, ',
      '<strong>Name</strong>, <strong>Units</strong>, and <strong>Boolean ',
      'Values</strong>; the per-row menu lets you edit or remove a metric ',
      'type.</p>',
      '<p>The <strong>Add Custom Metric</strong> button opens the authoring ',
      'dialog. That is where the hands-on part begins.</p>'
    ].join(''),
    when: { always: true },
    advance: 'next-button',
    placement: 'auto'
  },
  {
    id: 'authoring-dialog',
    anchorByText: 'Add Custom Metric',
    anchor_fallback: 'body',
    caption_html: [
      '<p>Clicking <strong>Add Custom Metric</strong> opens the ',
      '<strong>Metric Configuration</strong> dialog. It has six required ',
      'fields:</p>',
      '<ol>',
      '<li><strong>Plugin Textkey</strong> and <strong>Metric Textkey</strong>: ',
      'the textkey pair that identifies this metric to the plugin that ',
      'reports it.</li>',
      '<li><strong>Category</strong>: the grouping the metric appears under. ',
      'Note: changing it updates the category for every metric that uses the ',
      'same plugin.</li>',
      '<li><strong>Name</strong>: the human-readable label shown in lists, ',
      'graphs, and incident captions.</li>',
      '<li><strong>Metric Type</strong>: <em>Number</em>, <em>Boolean</em>, ',
      'or <em>Percent</em> - how FortiMonitor stores and renders the value.</li>',
      '<li><strong>Units</strong>: the unit string (e.g. "ms", "count", "%") ',
      'shown on graphs and dashboard cards.</li>',
      '</ol>',
      '<p><strong>Save</strong> writes the metric type. This dialog defines ',
      'the metric only - it carries no threshold or schedule fields.</p>'
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
      '<p>The Custom Metrics page <strong>defines the metric type</strong>. ',
      'How often it is evaluated (<strong>frequency</strong>) and what ',
      '<strong>thresholds</strong> alert on it are configured separately, ',
      'once the metric is attached to an instance - on that instance\'s ',
      'monitoring configuration, or through a <strong>Monitoring Policy</strong>. ',
      'This is the same path every built-in metric uses.</p>',
      '<p>An alerting threshold carries a <strong>severity</strong> ',
      '(warning, critical), a <strong>comparison</strong> (greater-than, ',
      'less-than, equals, range), and a <strong>timeline</strong> (how long ',
      'the condition must hold before a state change fires). Multiple ',
      'thresholds on the same metric give you a graduated response.</p>'
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
      '<p>When a custom metric crosses a threshold, it flows into the same ',
      '<strong>incident pipeline</strong> as every other FortiMonitor ',
      'alert. The incident inherits the metric name, the triggering value, ',
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
    id: 'example-callout',
    anchor: 'body',
    anchor_fallback: 'body',
    caption_html: [
      '<p><strong>Try it yourself.</strong> The toolkit ships a complete, ',
      'reproducible example you can stand up end to end: a custom metric that ',
      'reports the number of active SSH sessions on an OnSight appliance, using ',
      "only FortiMonitor's built-in script-execution data source (no third-party ",
      'tooling).</p>',
      '<p>In your cloned toolkit repository, open ',
      '<code>docs/training/custom-metrics/</code>. It carries a field-by-field ',
      'configuration walkthrough, the data-source script, and a checklist for ',
      'watching the metric cross a warning threshold and open an incident.</p>'
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
      '<p>You now know what a custom metric is, when to author one, where ',
      'the Custom Metrics page lives (Monitoring &rsaquo; Advanced Metrics), ',
      'the six fields in the authoring dialog, and how thresholds turn a ',
      'custom metric into an incident.</p>',
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
    id: 'q-dialog-fields',
    prompt: 'The Add Custom Metric dialog (Metric Configuration) is where you set:',
    options: [
      { id: 'a', label: 'The alert thresholds and evaluation frequency.' },
      { id: 'b', label: 'Plugin/Metric Textkey, Category, Name, Metric Type, and Units - the metric definition.', correct: true },
      { id: 'c', label: 'The on-call rotation and notification schedule.' },
      { id: 'd', label: 'The instances the metric is attached to.' }
    ]
  },
  {
    id: 'q-thresholds-location',
    prompt: 'Thresholds and evaluation frequency for a custom metric are configured:',
    options: [
      { id: 'a', label: 'In the Add Custom Metric dialog, alongside the name and units.' },
      { id: 'b', label: 'Nowhere - custom metrics cannot alert.' },
      { id: 'c', label: 'Per-instance on the monitoring configuration, or via a Monitoring Policy, after the metric is attached.', correct: true },
      { id: 'd', label: 'Automatically, with no way to change them.' }
    ]
  }
]);

export const CUSTOM_METRICS_TOUR_CONSTANTS = Object.freeze({
  TOUR_ID: 'custom-metrics-fortimonitor',
  FLAG_KEY: 'fm:customMetricsTourEnabled',
  START_MESSAGE_TYPE: 'fm:custom-metrics-tour:start',
  // Hands-on landing page (FMN-244 QA rewrite): land the operator directly on
  // the real Custom Metrics list so the "Advanced Metrics" and "Add Custom
  // Metric" anchors resolve and the dialog walkthrough has live context.
  LANDING_PATH: '/config/ListCustomMetrics'
});
