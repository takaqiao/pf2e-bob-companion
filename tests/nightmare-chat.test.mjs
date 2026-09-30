import test from 'node:test';
import assert from 'node:assert/strict';
import * as nightmares from '../scripts/nightmares.mjs';
import {initializeNightmares, queueRest, confirmRest, reserveResult, finishResult} from '../scripts/nightmare-model.mjs';
import {registerChatCards} from '../scripts/chat-cards.mjs';
import {readCatalog} from './helpers/localization.mjs';

const ID = 'pf2e-bob-companion';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const state = {}; initializeNightmares(state, {chapter: 1, alreadyHandled: false, at: 0});
  let root = {nightmares: state}, sequence = 0, writes = 0;
  const hooks = {};
  globalThis.Hooks = {on: (name, fn) => {(hooks[name] ??= []).push(fn);}, once: (name, fn) => {(hooks[name] ??= []).push(fn);}, callAll() {}};
  const emit = async (name, ...args) => {for (const fn of hooks[name] ?? []) await fn(...args); await tick(); await tick();};
  const makeActor = (id, name) => {
    const items = []; items.get = id => items.find(item => item.id === id);
    const actor = {id, name, type: 'character', hasPlayerOwner: true, isOwner: true, items,
      getCondition: slug => items.find(item => item.slug === slug && item.active !== false),
      createEmbeddedDocuments: async (_type, data) => {const created = data.map(source => ({...structuredClone(source), id: `item-${++sequence}`, parent: actor})); items.push(...created); return created;},
      deleteEmbeddedDocuments: async (_type, ids) => {for (const id of ids) {const index = items.findIndex(item => item.id === id); if (index >= 0) items.splice(index, 1);}}
    };
    actor.saves = {will: {roll: async options => {
      assert.equal(options.skipDialog, true);
      assert.equal(options.dc.visible, false);
      const message = await ChatMessage.create({speaker: {actor: id}, flags: {pf2e: {context: {type: 'saving-throw', options: options.extraRollOptions, outcome: 'failure'}}}});
      await emit('createChatMessage', message, {});
      return {total: 12};
    }}};
    return actor;
  };
  const actors = [makeActor('a', 'Alpha'), makeActor('b', 'Beta')];
  const actorCollection = new Map(actors.map(actor => [actor.id, actor]));
  actorCollection.contents = actors; actorCollection.party = {members: actors};
  const users = [{id: 'gm', isGM: true, active: true}, {id: 'other-gm', isGM: true, active: false}]; users.activeGM = users[0];
  const messages = []; messages.get = id => messages.find(message => message.id === id);
  globalThis.game = {user: users[0], users, actors: actorCollection, messages, time: {worldTime: 100}, modules: new Map([[ID, {api: {}}]]),
    settings: {get: (_module, key) => key === 'assistantState' ? structuredClone(root) : key === 'campaign' ? {activeArea: {chapter: 1}} : {enabled: true},
      set: async (_module, _key, value) => {writes++; root = structuredClone(value);}}
  };
  globalThis.ChatMessage = {getSpeaker: ({actor}) => ({actor: actor.id}), create: async data => {
    const message = {...data, id: `message-${++sequence}`, update: async changes => {writes++; Object.assign(message, changes); return message;}};
    writes++; messages.push(message); return message;
  }};
  globalThis.fromUuid = async () => ({type: 'effect', toObject: () => ({name: 'Official phobia', type: 'effect', system: {rules: [], description: {value: ''}}})});
  const errors = []; globalThis.ui = {notifications: {error: error => errors.push(error)}};
  return {actors, emit, messages, errors, state: () => root.nightmares, seed: mutate => mutate(root.nightmares), writes: () => writes,
    card: id => messages.find(message => message.flags?.[ID]?.chatCard?.domain === 'nightmares' && message.flags[ID].chatCard.id === id)};
}

