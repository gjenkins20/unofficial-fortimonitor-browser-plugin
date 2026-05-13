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

test('remove-tag commit translates 404 into "Instance #X not found" copy', async () => {
  await assert.rejects(
    removeTag.commit({ id: 12345 }, { tag: 'foo' }, { client: makeNotFoundClient() }),
    (err) => {
      assert.match(err.message, /Instance #12345 not found/);
      return true;
    }
  );
});

test('add-tag commit translates 404 into "Instance #X not found" copy', async () => {
  await assert.rejects(
    addTag.commit({ id: 99999 }, { tag: 'foo' }, { client: makeNotFoundClient() }),
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
    removeTag.commit({ id: 1 }, { tag: 'foo' }, { client }),
    (err) => {
      assert.match(err.message, /HTTP 400/);
      assert.doesNotMatch(err.message, /not found/);
      return true;
    }
  );
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
