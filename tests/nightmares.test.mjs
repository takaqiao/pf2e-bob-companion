import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeNightmares, queueRest, restRequirement, confirmRest, cancelRest,
  reserveResult, finishResult, pendingFrightened, expireNightmares,
  reserveFrightened, finishFrightened, correctCharacter, latestUnlockedChapter
} from '../scripts/nightmare-model.mjs';
import {buildPhobiaData, buildUneaseData, settleNightmareResult, consumeNightmareFrightened,
  recordNativeRest, requestNightmareSave, requestNightmareSaves, rollNightmareSave, expireNightmareEffects, registerNightmares} from '../scripts/nightmares.mjs';
import {translateItem} from '../scripts/i18n.mjs';

const fresh = (handled = false) => {
  const state = {};
  initializeNightmares(state, {chapter: 1, alreadyHandled: handled, at: 0});
  return state;
};
const rest = (state, id, chapter = 1, flatTotal) => {
  queueRest(state, {id, actorIds: ['a', 'b'], at: 100});
  confirmRest(state, {id, actorIds: ['a', 'b'], chapter, flatTotal});
  return state.sessions[id];
};

test('a new campaign and each newly unlocked chapter require a nightmare without a flat check', () => {
  const state = fresh();
  assert.equal(restRequirement(state, 1), 'first-night');
  assert.equal(rest(state, 'r1').nightmare, true);
  assert.equal(restRequirement(state, 1), 'flat-check');
  assert.equal(restRequirement(state, 2), 'new-chapter');
  assert.equal(rest(state, 'r2', 2).nightmare, true);
});

test('DC16 flat success avoids the nightmare and failure requests individual saves', () => {
  const state = fresh(true);
  assert.equal(rest(state, 'r1', 1, 16).status, 'complete');
  assert.equal(state.sessions.r1.nightmare, false);
  assert.equal(rest(state, 'r2', 1, 15).status, 'awaiting-results');
  assert.throws(() => rest(state, 'r3', 1), /BOB\.Nightmare\.FlatCheckRequired/);
});

test('duplicate native rest ids aggregate characters once and never reopen a settled rest', () => {
  const state = fresh();
  queueRest(state, {id: 'party', actorIds: ['a'], at: 100});
  queueRest(state, {id: 'party', actorIds: ['a', 'b'], at: 100});
  assert.deepEqual(state.sessions.party.actorIds, ['a', 'b']);
  confirmRest(state, {id: 'party', actorIds: ['a'], chapter: 1});
  const saved = structuredClone(state);
  queueRest(state, {id: 'party', actorIds: ['b'], at: 100});
  confirmRest(state, {id: 'party', actorIds: ['b'], chapter: 2});
  assert.deepEqual(state, saved);
});

test('canceling a queued rest or omitting sleepers never consumes the first night', () => {
  const state = fresh();
  queueRest(state, {id: 'r1', actorIds: ['a'], at: 100});
  assert.throws(() => confirmRest(state, {id: 'r1', actorIds: [], chapter: 1}), /BOB\.Nightmare\.ConfirmSleeper/);
  cancelRest(state, 'r1');
  assert.equal(state.sessions.r1.status, 'canceled');
  assert.equal(restRequirement(state, 1), 'first-night');
});

test('existing campaign setup deliberately handles past first nights and never rewrites established records', () => {
  const state = {};
  queueRest(state, {id: 'r1', actorIds: ['a'], at: 100});
  assert.throws(() => confirmRest(state, {id: 'r1', actorIds: ['a'], chapter: 3}), /BOB\.Nightmare\.InitializeFirst/);
  initializeNightmares(state, {chapter: 3, alreadyHandled: true, at: 100});
  assert.equal(restRequirement(state, 3), 'flat-check');
  assert.equal(restRequirement(state, 4), 'new-chapter');
  assert.throws(() => initializeNightmares(state, {chapter: 1, alreadyHandled: false}), /BOB\.Nightmare\.AlreadyInitialized/);
});

test('each character receives a chapter phobia once, independently, even after the effect expires', () => {
  const state = fresh();
  rest(state, 'r1');
  assert.equal(reserveResult(state, {id: 'r1', actorId: 'a', outcome: 'criticalFailure'}).applyPhobia, true);
  finishResult(state, {id: 'r1', actorId: 'a'});
  assert.equal(state.characters.a.chapters[1].phobiaAt, 100);
  assert.equal(reserveResult(state, {id: 'r1', actorId: 'b', outcome: 'criticalFailure'}).applyPhobia, true);
  finishResult(state, {id: 'r1', actorId: 'b'});
  expireNightmares(state, 90000);
  rest(state, 'r2', 1, 1);
  assert.equal(reserveResult(state, {id: 'r2', actorId: 'a', outcome: 'criticalFailure'}).effectiveOutcome, 'failure');
  finishResult(state, {id: 'r2', actorId: 'a'});
  rest(state, 'r3', 2);
  assert.equal(reserveResult(state, {id: 'r3', actorId: 'a', outcome: 'criticalFailure'}).applyPhobia, true);
});

