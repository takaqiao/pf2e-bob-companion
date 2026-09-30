import test from 'node:test';
import assert from 'node:assert/strict';
import {readCatalog} from './helpers/localization.mjs';

const ID = 'pf2e-bob-companion';
let moduleNumber = 0;

async function fixture(domain = {}, {ready = true} = {}) {
  let root = structuredClone(domain), writes = 0, cardWrites = 0, sequence = 0;
  const hooks = new Map(), messages = [], errors = [], rolls = [];
  messages.get = id => messages.find(message => message.id === id);
  messages.contents = messages;
  const gm = {id: 'gm', isGM: true, active: true};
  const users = Object.assign([gm, {id: 'player', isGM: false, active: true}], {activeGM: gm});
  const actors = new Map();
  for (const id of ['a', 'b']) {
    const actor = {id, uuid: `Actor.${id}`, name: id, type: 'character', hasPlayerOwner: true, items: [],
      saves: Object.fromEntries(['will', 'fortitude'].map(save => [save, {async roll(options) {rolls.push({actor: id, save, options}); return {};}}])),
      async createEmbeddedDocuments(_type, data) {
        const created = data.map(entry => ({...structuredClone(entry), id: `item-${++sequence}`, uuid: `Actor.${id}.Item.item-${sequence}`}));
        this.items.push(...created); return created;
      },
      async updateEmbeddedDocuments(_type, data) {for (const entry of data) Object.assign(this.items.find(item => item.id === entry._id), entry);},
      async deleteEmbeddedDocuments(_type, ids) {this.items = this.items.filter(item => !ids.includes(item.id));}
    };
    actors.set(id, actor);
  }
  actors.party = {members: [...actors.values()]};
  const config = {enabled: true};
  globalThis.game = {ready, user: gm, users, actors, messages, modules: new Map([[ID, {api: {}}]]), time: {worldTime: 4000},
    settings: {get(_id, key) {return key === 'config' ? config : structuredClone(root);}, async set(_id, _key, value) {
      if (!game.ready) throw new Error('You may not set a World-level Setting before the Game is ready.');
      root = structuredClone(value); writes++;
    }},
    i18n: {format: key => key}, scenes: Object.assign(new Map(), {active: null})};
  globalThis.foundry = {utils: {randomID: () => `random-${++sequence}`}};
  globalThis.Hooks = {on(name, fn) {const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list);}, once(name, fn) {this.on(name, fn);}, callAll() {}};
  globalThis.ui = {notifications: {error: error => errors.push(error)}};
  globalThis.fromUuidSync = ref => actors.get(ref.replace(/^Actor\./, ''));
  globalThis.fromUuid = async ref => fromUuidSync(ref) ?? {type: 'feat', toObject: () => ({type: 'feat', system: {slug: 'pharasma-minor-boon', rules: [], description: {value: '', gm: ''}}})};
  globalThis.ChatMessage = {async create(data) {
    const message = {...data, id: `message-${++sequence}`, async update(changes) {Object.assign(this, changes); cardWrites++; return this;}};
    messages.push(message); cardWrites++; return message;
  }};
  const boons = await import(`../scripts/boons.mjs?chat-test=${++moduleNumber}`);
  const hazards = await import(`../scripts/hazards.mjs?chat-test=${++moduleNumber}`);
  // Native ChatMessagePF2e.isCheckRoll is an instanceof CheckRoll test on its first roll.
  // Model that document boundary instead of treating the presence of context as a rolled check.
  class CheckRoll {constructor(total = 17) {this.total = total;}}
  const native = (id, actorId, outcome, options = [], extra = {}) => ({id, actor: actors.get(actorId), speaker: {actor: actorId},
    rolls: [new CheckRoll()], get isCheckRoll() {return this.rolls[0] instanceof CheckRoll;},
    flags: {pf2e: {context: {type: 'saving-throw', outcome, options, ...extra}, modifiers: []}}});
  return {boons, hazards, actors, messages, rolls, errors, config, native,
    state: domain => structuredClone(root[domain] ?? {}), writes: () => writes, cardWrites: () => cardWrites,
    seed(domain, fn) {root[domain] ??= {}; fn(root[domain]);},
    async emit(name, ...args) {for (const fn of hooks.get(name) ?? []) await fn(...args); await new Promise(resolve => setImmediate(resolve));}};
}

