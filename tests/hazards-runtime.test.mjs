import test from 'node:test';
import assert from 'node:assert/strict';
import {trackHazardToken, refreshHazards, openHazards, registerHazards} from '../scripts/hazards.mjs';
import {openAssistants} from '../scripts/assistants.mjs';
import {resolveFoul} from '../scripts/hazard-model.mjs';

const ID = 'pf2e-bob-companion';
const drain = async () => { await new Promise(resolve => setImmediate(resolve)); };

/** Stubs only Foundry's document/settings/UI boundary; all domain and store code is real. */
function fixture(hazards = {}) {
  let state = {hazards: structuredClone(hazards)}, writes = 0;
  const hooks = new Map(), documents = new Map(), messages = [], errors = [], dialogs = [];
  const config = {enabled: true, stormEnded: false};
  const gm = {id: 'gm', isGM: true, active: true};
  const users = Object.assign([gm, {id: 'player', isGM: false, active: true}], {activeGM: gm});
  const actors = new Map(), scenes = new Map();
  actors.party = {members: []};
  class Dialog {
    constructor(options) { this.options = options; this.rendered = true; dialogs.push(this); }
    static wait(options) { const dialog = new this(options); return new Promise(resolve => {dialog.resolve = resolve;}); }
    bringToFront() {}
    render() { return this; }
    async close() { this.rendered = false; this.resolve?.(null); }
  }
  globalThis.foundry = {applications: {api: {DialogV2: Dialog}}};
  globalThis.game = {user: gm, users, actors, scenes, time: {worldTime: 0},
    modules: new Map([[ID, {api: {}}]]), settings: {
      get(_module, key) { return key === 'config' ? config : structuredClone(state); },
      async set(_module, _key, value) { state = structuredClone(value); writes++; return value; }
    }};
  globalThis.canvas = {scene: null};
  globalThis.Hooks = {
    on(name, fn) { const listeners = hooks.get(name) ?? []; listeners.push(fn); hooks.set(name, listeners); },
    once(name, fn) { this.on(name, fn); }, callAll() {}
  };
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  globalThis.fromUuidSync = uuid => documents.get(uuid) ?? null;
  globalThis.ChatMessage = {async create(data) {messages.push(data); return data;}};
  globalThis.ui = {notifications: {error(message) {errors.push(message);}}};
  function scene(id) {
    const value = {id, uuid: `Scene.${id}`, name: id, tokens: [], regions: []};
    value.regions.get = regionId => value.regions.find(region => region.id === regionId);
    value.regions.has = regionId => value.regions.some(region => region.id === regionId);
    scenes.set(id, value); documents.set(value.uuid, value); return value;
  }
  const a = scene('a'), b = scene('b'); scenes.active = a; canvas.scene = a;
  function region(scene, id) {
    const value = {id, uuid: `${scene.uuid}.Region.${id}`, name: id, parent: scene, documentName: 'Region'};
    scene.regions.push(value); documents.set(value.uuid, value); return value;
  }
  const tower = region(a, 'tower'), foul = region(a, 'foul');
  function token(id, scene = a, regions = []) {
    const actor = {id, uuid: `Actor.${id}`, name: id, type: 'character', hasPlayerOwner: true};
    actors.set(id, actor); actors.party.members.push(actor); documents.set(actor.uuid, actor);
    const value = {id, uuid: `${scene.uuid}.Token.${id}`, actorId: id, actorLink: true, parent: scene, regions: new Set(regions)};
    const actualRegions = new Set(regions);
    value.testInsideRegion = region => actualRegions.has(region);
    value.actualRegions = actualRegions;
    scene.tokens.push(value); documents.set(value.uuid, value); return value;
  }
  function activate(scene) { scenes.active = scene; canvas.scene = scene; }
  async function emit(name, ...args) { for (const fn of hooks.get(name) ?? []) fn(...args); await drain(); }
  registerHazards();
  return {a, b, tower, foul, token, activate, emit, config, messages, errors, dialogs,
    get state() {return state.hazards;}, get writes() {return writes;},
    mutate(fn) { fn(state.hazards); }, time(value) {game.time.worldTime = value;},
    deleteRegion(region) {documents.delete(region.uuid);region.parent.regions.splice(region.parent.regions.indexOf(region),1);},
    async closeDialogs() {for (const dialog of dialogs) await dialog.close(); await drain();}
  };
}

test('unconfigured scene refreshes do not create a hazard ledger or write world settings', async () => {
  const f = fixture(); f.token('pc');
  await refreshHazards();
  await f.emit('canvasReady');
  assert.equal(f.writes, 0);
  assert.deepEqual(f.state, {});
  assert.equal(f.messages.length, 0);
});