test('native rest, saves and application stay in actionable GM cards', async t => {
  const f = fixture(); registerChatCards(); nightmares.registerNightmares();
  await t.test('old marked save requests hide saved DC text and follow the player language', async () => {
    const viewer = game.user;
    game.user = {isGM:false};
    const paragraph = {tagName:'P',innerHTML:'Alpha：请进行当前意志豁免（DC 20）。'};
    const button = {previousElementSibling:paragraph,innerHTML:'意志豁免',addEventListener(){}};
    const element = {querySelectorAll:selector=>selector==='[data-bob-nightmare-roll]'?[button]:[]};
    const message = {flags:{[ID]:{nightmareRequest:{actorId:'a',sessionId:'old-rest',dc:20}}}};
    try {
      for (const lang of ['en','zh-cn']) {
        const catalog = await readCatalog(lang);
        game.i18n = {format:(key,values={})=>(catalog[key]??key).replace(/\{(\w+)\}/g,(_m,key)=>values[key]??'')};
        await f.emit('renderChatMessageHTML',message,element);
        assert.doesNotMatch(paragraph.innerHTML,/DC|20/);
        assert.match(paragraph.innerHTML,lang==='en'?/make a Will save/:/意志豁免/);
        assert.match(button.innerHTML,lang==='en'?/Will save/:/意志豁免/);
      }
      game.actors.delete('a');
      paragraph.innerHTML = 'Deleted sleeper DC 20';
      await f.emit('renderChatMessageHTML',message,element);
      assert.doesNotMatch(paragraph.innerHTML,/DC|20/);
      assert.equal(button.disabled,true);
      game.actors.set('a',f.actors[0]);
      paragraph.innerHTML = 'Unrelated request DC 20';
      await f.emit('renderChatMessageHTML',{flags:{}},element);
      assert.equal(paragraph.innerHTML,'Unrelated request DC 20');
    } finally {game.actors.set('a',f.actors[0]);game.user=viewer;delete game.i18n;}
  });
  const click = async (card, action, dataset = {}, scope) => {
    let callback;
    const button = {disabled: false, dataset: {bobCardAction: action, ...dataset}, closest: () => scope,
      addEventListener: (_name, listener) => {callback = listener;}};
    await f.emit('renderChatMessageHTML', card, {querySelectorAll: selector => selector === '[data-bob-card-action]' ? [button] : []});
    assert.equal(typeof callback, 'function');
    await callback({preventDefault() {}}); await tick();
    return button;
  };
  const acquireFear = async (id, value = 2) => {
    const actor = f.actors[1]; actor.items.splice(0);
    f.seed(state => {
      queueRest(state, {id, actorIds: ['b'], at: 100}); confirmRest(state, {id, actorIds: ['b'], chapter: 5, flatTotal: 1});
      reserveResult(state, {id, actorId: 'b', outcome: 'failure'}); finishResult(state, {id, actorId: 'b'});
      delete state.characters.b.frightenedAction; delete state.characters.b.frightenedProposal;
    });
    let updates = 0;
    const condition = {id: `${id}-condition`, parent: actor, type: 'condition', slug: 'frightened', active: true, flags: {}, system: {value: {value}}, get value() {return this.system.value.value;},
      update: async data => {updates++; condition.system.value.value = data['system.value.value']; condition.flags[ID] = {nightmareFrightened: data[`flags.${ID}.nightmareFrightened`]};}}
    actor.items.push(condition); await nightmares.recordNightmareFrightened({actorId: 'b', conditionId: condition.id});
    return {actor, condition, proposal: structuredClone(f.state().characters.b.frightenedProposal), updates: () => updates};
  };
  await t.test('completed native rest batch creates one actionable private card and leaves sleepers unconfirmed', async () => {
    const native = (id, actor) => ({id, speaker: {actor}, flags: {[ID]: {nightmareRest: {id: 'party-rest', at: 100}}}});
    await f.emit('createChatMessage', native('rest-a', 'a'), {});
    await f.emit('createChatMessage', native('rest-b', 'b'), {});
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(f.state().sessions['party-rest'].status, 'pending');
    const card = f.card('party-rest'); assert.ok(card);
    assert.deepEqual(card.whisper, ['gm', 'other-gm']);
    assert.match(card.content, /data-bob-card-action="confirm"/);
    assert.match(card.content, /data-bob-nightmare-sleeper/);
    const writes = f.writes();
    await nightmares.recordNativeRest({id: 'party-rest', at: 100, actorIds: ['a', 'b'], messageIds: ['rest-a', 'rest-b']});
    assert.equal(f.writes(), writes);
  });
  await t.test('sleep confirmation publishes neutral player requests and captured reroll updates the same GM card', async () => {
    assert.equal(typeof nightmares.refreshNightmareCard, 'function');
    const id = f.card('party-rest').id;
    await click(f.card('party-rest'), 'confirm', {}, {querySelectorAll: () => [{value: 'a'}], querySelector: () => null});
    const request = f.messages.find(message => message.flags?.[ID]?.nightmareRequest?.sessionId === 'party-rest');
    assert.ok(request); assert.equal(request.whisper, undefined);
    assert.equal(request.flags[ID].nightmareRequest.dc, undefined);
    assert.match(request.content, /NeutralSaveRequest/);
    const roll = (id, outcome, isReroll = false) => ({id, speaker: {actor: 'a'}, flags: {pf2e: {context: {type: 'saving-throw', outcome, isReroll, options: ['bob-nightmare:party-rest']}}}});
    await f.emit('createChatMessage', roll('original', 'criticalFailure'), {});
    assert.match(f.card('party-rest').content, /OutcomeCriticalFailure/);
    assert.match(f.card('party-rest').content, /data-bob-card-action="apply"/);
    await f.emit('createChatMessage', roll('reroll', 'success', true), {});
    assert.equal(f.card('party-rest').id, id);
    assert.match(f.card('party-rest').content, /OutcomeSuccess/);
    assert.equal(f.card('party-rest').content.includes('OutcomeCriticalFailure'), false);
    assert.equal(f.card('party-rest').content.includes('<select'), false);
  });
  await t.test('Apply rejects an absent save or stale card and repeated application creates effects once', async () => {
    assert.equal(typeof nightmares.applyNightmareResults, 'function');
    f.seed(state => {queueRest(state, {id: 'no-roll', actorIds: ['b'], at: 100}); confirmRest(state, {id: 'no-roll', actorIds: ['b'], chapter: 2});});
    await assert.rejects(nightmares.applyNightmareResults({id: 'no-roll'}), /RecordedSaveRequired/);
    await assert.rejects(nightmares.applyNightmareResults({id: 'party-rest', proposals: {a: 'original'}}), /ProposalChanged/);
    assert.equal(f.state().sessions['party-rest'].results.a, undefined);
    await click(f.card('party-rest'), 'apply', {proposals: JSON.stringify({a: 'reroll'})});
    await nightmares.applyNightmareResults({id: 'party-rest', proposals: {a: 'reroll'}});
    assert.equal(f.state().sessions['party-rest'].results.a.outcome, 'success');
    assert.equal(f.actors[0].items.length, 0);
    assert.match(f.card('party-rest').content, /Settled/);
    await f.emit('createChatMessage', {id: 'too-late', speaker: {actor: 'a'}, flags: {pf2e: {context: {type: 'saving-throw', outcome: 'criticalFailure', isReroll: true, options: ['bob-nightmare:party-rest']}}}}, {});
    assert.equal(f.state().sessions['party-rest'].results.a.outcome, 'success');
  });
  await t.test('GM batch rolling uses native saves without repeated modifier dialogs', async () => {
    assert.equal(typeof nightmares.rollNightmareSaves, 'function');
    await nightmares.rollNightmareSaves({id: 'no-roll'});
    assert.equal(f.state().sessions['no-roll'].suggestions.b.outcome, 'failure');
    await nightmares.applyNightmareResults({id: 'no-roll'});
    assert.equal(f.actors[1].items.length, 0);
    assert.equal(f.state().characters.b.pending.sessionId, 'no-roll');
  });
  await t.test('a reroll queued before reservation makes a waiting Apply reject its stale snapshot', async () => {
    f.seed(state => {queueRest(state, {id: 'queued-apply', actorIds: ['a'], at: 100}); confirmRest(state, {id: 'queued-apply', actorIds: ['a'], chapter: 3}); state.sessions['queued-apply'].suggestions = {a: {outcome: 'criticalFailure', messageId: 'queued-first'}};});
    const save = game.settings.set;
    let release, entered;
    const gate = new Promise(resolve => {release = resolve;});
    const started = new Promise(resolve => {entered = resolve;});
    game.settings.set = async (...args) => {entered(); await gate; return save(...args);};
    const reroll = f.emit('createChatMessage', {id: 'queued-reroll', speaker: {actor: 'a'}, flags: {pf2e: {context: {type: 'saving-throw', outcome: 'success', isReroll: true, options: ['bob-nightmare:queued-apply']}}}}, {});
    await started;
    const application = nightmares.applyNightmareResults({id: 'queued-apply', proposals: {a: 'queued-first'}});
    const rejection = assert.rejects(application, /ProposalChanged/);
    release(); await reroll; await rejection; game.settings.set = save;
    assert.equal(f.state().sessions['queued-apply'].results.a, undefined);
    assert.equal(f.actors[0].items.length, 0);
  });
  await t.test('critical failure Apply creates one phobia and a deleted card recovers without applying again', async () => {
    f.seed(state => {queueRest(state, {id: 'phobia-apply', actorIds: ['a'], at: 100}); confirmRest(state, {id: 'phobia-apply', actorIds: ['a'], chapter: 4}); state.sessions['phobia-apply'].suggestions = {a: {outcome: 'criticalFailure', messageId: 'phobia-roll'}};});
    const card = await nightmares.refreshNightmareCard('phobia-apply');
    await click(card, 'apply', {proposals: JSON.stringify({a: 'phobia-roll'})});
    await click(card, 'apply', {proposals: JSON.stringify({a: 'phobia-roll'})});
    assert.equal(f.actors[0].items.length, 1);
    assert.equal(f.actors[0].items[0].flags[ID].nightmare.kind, 'phobia');
    assert.equal(f.state().characters.a.pending.sessionId, 'phobia-apply');
    f.messages.splice(f.messages.indexOf(card), 1);
    const recovered = await nightmares.refreshNightmareCard('phobia-apply');
    assert.notEqual(recovered.id, card.id);
    assert.match(recovered.content, /Settled/);
    assert.equal(f.actors[0].items.length, 1);
  });
  await t.test('new frightened acquisition prompts once while existing fright and numeric edits do not', async () => {
    assert.equal(typeof nightmares.recordNightmareFrightened, 'function');
    const actor = f.actors[1];
    const condition = {id: 'fresh-fear', parent: actor, type: 'condition', slug: 'frightened', active: true, flags: {}, system: {value: {value: 1}}, get value() {return this.system.value.value;},
      update: async data => {condition.system.value.value = data['system.value.value']; condition.flags[ID] = {nightmareFrightened: data[`flags.${ID}.nightmareFrightened`]};}}
    actor.items.push(condition);
    await f.emit('createItem', condition);
    const card = f.messages.find(message => message.flags?.[ID]?.chatCard?.domain === 'nightmare-frightened'); assert.ok(card);
    assert.deepEqual(card.whisper, ['gm', 'other-gm']); assert.equal(condition.value, 1);
    const writes = f.writes(); await f.emit('createItem', condition); assert.equal(f.writes(), writes);
    await f.emit('updateItem', condition, {'system.value.value': 2}); assert.equal(f.writes(), writes);
    const duplicate = {...condition, id: 'duplicate-fear'}; actor.items.push(duplicate);
    await f.emit('createItem', duplicate); assert.equal(f.writes(), writes);
    actor.items.pop();
    const proposal = {sessionId: 'no-roll', conditionId: 'fresh-fear', value: 1};
    condition.active = false;
    await assert.rejects(nightmares.consumeNightmareFrightened({actorId: 'b', actionId: 'inactive-fear', proposal}), /ProposalChanged/);
    assert.equal(f.state().characters.b.frightenedAction, undefined);
    condition.active = true;
    await click(card, 'apply', {proposal: JSON.stringify(proposal)});
    await click(card, 'apply', {proposal: JSON.stringify(proposal)});
    assert.equal(condition.value, 2); assert.equal(f.state().characters.b.pending.consumed, true);
  });
  await t.test('decayed fright needs explicit snapshot review, and double review applies only one increase', async () => {
    const gain = await acquireFear('decayed-fear'); gain.condition.system.value.value = 1;
    await f.emit('updateItem', gain.condition, {'system.value.value': 1});
    const liveCard = f.messages.find(message => message.flags?.[ID]?.chatCard?.domain === 'nightmare-frightened');
    assert.match(liveCard.content, /use-current/);
    assert.equal(f.state().characters.b.frightenedProposal.value, 2);
    await assert.rejects(nightmares.consumeNightmareFrightened({actorId: 'b', actionId: 'decayed-apply', proposal: gain.proposal}), /ProposalChanged/);
    const card = await nightmares.refreshNightmareFearCard('b');
    assert.match(card.content, /data-bob-card-action="use-current"/);
    assert.equal(card.content.includes('data-bob-card-action="apply"'), false);
    await click(card, 'use-current', {proposal: JSON.stringify(gain.proposal), currentValue: '1'});
    assert.equal(f.state().characters.b.frightenedProposal.value, 1);
    const writes = f.writes();
    await nightmares.reviewNightmareFrightenedValue({actorId: 'b', proposal: gain.proposal, value: 1});
    assert.equal(f.writes(), writes);
    const reviewed = structuredClone(f.state().characters.b.frightenedProposal);
    await click(card, 'apply', {proposal: JSON.stringify(reviewed)});
    await click(card, 'apply', {proposal: JSON.stringify(reviewed)});
    assert.equal(gain.condition.value, 2); assert.equal(gain.updates(), 1);
  });
  await t.test('removed or replaced fright can be explicitly marked handled without retargeting the new condition', async () => {
    const gain = await acquireFear('replaced-fear'); gain.actor.items.splice(0);
    await f.emit('deleteItem', gain.condition);
    assert.match(f.messages.find(message => message.flags?.[ID]?.chatCard?.domain === 'nightmare-frightened').content, /FearConditionMissing/);
    const replacement = {id: 'new-fright', type: 'condition', slug: 'frightened', active: true, value: 4}; gain.actor.items.push(replacement);
    const card = await nightmares.refreshNightmareFearCard('b');
    assert.match(card.content, /FearConditionMissing/);
    assert.match(card.content, /data-bob-card-action="confirm-handled"/);
    assert.equal(card.content.includes('data-bob-card-action="apply"'), false);
    await click(card, 'confirm-handled', {proposal: JSON.stringify(gain.proposal)});
    await nightmares.acknowledgeNightmareFrightened({actorId: 'b', proposal: gain.proposal});
    assert.equal(replacement.value, 4); assert.equal(gain.updates(), 0);
    assert.equal(f.state().characters.b.pending.consumed, true);
    assert.equal(f.state().characters.b.frightenedProposal.resolution, 'confirmed-handled');
    assert.match(card.content, /FearHandled/);
  });
  await t.test('partial native write cannot be rebased, and removed-source recovery preserves its original receipt', async () => {
    const gain = await acquireFear('interrupted-fear'), save = game.settings.set;
    let writes = 0; game.settings.set = async (...args) => {if (++writes === 2) throw Error('commit interrupted'); return save(...args);};
    const actionId = `fear-${gain.proposal.sessionId}-${gain.proposal.conditionId}`;
    await assert.rejects(nightmares.consumeNightmareFrightened({actorId: 'b', actionId, proposal: gain.proposal}), /commit interrupted/);
    game.settings.set = save; assert.equal(gain.condition.value, 3);
    const receipt = structuredClone(f.state().characters.b.frightenedAction);
    gain.condition.system.value.value = 1;
    assert.equal(typeof nightmares.reviewNightmareFrightenedValue, 'function');
    await assert.rejects(nightmares.reviewNightmareFrightenedValue({actorId: 'b', proposal: gain.proposal, value: 1}), /RecoverFrightened/);
    assert.deepEqual(f.state().characters.b.frightenedAction, receipt);
    gain.actor.items.splice(0); gain.actor.items.push({id: 'replacement-after-write', type: 'condition', slug: 'frightened', active: true, value: 4});
    const card = await nightmares.refreshNightmareFearCard('b'); assert.match(card.content, /confirm-handled/);
    await click(card, 'confirm-handled', {proposal: JSON.stringify(gain.proposal)});
    await nightmares.acknowledgeNightmareFrightened({actorId: 'b', proposal: gain.proposal});
    const completed = f.state().characters.b.frightenedAction;
    assert.equal(completed.id, receipt.id); assert.equal(completed.before, 2); assert.equal(completed.target, 3); assert.equal(completed.status, 'complete');
    assert.equal(gain.actor.items[0].value, 4); assert.equal(gain.updates(), 1);
  });
  await t.test('native write followed by decay and retry settles the receipt without another increase', async () => {
    const gain = await acquireFear('written-decayed-fear'), save = game.settings.set;
    let writes = 0; game.settings.set = async (...args) => {if (++writes === 2) throw Error('commit interrupted'); return save(...args);};
    const actionId = `fear-${gain.proposal.sessionId}-${gain.proposal.conditionId}`;
    await assert.rejects(nightmares.consumeNightmareFrightened({actorId: 'b', actionId, proposal: gain.proposal}), /commit interrupted/);
    game.settings.set = save; gain.condition.system.value.value = 1;
    const card = await nightmares.refreshNightmareFearCard('b'); assert.match(card.content, /RetryFear/);
    assert.equal(card.content.includes('use-current'), false);
    await click(card, 'apply', {proposal: JSON.stringify(gain.proposal)});
    await nightmares.acknowledgeNightmareFrightened({actorId: 'b', proposal: gain.proposal});
    await nightmares.reviewNightmareFrightenedValue({actorId: 'b', proposal: gain.proposal, value: 1});
    assert.equal(gain.condition.value, 1); assert.equal(gain.updates(), 1);
    assert.equal(f.state().characters.b.frightenedAction.target, 3); assert.equal(f.state().characters.b.frightenedAction.status, 'complete');
  });
  await t.test('unrelated native events and ordinary time ticks add no state or chat writes', async () => {
    const writes = f.writes();
    await f.emit('updateWorldTime', 101);
    await f.emit('createChatMessage', {id: 'ordinary-save', flags: {pf2e: {context: {type: 'saving-throw', outcome: 'failure', options: []}}}, speaker: {actor: 'a'}}, {});
    await f.emit('createItem', {type: 'effect', parent: f.actors[0]});
    assert.equal(f.writes(), writes);
  });
});