test('result reservation survives failed effect creation and retries the same outcome without consumption', () => {
  const state = fresh(); rest(state, 'r1');
  const result = reserveResult(state, {id: 'r1', actorId: 'a', outcome: 'criticalFailure'});
  assert.equal(state.characters?.a?.chapters?.[1], undefined);
  assert.deepEqual(reserveResult(state, {id: 'r1', actorId: 'a', outcome: 'success'}), result);
  finishResult(state, {id: 'r1', actorId: 'a'});
  const saved = structuredClone(state);
  finishResult(state, {id: 'r1', actorId: 'a'});
  assert.deepEqual(state, saved);
});

test('a failed earlier result must recover before the same actor can settle a later rest', () => {
  const state = fresh(); rest(state, 'r1'); rest(state, 'r2', 1, 1);
  reserveResult(state, {id: 'r1', actorId: 'a', outcome: 'criticalFailure'});
  assert.throws(() => reserveResult(state, {id: 'r2', actorId: 'a', outcome: 'criticalFailure'}), /BOB\.Nightmare\.RecoverPriorResult/);
});

test('failure pending applies only to the next newly acquired frightened, expires at 24h, and cannot revive on rewind', () => {
  const state = fresh(); rest(state, 'r1');
  reserveResult(state, {id: 'r1', actorId: 'a', outcome: 'failure'});
  finishResult(state, {id: 'r1', actorId: 'a'});
  assert.equal(pendingFrightened(state, 'a', 99), null);
  assert.equal(pendingFrightened(state, 'a', 86499).until, 86500);
  assert.equal(pendingFrightened(state, 'a', 86500), null);
  expireNightmares(state, 86500);
  assert.equal(pendingFrightened(state, 'a', 200), null);
  assert.equal(state.characters.a.pending.expired, true);
});

test('controlled frightened application records a target before writes, retries safely, and consumes once', () => {
  const state = fresh(); rest(state, 'r1');
  reserveResult(state, {id: 'r1', actorId: 'a', outcome: 'failure'});
  finishResult(state, {id: 'r1', actorId: 'a'});
  assert.throws(() => reserveFrightened(state, {actorId: 'a', actionId: 'f1', conditionId: 'c', value: 0, at: 200}), /BOB\.Nightmare\.ApplyFrightenedFirst/);
  assert.equal(reserveFrightened(state, {actorId: 'a', actionId: 'f1', conditionId: 'c', value: 2, at: 200}).target, 3);
  assert.equal(reserveFrightened(state, {actorId: 'a', actionId: 'f1', conditionId: 'c', value: 3, at: 201}).target, 3);
  finishFrightened(state, {actorId: 'a', actionId: 'f1', at: 201});
  assert.equal(pendingFrightened(state, 'a', 201), null);
  assert.throws(() => reserveFrightened(state, {actorId: 'a', actionId: 'f2', conditionId: 'c', value: 3, at: 201}), /BOB\.Nightmare\.NoPendingFrightened/);
});

test('critical success records a lucid research opportunity but never changes the official research ledger', () => {
  const state = fresh(); rest(state, 'r1');
  reserveResult(state, {id: 'r1', actorId: 'a', outcome: 'criticalSuccess'});
  finishResult(state, {id: 'r1', actorId: 'a'});
  assert.equal(state.sessions.r1.results.a.lucidResearch, true);
  assert.equal(state.characters.a.pending, undefined);
});

test('GM correction can mark already applied phobia and clear a pending curse without resetting another chapter', () => {
  const state = fresh(true);
  correctCharacter(state, {actorId: 'a', chapter: 2, phobiaHandled: true, clearPending: false, at: 10});
  correctCharacter(state, {actorId: 'a', chapter: 1, phobiaHandled: false, clearPending: true, at: 20});
  assert.equal(state.characters.a.chapters[2].phobiaAt, 10);
  assert.equal(state.characters.a.chapters[1], undefined);
});