test('meditation native save and reroll update one GM card and double Apply grants one effect', async () => {
  const f = await fixture();
  assert.equal(typeof f.boons.requestMeditationWorkflow, 'function', 'meditation must expose a correlated chat workflow');
  await f.boons.requestMeditationWorkflow({id: 'meditate', actorId: 'Actor.a', start: 0, at: 3600, cleaned: true, confirmed: true});
  await f.boons.rollMeditationRequest({id: 'meditate'});
  assert.deepEqual(f.rolls[0].options.extraRollOptions, ['action:meditate', 'bob-boon:meditate']);
  await f.boons.captureBoonRoll(f.native('wrong', 'b', 'criticalSuccess', ['bob-boon:meditate']));
  assert.equal(f.state('boons').requests.meditate.suggestion, undefined);
  await f.boons.captureBoonRoll(f.native('initial', 'a', 'failure', ['bob-boon:meditate']));
  await f.boons.captureBoonRoll(f.native('rerolled', 'a', 'criticalSuccess', ['bob-boon:meditate'], {isReroll: true}));
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0].whisper, ['gm']);
  assert.equal(f.state('boons').requests.meditate.suggestion.messageId, 'rerolled');
  await assert.rejects(f.boons.applyMeditationResult({id: 'meditate', messageId: 'initial'}), /Stale/);
  await Promise.all([f.boons.applyMeditationResult({id: 'meditate', messageId: 'rerolled'}), f.boons.applyMeditationResult({id: 'meditate', messageId: 'rerolled'})]);
  assert.equal(f.actors.get('a').items.length, 1);
  assert.equal(f.state('boons').uses.meditate.bonus, 2);
  const writes = f.writes();
  await f.boons.captureBoonRoll(f.native('late', 'a', 'criticalFailure', ['bob-boon:meditate'], {isReroll: true}));
  assert.equal(f.writes(), writes);
});

test('single-use meditation is consumed only when its owned native modifier contributed', async () => {
  const f = await fixture();
  assert.equal(typeof f.boons.captureBoonRoll, 'function', 'native roll evidence must settle meditation use');
  const c = f.boons.createBoonController({read: () => f.state('boons'), update: async fn => {f.seed('boons', fn); return f.state('boons');}, serialize: fn => fn(), requirePrimary() {}, actor: ref => f.actors.get(ref.replace(/^Actor\./, '')), load() {}, time: () => 4000, roomActors: () => [], environment: () => ({valid: true, night: false}), enabled: () => true});
  await c.use({id: 'bonus', kind: 'A14', actorId: 'Actor.a', start: 0, at: 3600, degree: 'success', cleaned: true});
  const item = f.actors.get('a').items[0];
  const suppressed = f.native('suppressed', 'a', 'success', [], {type: 'skill-check'});
  suppressed.flags.pf2e.modifiers = [{enabled: false, ignored: false, modifier: 1, source: item.uuid}];
  await f.boons.captureBoonRoll(suppressed);
  assert.equal(f.state('boons').uses.bonus.consumedAt, undefined);
  const foreign = f.native('foreign', 'b', 'success', [], {type: 'skill-check'});
  foreign.flags.pf2e.modifiers = [{enabled: true, modifier: 1, source: item.uuid}];
  await f.boons.captureBoonRoll(foreign);
  assert.equal(f.state('boons').uses.bonus.consumedAt, undefined);
  const used = f.native('used', 'a', 'success', [], {type: 'skill-check'});
  used.flags.pf2e.modifiers = [{enabled: true, ignored: false, modifier: 1, source: item.uuid}];
  await f.boons.captureBoonRoll(used);
  await f.boons.captureBoonRoll(used);
  assert.equal(f.state('boons').uses.bonus.consumedAt, 4000);
  assert.equal(f.actors.get('a').items.length, 0);
});

