import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAssistantCore,readState,updateState,withAction,isPrimaryGM,whisperGM,partyMembers,loadEffect} from '../scripts/assistant-core.mjs';

function fixture(){
  let state={},writes=0;const messages=[];const gm={id:'gm',isGM:true,active:true};
  const users=Object.assign([gm,{id:'player',isGM:false,active:true}],{activeGM:gm});
  globalThis.game={user:gm,users,time:{worldTime:100},actors:Object.assign([],{party:null}),settings:{register(){},get(){return state;},async set(_id,_key,value){await new Promise(r=>setTimeout(r,2));state=structuredClone(value);writes++;return value;}},modules:new Map([['pf2e-bob-companion',{api:{existing:true}}]])};
  globalThis.ChatMessage={async create(message){messages.push(message);return message;}};
  return {get state(){return state;},get writes(){return writes;},messages};
}
test('empty state is isolated and no-op updates do not write',async()=>{const f=fixture();registerAssistantCore();const copy=readState('nightmares');copy.x=1;assert.deepEqual(readState('nightmares'),{});await updateState('nightmares',()=>{});assert.equal(f.writes,0);});
test('concurrent domains preserve fresh state and defensive copies',async()=>{const f=fixture();await Promise.all([updateState('a',s=>{s.value=1;}),updateState('b',s=>{s.value=2;})]);assert.deepEqual(f.state.a,{value:1});assert.deepEqual(f.state.b,{value:2});assert.equal(f.writes,2);const copy=readState('a');copy.value=10;assert.equal(readState('a').value,1);});
test('players and secondary GMs cannot mutate or execute actions',async()=>{const f=fixture();game.user=game.users[1];assert.equal(isPrimaryGM(),false);await assert.rejects(updateState('x',s=>{s.x=1;}));await assert.rejects(withAction('test',()=>true));game.user={id:'second',isGM:true,active:true};await assert.rejects(updateState('x',s=>{s.x=1;}));assert.equal(f.writes,0);});
test('failure releases action queue and failed mutation writes nothing',async()=>{const f=fixture();await assert.rejects(updateState('x',s=>{s.x=1;throw Error('stop');}));assert.equal(f.writes,0);const order=[];await Promise.allSettled([withAction('x',async()=>{order.push(1);throw Error('stop');}),withAction('x',async()=>{order.push(2);})]);assert.deepEqual(order,[1,2]);await updateState('x',s=>{s.x=2;});assert.equal(readState('x').x,2);});
test('asynchronous state mutators are rejected before a write',async()=>{const f=fixture();await assert.rejects(updateState('x',async s=>{s.x=1;}));assert.equal(f.writes,0);});
test('GM messages have explicit private recipients',async()=>{const f=fixture();await whisperGM('<p>本次待办</p>');assert.deepEqual(f.messages[0].whisper,['gm']);});
test('party fallback excludes NPC and unowned characters',()=>{fixture();const pc={type:'character',hasPlayerOwner:true};game.actors.push(pc,{type:'npc',hasPlayerOwner:true},{type:'character',hasPlayerOwner:false});assert.deepEqual(partyMembers(),[pc]);game.actors.party={members:[pc,{type:'npc'}]};assert.deepEqual(partyMembers(),[pc]);});
test('effect loader returns independent source without original id',async()=>{fixture();const source={_id:'original',name:'Effect',type:'effect',system:{rules:[]}};globalThis.fromUuid=async()=>({toObject:()=>structuredClone(source)});const effect=await loadEffect('Item.source');assert.equal(effect._id,undefined);effect.name='New';assert.equal(source.name,'Effect');globalThis.fromUuid=async()=>null;await assert.rejects(loadEffect('Item.missing'));});