test('latest unlocked official area wins over the campsite and supports serialized campaign source', () => {
  assert.equal(latestUnlockedChapter({activeArea: {chapter: 5}, areas: {shore: {chapter: 1, accessible: true}}}), 5);
  assert.equal(latestUnlockedChapter({areas: {shore: {phantoms: {a: {rescued: true, home: {cleared: true}}}}, grounds: {memento: {returned: true}}, cellars: {memento: {returned: false}}}}), 3);
  assert.equal(latestUnlockedChapter(null), null);
});

test('official phobia rules retain their automation and use only the current condition in public details', () => {
  const source = {name: 'Effect: Nyctophobia', system: {rules: [{key: 'FlatModifier', slug: 'nyctophobia', value: -1}], description: {value: 'Hidden adventure prose', gm: 'Hidden GM prose'}}};
  const effect = buildPhobiaData(source, {chapter: 4, id: 'r1', at: 100});
  assert.deepEqual(effect.system.rules, source.system.rules);
  assert.equal(effect.system.duration.value, 24);
  assert.equal(effect.system.start.value, 100);
  assert.equal(effect.system.description.value.includes('Hidden'), false);
  assert.equal(effect.system.description.gm, '');
  assert.equal(buildUneaseData({id: 'r1', at: 100}).system.rules.length, 0);
  assert.equal(effect.flags['pf2e-bob-companion'].localization.description, 'Nightmare.Phobia4Description');
  const water = buildPhobiaData({...source, system: {...source.system, rules: []}}, {chapter: 1, id: 'r1', at: 100});
  assert.equal(water.system.rules[0].option, 'lake-laroba-in-sight');
  assert.equal(water.flags['pf2e-bob-companion'].localization.rules[0].label, 'Nightmare.DeepWaterVisible');
  assert.equal(buildUneaseData({id: 'r1', at: 100}).flags['pf2e-bob-companion'].localization.name, 'Nightmare.UneaseName');
});

test('created phobia title follows each client language while native slug and rules remain intact', () => {
  const priorGame = globalThis.game;
  const names = {'BOB.Nightmare.Phobia4Name': 'Nyctophobia'};
  globalThis.game = {i18n: {format: key => names[key] ?? key}};
  try {
    const source = {name: '黑暗恐惧', system: {slug: 'nyctophobia', rules: [{key: 'FlatModifier', slug: 'nyctophobia', value: -1}]}};
    const effect = buildPhobiaData(source, {chapter: 4, id: 'r1', at: 100});
    assert.equal(effect.name, 'Nyctophobia');
    assert.equal(effect.flags['pf2e-bob-companion'].localization.name, 'Nightmare.Phobia4Name');
    assert.equal(effect.system.slug, source.system.slug);
    assert.deepEqual(effect.system.rules, source.system.rules);
    names['BOB.Nightmare.Phobia4Name'] = '黑暗恐惧';
    translateItem(effect);
    assert.equal(effect.name, '黑暗恐惧');
    assert.equal(effect.system.slug, 'nyctophobia');
  } finally { globalThis.game = priorGame; }
});

function nativeFixture() {
  let root = {nightmares: fresh()};
  const items = [];
  const actor = {id: 'a', type: 'character', name: 'PC', items, createEmbeddedDocuments: async (_type, data) => {
    const created = data.map(d => ({...structuredClone(d), id: `item${items.length + 1}`}));
    items.push(...created); return created;
  }, deleteEmbeddedDocuments: async (_type, ids) => { for (const id of ids) items.splice(items.findIndex(i => i.id === id), 1); }};
  items.get = id => items.find(i => i.id === id);
  const users = [{id: 'gm', isGM: true, active: true}]; users.activeGM = users[0];
  const second = {id: 'b', type: 'character', name: 'Second PC', items: []};
  globalThis.game = {user: users[0], users, actors: {get: id => ({a: actor, b: second})[id]}, time: {worldTime: 100}, settings: {
    get: () => structuredClone(root), set: async (_id, _key, value) => {root = structuredClone(value);}
  }, messages: []};
  const hooks = {};
  globalThis.Hooks = {on: (name, handler) => {(hooks[name] ??= []).push(handler);}, once: (name, handler) => {(hooks[name] ??= []).push(handler);}, callAll() {}};
  globalThis.fromUuid = async () => ({type: 'effect', toObject: () => ({name: 'Effect: Thalassophobia', type: 'effect', system: {rules: [], description: {value: ''}}})});
  globalThis.ChatMessage = {create: async data => {const message = {...data, id: `m${game.messages.length}`}; game.messages.push(message); return message;}, getSpeaker: ({actor}) => ({actor: actor.id})};
  return {actor, hooks, state: () => root.nightmares, seed: fn => fn(root.nightmares)};
}