test('uncleaned meditation keeps the native failure and explains its actual consequence before Apply', async () => {
  const f = await fixture();
  const catalog = await readCatalog('en');
  game.i18n.format = (key, values = {}) => (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_match, key) => values[key] ?? '');
  await f.boons.requestMeditationWorkflow({id:'uncleaned',actorId:'Actor.a',start:0,at:3600,cleaned:false,confirmed:true});
  const native = f.native('failure','a','failure',['bob-boon:uncleaned']);
  await f.boons.captureBoonRoll(native);
  assert.match(f.messages[0].content,/>Recorded result: Failure</);
  assert.match(f.messages[0].content,/stupefied 1/);
  assert.equal(native.flags.pf2e.context.outcome,'failure');
  await f.boons.applyMeditationResult({id:'uncleaned',messageId:'failure'});
  assert.equal(f.state('boons').uses.uncleaned.degree,'criticalFailure');
});

test('unrelated native rolls and disabled domains produce no state or chat writes', async () => {
  const f = await fixture();
  assert.equal(typeof f.boons.captureBoonRoll, 'function');
  assert.equal(typeof f.hazards.captureHazardRoll, 'function');
  await f.boons.captureBoonRoll(f.native('unrelated', 'a', 'success'));
  await f.hazards.captureHazardRoll(f.native('unrelated', 'a', 'success'));
  f.config.enabled = false;
  await f.boons.captureBoonRoll(f.native('disabled', 'a', 'success', ['bob-boon:missing']));
  await f.hazards.captureHazardRoll(f.native('disabled', 'a', 'success', ['bob-hazard:missing']));
  assert.equal(f.writes(), 0);
  assert.equal(f.cardWrites(), 0);
});

test('foul-air stale generations and actor mismatches cannot settle the current exposure', async () => {
  const f = await fixture({hazards: {actors: {'Actor.a': {immune: false}}, requests: {'foul:Actor.a': {id: 'new', kind: 'foul', actorUuid: 'Actor.a', at: 4000}}}});
  assert.equal(typeof f.hazards.captureHazardRoll, 'function');
  await f.hazards.captureHazardRoll(f.native('stale', 'a', 'success', ['bob-hazard:old']));
  await f.hazards.captureHazardRoll(f.native('wrong', 'b', 'success', ['bob-hazard:new']));
  assert.equal(f.writes(), 0);
  await f.hazards.rollAir({id: 'new', actorUuid: 'Actor.a'});
  assert.deepEqual(f.rolls[0].options.extraRollOptions, ['bob-hazard:new']);
  await f.hazards.captureHazardRoll(f.native('air-initial', 'a', 'failure', ['bob-hazard:new']));
  await f.hazards.captureHazardRoll(f.native('air-reroll', 'a', 'success', ['bob-hazard:new'], {isReroll: true}));
  await assert.rejects(f.hazards.applyAirResult({id: 'new', actorUuid: 'Actor.a', messageId: 'air-initial'}), /Stale/);
  await Promise.all([f.hazards.applyAirResult({id: 'new', actorUuid: 'Actor.a', messageId: 'air-reroll'}), f.hazards.applyAirResult({id: 'new', actorUuid: 'Actor.a', messageId: 'air-reroll'})]);
  assert.equal(f.state('hazards').actors['Actor.a'].immune, true);
  assert.equal(f.state('hazards').requests['foul:Actor.a'], undefined);
  f.seed('hazards', s => {s.requests['foul:Actor.a'] = {id: 'newer', kind: 'foul', actorUuid: 'Actor.a', at: 4000};});
  await f.hazards.captureHazardRoll(f.native('late', 'a', 'criticalSuccess', ['bob-hazard:new'], {isReroll: true}));
  assert.equal(f.state('hazards').requests['foul:Actor.a'].suggestion, undefined);
});

