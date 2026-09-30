import test from 'node:test';
import assert from 'node:assert/strict';
import {ID} from '../scripts/model.mjs';
import {upsertGMCard, registerCardActions, registerChatCards} from '../scripts/chat-cards.mjs';

const hooks = new Map();
globalThis.Hooks = {on(name, callback) { hooks.set(name, callback); }};
registerChatCards();

function fixture() {
  const gm = {id:'gm', isGM:true, active:true};
  const users = Object.assign([gm, {id:'second', isGM:true, active:true}, {id:'player', isGM:false}], {activeGM:gm});
  const messages = [];
  let creates = 0, updates = 0;
  globalThis.game = {user:gm, users, messages};
  globalThis.ChatMessage = {async create(data) {
    await new Promise(resolve => setTimeout(resolve, 2));
    creates++;
    const message = {...structuredClone(data), id:`message-${creates}`, async update(changes) {
      Object.assign(this, structuredClone(changes));
      updates++;
      return this;
    }};
    messages.push(message);
    return message;
  }};
  globalThis.ui = {notifications:{error() {}}};
  return {messages, get creates() { return creates; }, get updates() { return updates; }};
}

function button(action='apply') {
  const listeners = new Map();
  return {dataset:{bobCardAction:action, actor:'actor-1'}, disabled:false,
    addEventListener(name, listener) { listeners.set(name, listener); },
    click() { return listeners.get('click')?.({preventDefault() {}}); }};
}

function render(message, buttons) {
  hooks.get('renderChatMessageHTML')(message, {querySelectorAll() { return buttons; }});
}

test('concurrent card refreshes create one private message and unchanged refreshes do not write', async () => {
  const f = fixture();
  const data = {domain:'test', id:'rest-1', content:'<p>Pending</p>'};
  const [first, second] = await Promise.all([upsertGMCard(data), upsertGMCard(data)]);
  assert.equal(first, second);
  assert.equal(f.creates, 1);
  assert.equal(f.updates, 0);
  assert.deepEqual(first.whisper, ['gm', 'second']);
  assert.deepEqual(first.flags[ID].chatCard, {domain:'test', id:'rest-1'});
  await upsertGMCard({...data, content:'<p>Ready</p>'});
  assert.equal(f.updates, 1);
  assert.equal(first.content, '<p>Ready</p>');
  await upsertGMCard({...data, content:'<p>Ready</p>'});
  assert.equal(f.updates, 1);
});

test('deleted cards are recreated; player and secondary GM refreshes cannot create cards', async () => {
  const f = fixture();
  const data = {domain:'test', id:'rest-2', content:'Pending'};
  await upsertGMCard(data);
  f.messages.splice(0);
  await upsertGMCard(data);
  assert.equal(f.creates, 2);
  game.user = game.users[1];
  await assert.rejects(upsertGMCard(data));
  game.user = game.users[2];
  await assert.rejects(upsertGMCard(data));
  assert.equal(f.creates, 2);
});

test('card routing ignores foreign messages and prevents repeat clicks while an action runs', async () => {
  fixture();
  let calls = 0, release;
  registerCardActions('routing', async ({action, id, actorId}) => {
    assert.equal(action, 'apply');
    assert.equal(id, 'rest-3');
    assert.equal(actorId, 'actor-1');
    calls++;
    await new Promise(resolve => { release = resolve; });
  });
  const data = {domain:'routing', id:'rest-3', content:'Pending'};
  const message = await upsertGMCard(data);
  const apply = button();
  render({id:'foreign', flags:{}}, [apply]);
  await apply.click();
  assert.equal(calls, 0);
  render(message, [apply]);
  const first = apply.click();
  await apply.click();
  assert.equal(calls, 1);
  assert.equal(apply.disabled, true);
  const refreshed = button();
  render(message, [refreshed]);
  assert.equal(refreshed.disabled, true);
  release();
  await first;
  assert.equal(apply.disabled, false);
  assert.equal(refreshed.disabled, false);
  game.user = game.users[1];
  render(message, [apply]);
  assert.equal(apply.disabled, true);
  await apply.click();
  assert.equal(calls, 1);
});

test('a failed action releases its buttons for a retry', async () => {
  fixture();
  let calls = 0;
  registerCardActions('retry', async () => { calls++; if (calls === 1) throw Error('Try again'); });
  const message = await upsertGMCard({domain:'retry', id:'one', content:'Pending'});
  const apply = button();
  render(message, [apply]);
  await apply.click();
  assert.equal(apply.disabled, false);
  await apply.click();
  assert.equal(calls, 2);
});
