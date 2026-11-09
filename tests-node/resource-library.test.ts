import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { filterResources, resourceFolderDescendants, resourceFolderTree, resourceSiteCounts } from '../shared/resource-library.js';
import { ResourceFolders } from '../server/automation/resource-folders.js';
import { Database } from '../server/runtime.js';

const resourceInput = { name: 'Example', scenario: 'materials', description: 'Product material', contentUrl: '', referenceUrl: '', externalSource: '', externalId: '', files: [] };

test('resource folder APIs persist groups, preserve input versions, move atomically and ungroup on deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'resource-library-'));
  let services = await createApp({ directory, serveWeb: false, startWorker: false });
  try {
    const login = await services.app.inject({ method: 'POST', url: '/api/login' });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const create = await services.app.inject({ method: 'POST', url: '/api/automation/resource-folders', headers, payload: { name: ' Customers ' } });
    assert.equal(create.statusCode, 201);
    const folder = create.json();
    assert.equal(folder.name, 'Customers');
    assert.equal((await services.app.inject({ method: 'POST', url: '/api/automation/resource-folders', headers, payload: { name: 'customers' } })).statusCode, 409);
    assert.equal((await services.app.inject({ method: 'POST', url: '/api/automation/resource-folders', headers, payload: { name: ' ' } })).statusCode, 400);
    assert.equal((await services.app.inject({ method: 'POST', url: '/api/automation/resource-folders', payload: { name: 'Unauthorized' } })).statusCode, 401);
    const firstResponse = await services.app.inject({ method: 'POST', url: '/api/automation/resources', headers, payload: { ...resourceInput, folderId: folder.id } });
    assert.equal(firstResponse.statusCode, 201);
    const first = firstResponse.json();
    assert.equal(first.folderId, folder.id);
    const second = (await services.app.inject({ method: 'POST', url: '/api/automation/resources', headers, payload: resourceInput })).json();
    assert.equal(second.folderId, null);
    const frozen = services.automationStore.versions(first.id);
    assert.equal('folderId' in frozen[0], false);
    const invalidCreate = await services.app.inject({ method: 'POST', url: '/api/automation/resources', headers, payload: { ...resourceInput, folderId: randomUUID() } });
    assert.equal(invalidCreate.statusCode, 409);
    assert.equal(services.automationStore.resources().length, 2);
    const other = (await services.app.inject({ method: 'POST', url: '/api/automation/resource-folders', headers, payload: { name: 'Archive' } })).json();
    const move = (resourceIds: string[], folderId: string | null) => services.app.inject({ method: 'POST', url: '/api/automation/resources/move', headers, payload: { resourceIds, folderId } });
    assert.equal((await move([first.id, randomUUID()], other.id)).statusCode, 409);
    assert.equal(services.automationStore.resource(first.id)?.folderId, folder.id);
    assert.equal((await move([first.id], randomUUID())).statusCode, 409);
    assert.equal((await move([first.id, second.id], other.id)).statusCode, 200);
    assert.equal(services.automationStore.resource(first.id)?.revision, first.revision);
    assert.equal(services.automationStore.resource(first.id)?.updatedAt, first.updatedAt);
    assert.deepEqual(services.automationStore.versions(first.id), frozen);
    assert.equal((await services.app.inject({ method: 'PUT', url: `/api/automation/resource-folders/${other.id}`, headers, payload: { name: 'Customers' } })).statusCode, 409);
    assert.equal((await services.app.inject({ method: 'PUT', url: `/api/automation/resource-folders/${other.id}`, headers, payload: { name: 'Completed' } })).json().name, 'Completed');
    const updated = await services.app.inject({ method: 'PUT', url: `/api/automation/resources/${first.id}`, headers, payload: { ...resourceInput, description: 'New input', revision: 1 } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().folderId, other.id);
    const overview = (await services.app.inject({ url: '/api/automation/overview?view=compact', headers })).json();
    assert.equal(overview.resourceFolders.length, 2);
    assert.equal(overview.resources.find((item: { id: string }) => item.id === second.id).folderId, other.id);
    // Reopen the same database to prove assignments survive a service restart.
    await services.app.close();
    services = await createApp({ directory, serveWeb: false, startWorker: false });
    assert.equal(services.automationStore.resourceFolders.list().find(item => item.id === other.id)?.name, 'Completed');
    assert.equal(services.automationStore.resource(second.id)?.folderId, other.id);
    const relogin = await services.app.inject({ method: 'POST', url: '/api/login' });
    const newHeaders = { cookie: String(relogin.headers['set-cookie']).split(';')[0] };
    const deleted = await services.app.inject({ method: 'DELETE', url: `/api/automation/resource-folders/${other.id}`, headers: newHeaders });
    assert.equal(deleted.statusCode, 200);
    assert.equal(services.automationStore.resource(first.id)?.folderId, null);
    assert.equal(services.automationStore.resource(second.id)?.folderId, null);
    assert.equal(services.automationStore.resource(first.id)?.revision, 2);
    assert.equal(services.automationStore.resource(second.id)?.revision, 1);
    assert.equal(services.automationStore.resources().length, 2);
  } finally { await services.app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('resource filters combine folder, scenario, generated-site presence and search before pagination', () => {
  const resources = [
    { ...resourceInput, id: 'legacy' },
    { ...resourceInput, id: 'a', folderId: 'customers', name: 'Customer A' },
    { ...resourceInput, id: 'b', folderId: 'customers', name: 'Customer B', scenario: 'migration' },
    { ...resourceInput, id: 'c', folderId: 'archive', externalId: 'Customer C' },
  ];
  const counts = resourceSiteCounts([{ resourceId: 'a' }, { resourceId: 'a' }, { resourceId: 'c' }]);
  const filters = { query: '', scenario: '', folder: '', generated: '' };
  const ids = (values: Partial<typeof filters>) => filterResources(resources, counts, { ...filters, ...values }).map(item => item.id);
  assert.equal(counts.get('a'), 2);
  assert.deepEqual(ids({ generated: 'yes' }), ['a', 'c']);
  assert.deepEqual(ids({ generated: 'no' }), ['legacy', 'b']);
  assert.deepEqual(ids({ folder: 'ungrouped' }), ['legacy']);
  assert.deepEqual(ids({ folder: 'customers', generated: 'no', scenario: 'migration', query: ' CUSTOMER ' }), ['b']);
  assert.deepEqual(ids({ folder: 'customers', generated: 'yes', scenario: 'migration' }), []);
  assert.deepEqual(ids({ query: 'Customer C' }), ['c']);
  const many = Array.from({ length: 45 }, (_, index) => ({ ...resources[0], id: `item-${index}`, folderId: index < 21 ? 'customers' : 'archive' }));
  const filtered = filterResources(many, new Map(), { ...filters, folder: 'customers', generated: 'no' });
  assert.equal(filtered.length, 21);
  assert.equal(Math.ceil(filtered.length / 20), 2);
  assert.deepEqual(filtered.slice(20, 40).map(item => item.id), ['item-20']);
});

test('flat-folder databases upgrade without losing assignments and keep nested parents after reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'resource-folder-upgrade-'));
  let db = new Database(join(directory, 'folders.db'));
  try {
    const rootId = randomUUID(), resourceId = randomUUID();
    db.exec('CREATE TABLE auto_resource_folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE auto_resource_folder_members(resource_id TEXT PRIMARY KEY,folder_id TEXT NOT NULL)');
    db.prepare('INSERT INTO auto_resource_folders VALUES(?,?,?)').run(rootId, 'Existing', 123);
    db.prepare('INSERT INTO auto_resource_folder_members VALUES(?,?)').run(resourceId, rootId);
    const folders = new ResourceFolders(db);
    assert.deepEqual(folders.list().map(item => ({ ...item })), [{ id: rootId, name: 'Existing', parentId: null, createdAt: 123 }]);
    assert.equal(folders.folderId(resourceId), rootId);
    const child = folders.save('Child', undefined, rootId);
    const grandchild = folders.save('Leaf', undefined, child.id);
    db.close();
    db = new Database(join(directory, 'folders.db'));
    const reopened = new ResourceFolders(db);
    assert.equal(reopened.list().find(item => item.id === grandchild.id)?.parentId, child.id);
    assert.equal(reopened.list().find(item => item.id === child.id)?.parentId, rootId);
    assert.equal(reopened.folderId(resourceId), rootId);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('nested folder APIs reject cycles and sibling duplicates, reparent branches and safely delete subtrees', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nested-resource-library-'));
  const services = await createApp({ directory, serveWeb: false, startWorker: false });
  try {
    const login = await services.app.inject({ method: 'POST', url: '/api/login' });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const create = (name: string, parentId?: string) => services.app.inject({ method: 'POST', url: '/api/automation/resource-folders', headers, payload: { name, parentId } });
    const root = (await create('Root')).json(), other = (await create('Other')).json();
    const childResponse = await create('Branch', root.id);
    assert.equal(childResponse.statusCode, 201);
    const child = childResponse.json(), leaf = (await create('Leaf', child.id)).json();
    assert.equal(child.parentId, root.id);
    assert.equal((await create('branch', root.id)).statusCode, 409);
    assert.equal((await create('Branch', other.id)).statusCode, 201);
    assert.equal((await create('Missing', randomUUID())).statusCode, 409);
    for (const parentId of [root.id, child.id, leaf.id]) {
      assert.equal((await services.app.inject({ method: 'PUT', url: `/api/automation/resource-folders/${root.id}`, headers, payload: { name: 'Root', parentId } })).statusCode, 409);
    }
    const moved = await services.app.inject({ method: 'PUT', url: `/api/automation/resource-folders/${child.id}`, headers, payload: { name: 'Moved branch', parentId: other.id } });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().parentId, other.id);
    const renamed = await services.app.inject({ method: 'PUT', url: `/api/automation/resource-folders/${child.id}`, headers, payload: { name: 'Renamed branch' } });
    assert.equal(renamed.json().parentId, other.id);
    const resource = (await services.app.inject({ method: 'POST', url: '/api/automation/resources', headers, payload: { ...resourceInput, folderId: leaf.id } })).json();
    const versions = services.automationStore.versions(resource.id);
    assert.equal((await services.app.inject({ method: 'DELETE', url: `/api/automation/resource-folders/${child.id}`, headers })).statusCode, 200);
    const remaining = services.automationStore.resourceFolders.list();
    assert.equal(remaining.some(item => item.id === child.id || item.id === leaf.id), false);
    assert.equal(remaining.some(item => item.id === root.id), true);
    assert.equal(remaining.some(item => item.id === other.id), true);
    assert.equal(services.automationStore.resource(resource.id)?.folderId, null);
    assert.deepEqual(services.automationStore.versions(resource.id), versions);
  } finally { await services.app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('folder trees retain paths and ancestor order, and parent filters include all descendants', () => {
  const folders = [
    { id: 'leaf', name: 'Leaf', parentId: 'branch', createdAt: 3 },
    { id: 'root', name: 'Root', parentId: null, createdAt: 1 },
    { id: 'other', name: 'Other', createdAt: 4 },
    { id: 'branch', name: 'Branch', parentId: 'root', createdAt: 2 },
  ];
  const tree = resourceFolderTree(folders);
  assert.deepEqual(tree.map(item => item.id), ['root', 'branch', 'leaf', 'other']);
  assert.deepEqual(tree[2].ancestors, ['root', 'branch']);
  assert.equal(tree[2].path, 'Root / Branch / Leaf');
  assert.equal(tree[2].depth, 2);
  assert.equal(tree[1].hasChildren, true);
  assert.equal(tree[2].hasChildren, false);
  assert.deepEqual([...resourceFolderDescendants(folders, 'branch')].sort(), ['branch', 'leaf']);
  const resources = folders.map(item => ({ ...resourceInput, id: item.id, folderId: item.id }));
  const counts = resourceSiteCounts([{ resourceId: 'leaf' }]);
  const filters = { query: '', scenario: '', folder: 'root', generated: '' };
  assert.deepEqual(filterResources(resources, counts, filters, folders).map(item => item.id), ['leaf', 'root', 'branch']);
  assert.deepEqual(filterResources(resources, counts, { ...filters, generated: 'yes' }, folders).map(item => item.id), ['leaf']);
  const collapsed = new Set(['branch']);
  assert.deepEqual(tree.filter(item => !item.ancestors.some(id => collapsed.has(id))).map(item => item.id), ['root', 'branch', 'other']);
});