test('failed foul-air roll stays pending until the GM explicitly confirms native consequences', async () => {
  const f = await fixture({hazards: {actors: {'Actor.a': {immune: false}}, requests: {'foul:Actor.a': {id: 'failure', kind: 'foul', actorUuid: 'Actor.a', at: 4000}}}});
  assert.equal(typeof f.hazards.captureHazardRoll, 'function');
  await f.hazards.captureHazardRoll(f.native('air-failure', 'a', 'criticalFailure', ['bob-hazard:failure']));
  await assert.rejects(f.hazards.applyAirResult({id: 'failure', actorUuid: 'Actor.a', messageId: 'air-failure'}), /Consequences/);
  assert.ok(f.state('hazards').requests['foul:Actor.a']);
  await f.hazards.applyAirResult({id: 'failure', actorUuid: 'Actor.a', messageId: 'air-failure', handled: true});
  assert.equal(f.state('hazards').actors['Actor.a'].immune, false);
  assert.equal(f.state('hazards').requests['foul:Actor.a'], undefined);
});

test('foul-air cards describe the save degree without unrelated meditation rewards or penalties', async () => {
  const f = await fixture({hazards:{actors:{'Actor.a':{immune:false}},requests:{'foul:Actor.a':{id:'air-degree',kind:'foul',actorUuid:'Actor.a',at:4000}}}});
  const catalog = await readCatalog('en');
  game.i18n.format = (key, values = {}) => (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_match, key) => values[key] ?? '');
  for (const [index, outcome] of ['criticalFailure','success','criticalSuccess'].entries()) {
    await f.hazards.captureHazardRoll(f.native(`degree-${index}`,'a',outcome,['bob-hazard:air-degree'],{isReroll:index>0}));
    assert.doesNotMatch(f.messages[0].content,/stupefied|Intelligence|next.*skill check/i);
    assert.match(f.messages[0].content,/Recorded result:/);
  }
});

test('a meditation reroll delivered while reservation waits prevents application of the stale result', async () => {
  const f = await fixture();
  await f.boons.requestMeditationWorkflow({id: 'race', actorId: 'Actor.a', start: 0, at: 3600, cleaned: true, confirmed: true});
  await f.boons.captureBoonRoll(f.native('first', 'a', 'failure', ['bob-boon:race']));
  let release, started;
  const waiting = new Promise(resolve => {started = resolve;});
  const original = game.settings.set;
  game.settings.set = async (...args) => {started(); await new Promise(resolve => {release = resolve;}); game.settings.set = original; return original(...args);};
  const applying = f.boons.applyMeditationResult({id: 'race', messageId: 'first'});
  await waiting;
  const capture = f.boons.captureBoonRoll(f.native('replacement', 'a', 'criticalSuccess', ['bob-boon:race'], {isReroll: true}));
  release();
  await assert.rejects(applying, /Stale/);
  await capture;
  assert.equal(f.state('boons').requests.race.suggestion.messageId, 'replacement');
  assert.equal(f.actors.get('a').items.length, 0);
});

test('a meditation reroll during an effect write leaves the reserved receipt and an explicit review warning', async () => {
  const f = await fixture();
  await f.boons.requestMeditationWorkflow({id: 'writing', actorId: 'Actor.a', start: 0, at: 3600, cleaned: true, confirmed: true});
  await f.boons.captureBoonRoll(f.native('reserved', 'a', 'success', ['bob-boon:writing']));
  let release, started;
  const waiting = new Promise(resolve => {started = resolve;});
  const actor = f.actors.get('a'), original = actor.createEmbeddedDocuments;
  actor.createEmbeddedDocuments = async (...args) => {started(); await new Promise(resolve => {release = resolve;}); return original.call(actor, ...args);};
  const applying = f.boons.applyMeditationResult({id: 'writing', messageId: 'reserved'});
  await waiting;
  await f.boons.captureBoonRoll(f.native('late-replacement', 'a', 'criticalSuccess', ['bob-boon:writing'], {isReroll: true}));
  release(); await applying;
  assert.equal(f.state('boons').uses.writing.bonus, 1);
  assert.equal(f.state('boons').requests.writing.lateReroll.messageId, 'late-replacement');
  assert.match(f.messages[0].content, /BOB.Boon.Chat.RerollDuringApply/);
});