test('moving outside all marked regions has no state write even when a different region is configured', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc');
  await trackHazardToken(pc);
  await f.emit('updateToken', pc, {x: 100});
  assert.equal(f.writes, 0);
  assert.equal(f.state.tokens, undefined);
});

test('ordinary movement and clock ticks inside the same tower region do not persist elapsed seconds', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc', f.a, [f.tower]);
  await trackHazardToken(pc);
  const writes = f.writes;
  for (const time of [1, 30, 100, 599]) {
    f.time(time); await f.emit('updateToken', pc, {x: time}); await f.emit('updateWorldTime', time);
  }
  assert.equal(f.writes, writes);
  assert.equal(f.messages.length, 0);
  f.time(600); await f.emit('updateWorldTime', 600);
  assert.equal(f.state.requests.lightning.count, 1);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0].whisper, ['gm']);
  const dueWrites = f.writes;
  await f.emit('updateWorldTime', 600);
  assert.equal(f.writes, dueWrites);
});

test('native Region membership generates one air request and unrelated token fields do not write', async () => {
  const f = fixture({bindings: {'Scene.a.Region.foul': 'foul'}});
  const pc = f.token('pc', f.a, [f.foul]);
  await f.emit('updateToken', pc, {_regions: ['foul']});
  assert.equal(f.state.requests['foul:Actor.pc'].kind, 'foul');
  assert.equal(f.messages.length, 1);
  const writes = f.writes;
  await f.emit('updateToken', pc, {name: 'Renamed token'});
  await f.emit('updateToken', pc, {rotation: 90});
  assert.equal(f.writes, writes);
});

test('leaving and re-entering foul air is a new exposure even when world time has not advanced', async () => {
  const f = fixture({bindings: {'Scene.a.Region.foul': 'foul'}});
  const pc = f.token('pc', f.a, [f.foul]);
  await trackHazardToken(pc);
  f.mutate(s => {resolveFoul(s, 'Actor.pc', false);});
  pc.regions.clear(); await f.emit('updateToken', pc, {_regions: []});
  pc.regions.add(f.foul); await f.emit('updateToken', pc, {_regions: ['foul']});
  assert.equal(f.state.requests['foul:Actor.pc']?.kind, 'foul');
  assert.equal(f.messages.length, 2);
});

test('active scene changes pause previous scene exposure and returning resumes accumulated time', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc', f.a, [f.tower]);
  await trackHazardToken(pc);
  f.time(300); f.activate(f.b); await f.emit('updateScene', f.b, {active: true});
  assert.equal(f.state.lightning.started, null);
  assert.equal(f.state.lightning.elapsed, 300);
  assert.deepEqual(f.state.tokens, {});
  f.time(900); await f.emit('updateWorldTime', 900);
  assert.equal(f.state.requests.lightning, undefined);
  await f.emit('updateToken', pc, {x: 100});
  assert.deepEqual(f.state.tokens, {});
  f.time(1000); f.activate(f.a); await f.emit('updateScene', f.a, {active: true});
  f.time(1300); await f.emit('updateWorldTime', 1300);
  assert.equal(f.state.requests.lightning.count, 1);
});

test('GM viewing an inactive scene does not detach tokens in the actual active scene', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc', f.a, [f.tower]);
  await trackHazardToken(pc);
  const writes = f.writes;
  canvas.scene = f.b;
  await f.emit('canvasReady');
  assert.equal(f.writes, writes);
  assert.equal(f.state.tokens[pc.uuid].sceneId, 'a');
});

test('editing a bound Region uses native current geometry rather than the not-yet-refreshed token.regions cache', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc', f.a, [f.tower]);
  await trackHazardToken(pc);
  f.time(300);
  // Foundry updates Region boundaries first; its later membership update uses noHook:true.
  pc.actualRegions.clear();
  assert.equal(pc.regions.has(f.tower), true);
  await f.emit('updateRegion', f.tower, {shapes: [{type: 'rectangle', x: 1000}]});
  assert.equal(f.state.tokens[pc.uuid], undefined);
  assert.equal(f.state.lightning.started, null);
  assert.equal(f.state.lightning.elapsed, 300);
  f.time(900); await f.emit('updateWorldTime', 900);
  assert.equal(f.state.requests.lightning, undefined);
  pc.actualRegions.add(f.tower); pc.regions.clear();
  f.time(1000); await f.emit('updateRegion', f.tower, {shapes: [{type: 'rectangle', x: 0}]});
  assert.equal(f.state.tokens[pc.uuid].inTower, true);
});