test('native rest completion aggregates one GM task and repeated chat delivery does not write or notify again', async () => {
  const fixture = nativeFixture();
  await recordNativeRest({id: 'batch1', actorIds: ['a'], at: 100, messageIds: ['m1']});
  await recordNativeRest({id: 'batch1', actorIds: ['a'], at: 100, messageIds: ['m1']});
  assert.equal(Object.keys(fixture.state().sessions).length, 1);
  assert.equal(game.messages.length, 1);
  assert.deepEqual(game.messages[0].whisper, ['gm']);
});

test('the global companion switch suppresses automatic rest recording and GM notifications', async () => {
  const fixture = nativeFixture(), get = game.settings.get;
  game.settings.get = (module, key) => key === 'config' ? {enabled: false} : get(module, key);
  await recordNativeRest({id: 'batch1', actorIds: ['a'], at: 100, messageIds: ['m1']});
  assert.equal(fixture.state().sessions, undefined);
  assert.equal(game.messages.length, 0);
});

test('missing official effect leaves a recoverable reservation; retry after a successful document write never duplicates it', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'r1'));
  const source = globalThis.fromUuid;
  globalThis.fromUuid = async () => null;
  await assert.rejects(settleNightmareResult({id: 'r1', actorId: 'a', outcome: 'criticalFailure'}), /BOB\.Common\.MissingEffect/);
  assert.equal(fixture.state().sessions.r1.results.a.status, 'applying');
  assert.equal(fixture.state().characters?.a?.chapters?.[1], undefined);
  globalThis.fromUuid = source;
  await settleNightmareResult({id: 'r1', actorId: 'a', outcome: 'criticalFailure'});
  await settleNightmareResult({id: 'r1', actorId: 'a', outcome: 'criticalFailure'});
  assert.equal(fixture.actor.items.filter(i => i.flags['pf2e-bob-companion'].nightmare.kind === 'phobia').length, 1);
  assert.equal(fixture.state().characters.a.chapters[1].phobiaAt, 100);
});

test('save requests are genuine PF2e checks, are idempotent, and reveal no chapter or future effect names', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'r1'));
  await requestNightmareSave({id: 'r1', actorId: 'a'});
  await requestNightmareSave({id: 'r1', actorId: 'a'});
  assert.equal(game.messages.length, 1);
  assert.match(game.messages[0].content, /BOB\.Nightmare\.WillSave/);
  assert.equal(game.messages[0].content.includes('深水恐惧'), false);
  assert.equal(game.messages[0].flags['pf2e-bob-companion'].nightmareRequest.actorId, 'a');
});

test('one batch request covers unresolved sleepers once and never asks a settled actor again', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'r1'));
  await requestNightmareSaves({id: 'r1'});
  await requestNightmareSaves({id: 'r1'});
  assert.equal(game.messages.length, 2);
  assert.deepEqual(game.messages.map(m => m.flags['pf2e-bob-companion'].nightmareRequest.actorId), ['a', 'b']);
  fixture.seed(s => {reserveResult(s, {id: 'r1', actorId: 'a', outcome: 'success'}); finishResult(s, {id: 'r1', actorId: 'a'});});
  await requestNightmareSaves({id: 'r1'});
  assert.equal(game.messages.length, 2);
  await assert.rejects(requestNightmareSave({id: 'r1', actorId: 'a'}), /BOB\.Nightmare\.NoPendingSave/);
  fixture.seed(s => {s.sessions.r1.suggestions = {b: {outcome: 'success', messageId: 'roll1'}};});
  assert.deepEqual(await requestNightmareSaves({id: 'r1'}), []);
  await assert.rejects(rollNightmareSave({id: 'r1', actorId: 'b'}), /BOB\.Nightmare\.NoPendingSave/);
});

test('the native Will action does not roll twice for the same sleeper and rest', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'r2'));
  let rolls = 0;
  fixture.actor.saves = {will: {roll: async () => {rolls++; return {total: 20};}}};
  await rollNightmareSave({id: 'r2', actorId: 'a'});
  await assert.rejects(rollNightmareSave({id: 'r2', actorId: 'a'}), /BOB\.Nightmare\.SaveAlreadyRolled/);
  assert.equal(rolls, 1);
});