test('G4 requires deliberate choice and native correction confirmation while keeping the actual native roll intact', async () => {
  const f = await fixture({boons: {actions: {}, uses: {gear: {id: 'gear', kind: 'G4', actorId: 'Actor.a', at: 1, status: 'done', expiresAt: null}}}});
  const roll = f.native('chosen-check', 'a', 'failure', [], {type: 'skill-check'});
  roll.rolls[0].total = 15;
  const before = structuredClone(roll.flags);
  await f.boons.captureBoonRoll(roll);
  await assert.rejects(f.boons.chooseGearBoon({action: 'gear-confirm', id: 'gear:gear', messageId: 'chosen-check'}), /Stale/);
  await f.boons.chooseGearBoon({action: 'gear-select', id: 'gear:gear', messageId: 'chosen-check'});
  assert.equal(f.state('boons').uses.gear.consumedAt, undefined);
  await Promise.all([f.boons.chooseGearBoon({action: 'gear-confirm', id: 'gear:gear', messageId: 'chosen-check'}),
    f.boons.chooseGearBoon({action: 'gear-confirm', id: 'gear:gear', messageId: 'chosen-check'})]);
  assert.equal(f.state('boons').uses.gear.consumedAt, 4000);
  assert.deepEqual(roll.flags, before);
  assert.equal(roll.rolls[0].total, 15);
  assert.equal(f.messages.length, 1);
});

test('lightning card checks decrement one batch and update the existing GM card', async () => {
  const f = await fixture({hazards: {requests: {lightning: {id: 'batch', kind: 'lightning', count: 2, at: 4000}}}});
  const totals = [5, 18];
  globalThis.Roll = class {async evaluate() {this.total = totals.shift(); return this;} async toMessage() {}};
  await f.hazards.refreshHazardCards();
  const card = f.messages[0];
  await f.hazards.rollLightning({id: 'batch'});
  assert.equal(f.state('hazards').requests.lightning.count, 1);
  assert.equal(f.messages[0], card);
  await f.hazards.rollLightning({id: 'batch'});
  assert.equal(f.state('hazards').requests.lightning, undefined);
  assert.match(card.content, /BOB.Hazard.Chat.Handled/);
  await assert.rejects(f.hazards.rollLightning({id: 'batch'}), /NoLightning/);
});

test('failed native meditation cleanup leaves a GM retry card for its reserved consumption', async () => {
  const f = await fixture({boons: {actions: {}, uses: {bonus: {id: 'bonus', kind: 'A14', actorId: 'Actor.a', start: 0, at: 3600, status: 'done', bonus: 1, expiresAt: 90000}}}});
  const actor = f.actors.get('a');
  actor.items.push({id: 'effect', uuid: 'Actor.a.Item.effect', flags: {[ID]: {boon: {id: 'bonus'}}}});
  actor.deleteEmbeddedDocuments = async () => {throw new Error('cleanup failure');};
  const roll = f.native('spent', 'a', 'success', [], {type: 'skill-check'});
  roll.flags.pf2e.modifiers = [{source: 'Actor.a.Item.effect', enabled: true, modifier: 1}];
  await assert.rejects(f.boons.captureBoonRoll(roll), /cleanup failure/);
  assert.equal(f.state('boons').uses.bonus.consumedAt, 4000);
  assert.equal(f.state('boons').uses.bonus.status, 'pending');
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].content, /data-bob-card-action="boon-retry"/);
});

test('a foul-air reroll during the ledger write restores the exposure for the current result', async () => {
  const f = await fixture({hazards: {actors: {'Actor.a': {immune: false, outsideSince: null}}, requests: {'foul:Actor.a': {id: 'air-race', kind: 'foul', actorUuid: 'Actor.a', at: 4000}}}});
  await f.hazards.captureHazardRoll(f.native('old-success', 'a', 'success', ['bob-hazard:air-race']));
  let release, started;
  const waiting = new Promise(resolve => {started = resolve;});
  const original = game.settings.set;
  game.settings.set = async (...args) => {started(); await new Promise(resolve => {release = resolve;}); game.settings.set = original; return original(...args);};
  const applying = f.hazards.applyAirResult({id: 'air-race', actorUuid: 'Actor.a', messageId: 'old-success'});
  await waiting;
  const capture = f.hazards.captureHazardRoll(f.native('new-failure', 'a', 'failure', ['bob-hazard:air-race'], {isReroll: true}));
  release();
  await assert.rejects(applying, /Stale/);
  await capture;
  assert.equal(f.state('hazards').actors['Actor.a'].immune, false);
  assert.equal(f.state('hazards').requests['foul:Actor.a'].suggestion.messageId, 'new-failure');
});

