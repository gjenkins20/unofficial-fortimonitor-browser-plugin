import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FortimonitorClient } from '../src/lib/fortimonitor-client.js';

// =====================================================================
// FMN-279: FortimonitorClient.removeServerParentInstance()
//
// The load-bearing correctness properties (all verified live against the
// tenant, then locked here):
//   - parent_server[] is OMITTED from the editInstance body (that is how the
//     UI clears a parent; sending it empty 500s).
//   - bracket keys are SINGLE-encoded (server_group%5B%5D, never %255B) - the
//     double-encoding bug is exactly what 500'd the first attempts.
//   - attributes use the [-id, typeName, value] shape + new_attribute_keys.
//   - session-auth headers: X-Requested-With, NO X-XSRF-Token.
// =====================================================================

function idpResponse(instanceOverrides = {}) {
  return {
    ok: true, status: 200, url: '',
    headers: new Map([['content-type', 'application/json']]),
    async json() {
      return {
        pageData: {
          instance: {
            id: 44218437, name: 'fgt-ha', fqdn: '10.1.0.11', serverKey: 'rzh9-ednd-ipbf-7fdq',
            description: '', partnerServerId: null, disabledCountermeasures: false,
            prometheusEndpoints: [],
            serverGroups: [{ id: 992782, name: 'fgt-ha-lab' }],
            tags: [{ name: 'fortigate' }, { name: 'fortinet' }],
            nonSystemAttributes: [
              { id: 383392261, value: '443', serverAttributeType: { name: 'Admin Port' } },
              { id: 383392257, value: 'FGTAWSEMEUABSGA3', serverAttributeType: { name: 'Serial' } }
            ],
            ...instanceOverrides
          },
          monitoringConfig: { snmp_credential: '0' }
        }
      };
    },
    async text() { return ''; }
  };
}
function jsonResp(obj) {
  return { ok: true, status: 200, url: '', headers: new Map([['content-type', 'application/json']]),
    async json() { return obj; }, async text() { return JSON.stringify(obj); } };
}
function htmlResp(status = 200) {
  return { ok: status < 300, status, url: '', headers: new Map([['content-type', 'text/html']]),
    async json() { throw new SyntaxError('<'); }, async text() { return '<html>err</html>'; } };
}
function makeClient(routes) {
  let captured = null;
  const fetch = async (url, opts = {}) => {
    if (url.includes('get_idp_data')) return routes.idp ? routes.idp() : idpResponse();
    if (url.includes('editInstance')) { captured = { url, opts }; return routes.edit(); }
    throw new Error('unexpected url ' + url);
  };
  const client = new FortimonitorClient({ fetch, getCookie: async () => null, origin: 'https://fm.example' });
  return { client, getCaptured: () => captured };
}

test('removeServerParentInstance: omits parent_server[] and SINGLE-encodes bracket keys', async () => {
  const { client, getCaptured } = makeClient({ edit: () => jsonResp({ success: true, message: 'changed parent server from X to None' }) });
  const out = await client.removeServerParentInstance(44218437);
  assert.equal(out.success, true);
  const body = getCaptured().opts.body;
  assert.ok(!body.includes('parent_server'), 'parent_server[] must be omitted');
  assert.ok(body.includes('server_group%5B%5D=grp-992782'), 'server_group[] single-encoded');
  assert.ok(!body.includes('%255B'), 'must NOT double-encode brackets');
  assert.ok(body.includes('tags%5B%5D=fortigate') && body.includes('tags%5B%5D=fortinet'));
  const params = new URLSearchParams(body);
  assert.equal(params.get('server_id'), '44218437');
  assert.equal(params.get('name'), 'fgt-ha');
  assert.equal(params.get('snmp_credential'), '0');
  assert.equal(params.get('deleted_attributes'), '[]');
  assert.deepEqual(JSON.parse(params.get('attributes')), [
    [-383392261, 'Admin Port', '443'],
    [-383392257, 'Serial', 'FGTAWSEMEUABSGA3']
  ]);
  assert.deepEqual(JSON.parse(params.get('new_attribute_keys')), [383392261, 383392257]);
});

test('removeServerParentInstance: session-auth headers (X-Requested-With, no XSRF)', async () => {
  const { client, getCaptured } = makeClient({ edit: () => jsonResp({ success: true, message: 'ok' }) });
  await client.removeServerParentInstance(44218437);
  const h = getCaptured().opts.headers;
  assert.equal(h['X-Requested-With'], 'XMLHttpRequest');
  assert.ok(!('X-XSRF-Token' in h) && !('X-XSRF-TOKEN' in h), 'no XSRF header');
  assert.match(h['Content-Type'], /application\/x-www-form-urlencoded/);
});

test('removeServerParentInstance: SPA-shell (non-JSON) editInstance response throws', async () => {
  const { client } = makeClient({ edit: () => htmlResp(500) });
  await assert.rejects(() => client.removeServerParentInstance(44218437), /non-JSON|SPA|failed/i);
});

test('removeServerParentInstance: success:false response throws with the message', async () => {
  const { client } = makeClient({ edit: () => jsonResp({ success: false, message: 'Can not edit' }) });
  await assert.rejects(() => client.removeServerParentInstance(44218437), /Can not edit/);
});

test('removeServerParentInstance: non-JSON get_idp_data (expired session) throws', async () => {
  const { client } = makeClient({ idp: () => htmlResp(200), edit: () => jsonResp({ success: true }) });
  await assert.rejects(() => client.removeServerParentInstance(44218437), /non-JSON|session/i);
});

test('removeServerParentInstance: requires serverId', async () => {
  const { client } = makeClient({ edit: () => jsonResp({ success: true }) });
  await assert.rejects(() => client.removeServerParentInstance(), /required/);
  await assert.rejects(() => client.removeServerParentInstance('  '), /required/);
});
