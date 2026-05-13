import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as removeTag from '../src/lib/bulk-actions/remove-tag.js';
import * as addTag from '../src/lib/bulk-actions/add-tag.js';

// FMN-206: bogus server IDs (typos, deleted instances) raise a
// PanoptaError with status=404 from the preflight GET inside
// removeServerTag/addServerTag. The action's commit() wrapper
// re-throws with operator-friendly copy so the preview's detail row
// reads cleanly.

function makeNotFoundClient() {
  return {
    async addServerTag() {
      const err = new Error('GET /server/12345 failed: HTTP 404');
      err.status = 404;
      throw err;
    },
    async removeServerTag() {
      const err = new Error('GET /server/12345 failed: HTTP 404');
      err.status = 404;
      throw err;
    }
  };
}

test('remove-tag commit translates 404 into "Instance #X not found" copy when chip-fetch had tags', async () => {
  // target.tags must be present (non-null) so the FMN-207 short-circuit
  // doesn't fire; this test exercises the client-side 404 wrap.
  await assert.rejects(
    removeTag.commit({ id: 12345, tags: ['some-tag'] }, { tag: 'some-tag' }, { client: makeNotFoundClient() }),
    (err) => {
      assert.match(err.message, /Instance #12345 not found/);
      return true;
    }
  );
});

test('add-tag commit translates 404 into "Instance #X not found" copy when chip-fetch had tags', async () => {
  await assert.rejects(
    addTag.commit({ id: 99999, tags: ['existing'] }, { tag: 'new' }, { client: makeNotFoundClient() }),
    (err) => {
      assert.match(err.message, /Instance #99999 not found/);
      return true;
    }
  );
});

test('remove-tag commit passes non-404 errors through unchanged', async () => {
  const client = {
    async removeServerTag() {
      const err = new Error('PUT /server/X failed: HTTP 400');
      err.status = 400;
      throw err;
    }
  };
  await assert.rejects(
    removeTag.commit({ id: 1, tags: ['foo'] }, { tag: 'foo' }, { client }),
    (err) => {
      assert.match(err.message, /HTTP 400/);
      assert.doesNotMatch(err.message, /not found/);
      return true;
    }
  );
});

// ----- FMN-207: skip short-circuit when chip-fetch found nothing ------

test('remove-tag commit short-circuits (no client call) when target.tags is null', async () => {
  let clientCalled = false;
  const client = {
    async removeServerTag() {
      clientCalled = true;
      throw new Error('should not reach here');
    }
  };
  const out = await removeTag.commit({ id: 12345, tags: null }, { tag: 'foo' }, { client });
  assert.strictEqual(clientCalled, false);
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.noop, true);
});

test('remove-tag commit short-circuits when target.tags is undefined (legacy targets without the field)', async () => {
  let clientCalled = false;
  const client = {
    async removeServerTag() { clientCalled = true; }
  };
  const out = await removeTag.commit({ id: 1 }, { tag: 'foo' }, { client });
  assert.strictEqual(clientCalled, false);
  assert.strictEqual(out.skipped, true);
});

test('add-tag commit short-circuits when target.tags is null', async () => {
  let clientCalled = false;
  const client = {
    async addServerTag() { clientCalled = true; throw new Error('boom'); }
  };
  const out = await addTag.commit({ id: 12345, tags: null }, { tag: 'foo' }, { client });
  assert.strictEqual(clientCalled, false);
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.noop, true);
});

// ----- FMN-207: describe() returns skip:true for the skip cases -------

test('remove-tag describe returns skip:true for null tags (instance not found)', () => {
  const d = removeTag.describe({ id: 12345, tags: null }, { tag: 'foo' });
  assert.strictEqual(d.skip, true);
  assert.strictEqual(d.willChange, false);
  assert.strictEqual(d.prev, '(not found)');
  assert.strictEqual(d.next, '(not found)');
  assert.match(d.note, /Instance not found/);
});

test('remove-tag describe returns skip:true when tag is not present', () => {
  const d = removeTag.describe({ id: 1, tags: ['other'] }, { tag: 'foo' });
  assert.strictEqual(d.skip, true);
  assert.strictEqual(d.willChange, false);
  assert.match(d.note, /will skip/);
});

test('remove-tag describe returns willChange:true when tag is present', () => {
  const d = removeTag.describe({ id: 1, tags: ['foo', 'bar'] }, { tag: 'foo' });
  assert.strictEqual(d.willChange, true);
  assert.notStrictEqual(d.skip, true);
});

test('add-tag describe returns skip:true for null tags', () => {
  const d = addTag.describe({ id: 12345, tags: null }, { tag: 'foo' });
  assert.strictEqual(d.skip, true);
  assert.strictEqual(d.willChange, false);
  assert.strictEqual(d.prev, '(not found)');
});

test('add-tag describe returns skip:true when tag already present', () => {
  const d = addTag.describe({ id: 1, tags: ['foo', 'bar'] }, { tag: 'foo' });
  assert.strictEqual(d.skip, true);
  assert.strictEqual(d.willChange, false);
  assert.match(d.note, /will skip/);
});

test('remove-tag commit returns noop result when the tag was absent', async () => {
  const client = {
    async removeServerTag(serverId, tags) {
      return {
        status: 200,
        removedTags: [],
        tagsAfter: ['a', 'b']
      };
    }
  };
  const out = await removeTag.commit({ id: 1 }, { tag: 'doomed' }, { client });
  assert.strictEqual(out.noop, true);
  assert.deepEqual(out.removedTags, []);
});

test('add-tag commit returns noop when the tag was already present', async () => {
  const client = {
    async addServerTag() {
      return { status: 200, addedTags: [], tagsAfter: ['existing'] };
    }
  };
  const out = await addTag.commit({ id: 1 }, { tag: 'existing' }, { client });
  assert.strictEqual(out.noop, true);
});