test('additional due lightning intervals refresh the same pending batch card', async () => {
  const f = await fixture({hazards: {tokens: {pc: {actorUuid: 'Actor.a', inTower: true}},
    lightning: {elapsed: 600, started: 4000, notified: 1}, requests: {lightning: {id: 'ongoing', kind: 'lightning', count: 1, at: 4000}}}});
  f.hazards.registerHazards();
  await f.hazards.refreshHazardCards();
  game.time.worldTime = 4600;
  await f.emit('updateWorldTime', 4600);
  assert.equal(f.state('hazards').requests.lightning.count, 2);
  assert.equal(f.state('hazards').requests.lightning.id, 'ongoing');
  assert.equal(f.messages.length, 1);
});

test('air reroll reconciliation survives a failed chat update after the ledger write', async () => {
  const f = await fixture({hazards:{actors:{'Actor.a':{immune:false}},requests:{'foul:Actor.a':{id:'publish-fault',kind:'foul',actorUuid:'Actor.a',at:4000}}}});
  await f.hazards.captureHazardRoll(f.native('original-success','a','success',['bob-hazard:publish-fault']));
  const card = f.messages[0], originalUpdate = card.update;
  card.update = async changes => {card.update = originalUpdate; throw Error('Chat offline');};
  let release, started;
  const waiting = new Promise(resolve => {started = resolve;});
  const originalSet = game.settings.set;
  game.settings.set = async (...args) => {
    started(); await new Promise(resolve => {release = resolve;});
    game.settings.set = originalSet;
    return originalSet(...args);
  };
  const applying = f.hazards.applyAirResult({id:'publish-fault',actorUuid:'Actor.a',messageId:'original-success'});
  await waiting;
  const capture = f.hazards.captureHazardRoll(f.native('replacement-failure','a','failure',['bob-hazard:publish-fault'],{isReroll:true}));
  release();
  await assert.rejects(applying);
  await capture;
  assert.equal(f.state('hazards').actors['Actor.a'].immune,false);
  assert.equal(f.state('hazards').airResults?.['publish-fault'],undefined);
  assert.equal(f.state('hazards').requests['foul:Actor.a'].suggestion.messageId,'replacement-failure');
  await assert.rejects(f.hazards.applyAirResult({id:'publish-fault',actorUuid:'Actor.a',messageId:'original-success'}));
  assert.match(card.content,/replacement-failure/);
});

test('a committed air result repairs its stale card after chat failure and retry or reload refresh', async () => {
  const f = await fixture({hazards:{actors:{'Actor.a':{immune:false}},requests:{'foul:Actor.a':{id:'receipt-recovery',kind:'foul',actorUuid:'Actor.a',at:4000}}}});
  await f.hazards.captureHazardRoll(f.native('success','a','success',['bob-hazard:receipt-recovery']));
  const card = f.messages[0], before = card.content, originalUpdate = card.update;
  card.update = async () => {card.update = originalUpdate; throw Error('Chat offline');};
  await assert.rejects(f.hazards.applyAirResult({id:'receipt-recovery',actorUuid:'Actor.a',messageId:'success'}));
  assert.equal(f.state('hazards').actors['Actor.a'].immune,true);
  assert.equal(card.content,before);
  await f.hazards.applyAirResult({id:'receipt-recovery',actorUuid:'Actor.a',messageId:'success'});
  assert.match(card.content,/BOB.Hazard.Chat.Handled/);
  card.content = before;
  await f.hazards.refreshHazardCards();
  assert.match(card.content,/BOB.Hazard.Chat.Handled/);
  assert.equal(f.messages.length,1);
});