test('frightened transaction recovers after native update succeeds but ledger commit fails', async () => {
  const fixture = nativeFixture(); fixture.seed(s => {rest(s, 'r1'); reserveResult(s, {id: 'r1', actorId: 'a', outcome: 'failure'}); finishResult(s, {id: 'r1', actorId: 'a'});});
  const condition = {id: 'fear', type: 'condition', slug: 'frightened', system: {value: {value: 1}}, flags: {}, get value() {return this.system.value.value;}};
  fixture.actor.items.push(condition); fixture.actor.getCondition = () => condition;
  condition.update = async data => {condition.system.value.value = data['system.value.value']; condition.flags['pf2e-bob-companion'] = {nightmareFrightened: data['flags.pf2e-bob-companion.nightmareFrightened']};};
  const save = game.settings.set;
  let writes = 0;
  game.settings.set = async (...args) => {if (++writes === 2) throw Error('write failed'); return save(...args);};
  await assert.rejects(consumeNightmareFrightened({actorId: 'a', actionId: 'f1'}), /write failed/);
  assert.equal(condition.value, 2);
  game.settings.set = save;
  await consumeNightmareFrightened({actorId: 'a', actionId: 'f1'});
  assert.equal(condition.value, 2);
  assert.equal(fixture.state().characters.a.pending.consumed, true);
});

test('expiry removes only this assistant’s elapsed effects and time reversal cannot restore their mechanics', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'r1'));
  await settleNightmareResult({id: 'r1', actorId: 'a', outcome: 'criticalFailure'});
  fixture.actor.items.push({id: 'unrelated', flags: {}, system: {duration: {unit: 'hours', value: 24}}});
  await expireNightmareEffects(86500);
  assert.deepEqual(fixture.actor.items.map(i => i.id), ['unrelated']);
  await expireNightmareEffects(200);
  assert.equal(fixture.state().sessions.r1.results.a.expired, true);
  assert.equal(pendingFrightened(fixture.state(), 'a', 200), null);
  assert.equal(fixture.actor.items.length, 1);
});

test('settling an hour late uses only the remaining native effect duration despite PF2e resetting its start', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'r1'));
  game.time.worldTime = 3700;
  await settleNightmareResult({id: 'r1', actorId: 'a', outcome: 'criticalFailure'});
  assert.deepEqual(fixture.actor.items.map(i => [i.system.duration.unit, i.system.duration.value, i.system.start.value]),
    [['minutes', 1380, 3700], ['minutes', 1380, 3700]]);
});

test('recovering a partially created phobia after its deadline removes it before sticky expiry, including after rewind', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'r1'));
  const create = fixture.actor.createEmbeddedDocuments;
  let attempts = 0;
  fixture.actor.createEmbeddedDocuments = async (...args) => {
    if (++attempts === 2) throw Error('unease creation failed');
    return create(...args);
  };
  await assert.rejects(settleNightmareResult({id: 'r1', actorId: 'a', outcome: 'criticalFailure'}), /unease/);
  assert.equal(fixture.actor.items.length, 1);
  game.time.worldTime = 86500;
  await settleNightmareResult({id: 'r1', actorId: 'a', outcome: 'criticalFailure'});
  assert.equal(fixture.actor.items.length, 0);
  await expireNightmareEffects(200);
  assert.equal(pendingFrightened(fixture.state(), 'a', 200), null);
});

test('registered native chat hook keeps the native reroll and ignores duplicates or settled results', async () => {
  const fixture = nativeFixture(); fixture.seed(s => rest(s, 'native-save'));
  let writes = 0;
  const save = game.settings.set;
  game.settings.set = async (...args) => {writes++; return save(...args);};
  registerNightmares();
  const create = fixture.hooks.createChatMessage[0];
  const message = (id, outcome, isReroll = false) => ({id, speaker: {actor: 'a'}, flags: {pf2e: {context: {
    type: 'saving-throw', outcome, isReroll, options: ['bob-nightmare:native-save']
  }}}});
  create(message('roll-1', 'criticalFailure'), {});
  create(message('roll-2', 'success'), {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.state().sessions['native-save'].suggestions.a, {outcome: 'criticalFailure', messageId: 'roll-1'});
  assert.equal(writes, 1);
  create(message('roll-3', 'failure'), {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  create(message('reroll-1', 'success', true), {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.state().sessions['native-save'].suggestions.a, {outcome: 'success', messageId: 'reroll-1'});
  assert.equal(writes, 2);
  create(message('reroll-1', 'success', true), {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 2);
  fixture.seed(s => {reserveResult(s, {id: 'native-save', actorId: 'a', outcome: 'success'}); finishResult(s, {id: 'native-save', actorId: 'a'});});
  create(message('reroll-2', 'criticalSuccess', true), {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 2);
  assert.equal(fixture.state().sessions['native-save'].suggestions.a.outcome, 'success');
});