test('deleting the final bound Region stops exposure even before native token membership catches up', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc', f.a, [f.tower]);
  await trackHazardToken(pc);
  f.time(300); f.deleteRegion(f.tower); pc.actualRegions.clear();
  assert.equal(pc.regions.has(f.tower), true);
  await f.emit('deleteRegion', f.tower);
  assert.equal(f.state.bindings[f.tower.uuid], undefined);
  assert.equal(f.state.tokens[pc.uuid], undefined);
  assert.equal(f.state.lightning.started, null);
  assert.equal(f.state.lightning.elapsed, 300);
  f.time(900); await f.emit('updateWorldTime', 900);
  assert.equal(f.state.requests.lightning, undefined);
});

test('disable pauses tower time and suppresses movement/tick writes until actual re-enable', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc', f.a, [f.tower]);
  await trackHazardToken(pc);
  f.time(300); f.config.enabled = false; await f.emit('updateSetting', {key: `${ID}.config`});
  assert.equal(f.state.lightning.elapsed, 300);
  assert.equal(f.state.lightning.started, null);
  const pausedWrites = f.writes;
  f.time(3000); await f.emit('updateWorldTime', 3000); await f.emit('updateToken', pc, {x: 1});
  assert.equal(f.writes, pausedWrites);
  f.config.enabled = true; await f.emit('updateSetting', {key: `${ID}.config`});
  f.time(3300); await f.emit('updateWorldTime', 3300);
  assert.equal(f.state.requests.lightning.count, 1);
});

test('a token leaving while disabled is reconciled on re-enable without counting the disabled interval', async () => {
  const f = fixture({bindings: {'Scene.a.Region.tower': 'tower'}});
  const pc = f.token('pc', f.a, [f.tower]);
  await trackHazardToken(pc);
  f.time(300); f.config.enabled = false; await f.emit('updateSetting', {key: `${ID}.config`});
  pc.regions.clear(); f.time(3000); await f.emit('updateToken', pc, {_regions: []});
  f.config.enabled = true; await f.emit('updateSetting', {key: `${ID}.config`});
  assert.equal(f.state.lightning.elapsed, 300);
  assert.equal(f.state.lightning.started, null);
  assert.equal(f.state.requests.lightning, undefined);
});

test('air exposure is requested for the combatant whose turn begins after the native document update', async () => {
  const f = fixture({bindings: {'Scene.a.Region.foul': 'foul'}});
  const old = f.token('old', f.a, [f.foul]), next = f.token('next', f.a, [f.foul]);
  await trackHazardToken(old); await trackHazardToken(next);
  f.mutate(s => {resolveFoul(s, 'Actor.old', false); resolveFoul(s, 'Actor.next', false);});
  const combat = {id: 'encounter', round: 1, turn: 0, combatant: {id: 'old-combatant', token: old}};
  // Foundry14 Combat.nextTurn dispatches combatTurn before applying this update.
  await f.emit('combatTurn', combat, {round: 1, turn: 1}, {direction: 1});
  assert.equal(f.state.requests['foul:Actor.old'], undefined);
  combat.turn = 1; combat.combatant = {id: 'next-combatant', token: next};
  await f.emit('combatTurnChange', combat, {round: 1, turn: 0, combatantId: 'old-combatant'}, {round: 1, turn: 1, combatantId: 'next-combatant'});
  assert.equal(f.state.requests['foul:Actor.next'].kind, 'foul');
  assert.equal(f.state.requests['foul:Actor.old'], undefined);
});

test('repeated primary-GM opens share one assistants window until it closes', async () => {
  const f = fixture();
  const first = openAssistants(), second = openAssistants();
  try { await drain(); assert.equal(f.dialogs.length, 1); }
  finally {await f.closeDialogs(); await Promise.allSettled([first, second]);}
});

test('repeated primary-GM opens share one hazards window until it closes', async () => {
  const f = fixture({bindings: {}, stormEnded: false});
  const first = openHazards(), second = openHazards();
  try { await drain(); assert.equal(f.dialogs.length, 1); }
  finally {await f.closeDialogs(); await Promise.allSettled([first, second]);}
});

test('secondary GMs can view the assistant hub and hazard state without triggering writes', async () => {
  const f = fixture(); game.user = {id: 'second-gm', isGM: true, active: true};
  let hubError, hazardError;
  const hub = openAssistants().catch(error => {hubError = error;});
  const hazards = openHazards().catch(error => {hazardError = error;});
  try {
    await drain();
    assert.equal(hubError, undefined);
    assert.equal(hazardError, undefined);
    assert.equal(f.dialogs.length, 2);
    assert.equal(f.writes, 0);
  } finally {await f.closeDialogs(); await Promise.all([hub, hazards]);}
});