test('a new native check during G4 confirmation cannot change which check the GM chose', async () => {
  const f = await fixture({boons: {actions: {}, uses: {gear: {id: 'gear', kind: 'G4', actorId: 'Actor.a', at: 1, status: 'done', expiresAt: null}}}});
  await f.boons.captureBoonRoll(f.native('chosen', 'a', 'success', [], {type: 'skill-check'}));
  await f.boons.chooseGearBoon({action: 'gear-select', id: 'gear:gear', messageId: 'chosen'});
  let release, started;
  const waiting = new Promise(resolve => {started = resolve;});
  const original = game.settings.set;
  game.settings.set = async (...args) => {started(); await new Promise(resolve => {release = resolve;}); game.settings.set = original; return original(...args);};
  const confirming = f.boons.chooseGearBoon({action: 'gear-confirm', id: 'gear:gear', messageId: 'chosen'});
  await waiting;
  const capture = f.boons.captureBoonRoll(f.native('other-check', 'a', 'criticalSuccess', [], {type: 'skill-check'}));
  release(); await confirming; await capture;
  assert.equal(f.state('boons').gearRequests['gear:gear'].messageId, 'chosen');
  assert.equal(f.state('boons').gearRequests['gear:gear'].applied, true);
});

for (const type of ['damage-taken', 'self-effect', 'saving-throw']) {
  test(`native ${type} message without a CheckRoll preserves a selected G4 check and causes no writes`, async () => {
    const f = await fixture({boons: {actions: {}, uses: {gear: {id: 'gear', kind: 'G4', actorId: 'Actor.a', at: 1, status: 'done', expiresAt: null}}}});
    await f.boons.captureBoonRoll(f.native('chosen-check', 'a', 'success', [], {type: 'skill-check'}));
    await f.boons.chooseGearBoon({action: 'gear-select', id: 'gear:gear', messageId: 'chosen-check'});
    const chosen = f.state('boons').gearRequests['gear:gear'], writes = f.writes(), chatWrites = f.cardWrites();
    const message = f.native('nonroll', 'a', 'success', [], {type});
    message.rolls = [];
    await f.boons.captureBoonRoll(message);
    assert.deepEqual(f.state('boons').gearRequests['gear:gear'], chosen);
    assert.equal(f.writes(), writes);
    assert.equal(f.cardWrites(), chatWrites);
  });
}

test('a finite ordinary Roll cannot create a G4 request when native isCheckRoll is false', async () => {
  const f = await fixture({boons: {actions: {}, uses: {gear: {id: 'gear', kind: 'G4', actorId: 'Actor.a', at: 1, status: 'done', expiresAt: null}}}});
  const message = f.native('ordinary-roll', 'a', 'success', [], {type: 'skill-check'});
  message.rolls = [{total: 20}];
  await f.boons.captureBoonRoll(message);
  assert.equal(f.state('boons').gearRequests, undefined);
  assert.equal(f.writes(), 0);
  assert.equal(f.cardWrites(), 0);
});

test('nonroll context cannot capture meditation or consume an owned A14 modifier', async () => {
  const f = await fixture({boons: {actions: {}, requests: {unrolled: {id: 'unrolled', actorId: 'Actor.a', start: 0, at: 3600, cleaned: true}},
    uses: {bonus: {id: 'bonus', kind: 'A14', actorId: 'Actor.a', start: 0, at: 3600, status: 'done', bonus: 1, expiresAt: 90000}}}});
  const actor = f.actors.get('a');
  actor.items.push({id: 'effect', uuid: 'Actor.a.Item.effect', flags: {[ID]: {boon: {id: 'bonus'}}}});
  const message = f.native('no-check', 'a', 'criticalSuccess', ['bob-boon:unrolled']);
  message.rolls = [];
  message.flags.pf2e.modifiers = [{source: 'Actor.a.Item.effect', enabled: true, modifier: 1}];
  await f.boons.captureBoonRoll(message);
  assert.equal(f.state('boons').requests.unrolled.suggestion, undefined);
  assert.equal(f.state('boons').uses.bonus.consumedAt, undefined);
  assert.equal(actor.items.length, 1);
  assert.equal(f.writes(), 0);
  assert.equal(f.cardWrites(), 0);
});

test('a native CheckRoll with a nonfinite total cannot create a G4 request', async () => {
  const f = await fixture({boons: {actions: {}, uses: {gear: {id: 'gear', kind: 'G4', actorId: 'Actor.a', at: 1, status: 'done', expiresAt: null}}}});
  for (const total of [undefined, NaN, Infinity]) {
    const message = f.native('unevaluated', 'a', 'success', [], {type: 'skill-check'});
    message.rolls[0].total = total;
    await f.boons.captureBoonRoll(message);
  }
  assert.equal(f.state('boons').gearRequests, undefined);
  assert.equal(f.writes(), 0);
  assert.equal(f.cardWrites(), 0);
});

test('initial canvas waits for game readiness before hazard reconciliation and later canvases still track exposure', async () => {
  const f = await fixture({hazards: {bindings: {'Scene.scene.Region.foul': 'foul'}}}, {ready: false});
  const region = {id: 'foul', uuid: 'Scene.scene.Region.foul'};
  const scene = {id: 'scene', uuid: 'Scene.scene', regions: [region], tokens: []};
  const token = id => ({actorId: id, uuid: `Scene.scene.Token.${id}`, parent: scene, regions: new Set([region])});
  scene.tokens.push(token('a')); game.scenes.set(scene.id, scene); game.scenes.active = scene;
  f.hazards.registerHazards();
  await f.emit('canvasReady');
  assert.deepEqual(f.errors, []);
  assert.equal(f.writes(), 0); assert.equal(f.cardWrites(), 0);
  assert.equal(f.state('hazards').tokens, undefined);

  game.ready = true; await f.emit('ready');
  assert.equal(f.state('hazards').tokens['Scene.scene.Token.a'].inFoul, true);
  assert.equal(f.state('hazards').requests['foul:Actor.a'].kind, 'foul');
  assert.equal(f.messages.length, 1);
  const settledWrites = f.writes(), settledCards = f.cardWrites();
  await f.emit('canvasReady');
  assert.equal(f.writes(), settledWrites); assert.equal(f.cardWrites(), settledCards);
  scene.tokens.push(token('b')); await f.emit('canvasReady');
  assert.equal(f.state('hazards').tokens['Scene.scene.Token.b'].inFoul, true);
  assert.equal(f.state('hazards').requests['foul:Actor.b'].kind, 'foul');
  assert.equal(f.messages.length, 2); assert.deepEqual(f.errors, []);
});

test('initial canvas waits for game readiness before C45 reconciliation and later canvases still update holders', async () => {
  const f = await fixture({boons: {binding: {sceneId: 'scene', regionId: 'room'}, uses: {
    room: {id: 'room', kind: 'C45', actorId: 'Actor.a', at: 4000, expiresAt: 32800, choice: 'crafting', status: 'pending', holders: []}
  }}}, {ready: false});
  Object.assign(f.config, {chapter: 1, phase: 'day'});
  game.pf2e = {worldClock: {worldTime: {hour: 12, minute: 0, second: 0, isValid: true}}};
  const region = {id: 'room'}, actor = f.actors.get('a');
  const token = {actorId: 'a', actorLink: true, actor, regions: new Set([region])};
  const scene = {id: 'scene', regions: new Map([[region.id, region]]), tokens: [token]};
  game.scenes.set(scene.id, scene); game.scenes.active = scene;
  f.boons.registerBoons();
  await f.emit('canvasReady');
  assert.deepEqual(f.errors, []);
  assert.equal(f.writes(), 0); assert.equal(f.cardWrites(), 0); assert.equal(actor.items.length, 0);
  assert.equal(f.state('boons').uses.room.status, 'pending');

  game.ready = true; await f.emit('ready');
  assert.deepEqual(f.state('boons').uses.room.holders, ['Actor.a']);
  assert.equal(f.state('boons').uses.room.status, 'done'); assert.equal(actor.items.length, 1);
  const settledWrites = f.writes(); await f.emit('canvasReady');
  assert.equal(f.writes(), settledWrites); assert.equal(actor.items.length, 1);
  token.regions.clear(); await f.emit('canvasReady');
  assert.deepEqual(f.state('boons').uses.room.holders, []); assert.equal(actor.items.length, 0);
  assert.deepEqual(f.errors, []);
});
