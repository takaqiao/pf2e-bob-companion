import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeFixture,ID} from './helpers/runtime-fixture.mjs';

test('moving within an unchanged environment performs no actor reset or render',async t=>{
  const f=await runtimeFixture(t);
  f.updateToken(f.ta,{x:100,y:100,elevation:5});
  assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);
  assert.deepEqual(f.calls.actorReads,[],'a linked move must not touch synthetic actors on other scenes');
});

test('moving a synthetic token within the same environment does not reset it or unrelated actors',async t=>{
  const f=await runtimeFixture(t);
  f.updateToken(f.ts,{x:100});
  assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);
  assert.ok(!f.calls.actorReads.includes('tr'));
});

test('crossing into an indoor region updates only the moving actor and preserves night rules',async t=>{
  const f=await runtimeFixture(t);
  f.updateToken(f.ta,{x:100,regions:[{flags:{[ID]:{exposure:'indoors'}}}]});
  assert.deepEqual(f.calls.reset,['a']);assert.deepEqual(f.calls.render,['a']);
  assert.deepEqual(f.slugs(f.a),['bob-moon-fear']);
  assert.ok(f.slugs(f.b).includes('bob-weather-perception'));
  f.clear();f.updateToken(f.ta,{x:200});assert.deepEqual(f.calls.reset,[]);
});

test('moving a remote synthetic token refreshes only its own actor when exposure changes',async t=>{
  const f=await runtimeFixture(t);
  f.updateToken(f.tr,{regions:[{flags:{[ID]:{exposure:'indoors'}}}]});
  assert.deepEqual(f.calls.reset,['r']);
  assert.deepEqual(f.slugs(f.r),['bob-moon-initiative','bob-moon-holy']);
});

test('disabling rules restores the original rules once and subsequent movement does nothing',async t=>{
  const f=await runtimeFixture(t);
  f.configure({enabled:false});
  assert.deepEqual([...f.calls.reset].sort(),['a','b','r','s']);
  for(const actor of [f.a,f.b,f.s,f.r])assert.deepEqual(f.slugs(actor),['official-weather']);
  f.clear();f.updateToken(f.ta,{x:100});
  assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);assert.deepEqual(f.calls.actorReads,[]);
});

test('re-enabling rules prepares eligible actors again',async t=>{
  const f=await runtimeFixture(t);
  f.configure({enabled:false});f.clear();f.configure({enabled:true});
  assert.ok(f.slugs(f.a).includes('bob-moon-fear'));
  assert.ok(f.slugs(f.r).includes('bob-weather-perception'));
});

test('ordinary clock ticks do not refresh, but a day-night transition updates the rules',async t=>{
  const f=await runtimeFixture(t);
  f.configure({chapter:4});f.clear();game.pf2e.worldClock.worldTime.second=3;
  f.emit('updateWorldTime',3,3,{});assert.deepEqual(f.calls.reset,[]);
  game.pf2e.worldClock.worldTime.hour=10;f.emit('updateWorldTime',36000,1,{});
  assert.ok(!f.slugs(f.a).includes('bob-moon-fear'));
  assert.ok(!f.slugs(f.s).includes('bob-moon-holy'));
});

test('excluding a previously included scene removes its temporary rules',async t=>{
  const f=await runtimeFixture(t);
  f.remote.flags[ID].scope='exclude';f.emit('updateScene',f.remote,{[`flags.${ID}.scope`]:'exclude'});
  assert.deepEqual(f.slugs(f.r),['official-weather']);
});

test('changing a region exposure refreshes affected actors',async t=>{
  const f=await runtimeFixture(t),region={flags:{[ID]:{exposure:'indoors'}}};
  f.updateToken(f.ta,{regions:[region]});f.clear();
  region.flags[ID].exposure='outdoors';f.emit('updateRegion',region,{[`flags.${ID}.exposure`]:'outdoors'});
  assert.ok(f.slugs(f.a).includes('bob-weather-perception'));
});

test('multiple linked tokens with conflicting exposures clear rules and recover when unified',async t=>{
  const f=await runtimeFixture(t);
  const second=f.makeToken('second-a',f.a,true,f.main);f.emit('createToken',second);f.clear();
  f.updateToken(second,{regions:[{flags:{[ID]:{exposure:'indoors'}}}]});
  assert.deepEqual(f.calls.reset,['a']);assert.deepEqual(f.slugs(f.a),['official-weather']);
  f.clear();f.updateToken(second,{regions:[]});
  assert.deepEqual(f.calls.reset,['a']);assert.ok(f.slugs(f.a).includes('bob-weather-perception'));
});

test('removing the last linked token clears the actor’s scene rules',async t=>{
  const f=await runtimeFixture(t);
  f.main.tokens.splice(f.main.tokens.indexOf(f.ta),1);f.emit('deleteToken',f.ta);
  assert.deepEqual(f.slugs(f.a),['official-weather']);
});

test('changing a linked token actor cleans the previous actor and prepares the new actor',async t=>{
  const f=await runtimeFixture(t),replacement=f.makeActor('replacement');f.actors.push(replacement);
  f.updateToken(f.ta,{actorId:replacement.id});
  assert.deepEqual(f.slugs(f.a),['official-weather']);
  assert.ok(f.slugs(replacement).includes('bob-moon-fear'));
});

test('actor role changes replace the relevant night modifiers',async t=>{
  const f=await runtimeFixture(t);
  f.a.flags[ID]={role:'enemy'};f.emit('updateActor',f.a,{[`flags.${ID}.role`]:'enemy'});
  assert.ok(!f.slugs(f.a).includes('bob-moon-fear'));
  assert.ok(f.slugs(f.a).includes('bob-moon-holy'));
});

test('switching the active scene clears formerly placed linked actors',async t=>{
  const f=await runtimeFixture(t);f.scenes.active=f.other;
  f.emit('updateScene',f.other,{active:true});
  assert.deepEqual(f.slugs(f.a),['official-weather']);
  assert.ok(f.slugs(f.r).includes('bob-weather-perception'));
});

test('player movement has the same no-op behavior when exposure stays unchanged',async t=>{
  const f=await runtimeFixture(t);game.user.isGM=false;
  f.updateToken(f.ta,{x:100});assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);
});

test('switching actorLink cleans the former actor context in both directions',async t=>{
  const f=await runtimeFixture(t),synthetic=f.makeActor('a',true);
  synthetic.token=f.ta;f.ta.syntheticActor=synthetic;
  f.updateToken(f.ta,{actorLink:false});
  assert.deepEqual(f.slugs(f.a),['official-weather']);
  assert.ok(f.slugs(synthetic).includes('bob-weather-perception'));
  f.updateToken(f.ta,{actorLink:true});
  assert.deepEqual(f.slugs(synthetic),['official-weather']);
  assert.ok(f.slugs(f.a).includes('bob-moon-fear'));
});

test('a global change coalesced with movement retains cleanup for all affected actors',async t=>{
  const f=await runtimeFixture(t);
  Hooks.callAll('updateToken',f.ta,{x:100});
  f.remote.flags[ID].scope='exclude';
  f.emit('updateScene',f.remote,{[`flags.${ID}.scope`]:'exclude'});
  assert.deepEqual(f.slugs(f.r),['official-weather']);
});

test('native _regions updates refresh the changed actor even without a coordinate update',async t=>{
  const f=await runtimeFixture(t);
  f.ta.regions=[{id:'shelter',flags:{[ID]:{exposure:'indoors'}}}];
  f.updateToken(f.ta,{_regions:['shelter']});
  assert.deepEqual(f.calls.reset,['a']);assert.deepEqual(f.slugs(f.a),['bob-moon-fear']);
});

test('an actor never managed by this runtime does not reset when moved outside BoB scope',async t=>{
  const f=await runtimeFixture(t),outside=f.makeActor('outside');f.actors.push(outside);
  const token=f.makeToken('outside-token',outside,true,f.other);
  f.updateToken(token,{x:100});assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);
});

test('moving an unconstructed synthetic token does not construct its actor',async t=>{
  const f=await runtimeFixture(t);
  f.updateToken(f.remote.tokens.get('unconstructed'),{x:100});
  assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.actorReads,[]);
});

test('movement mixed with unrelated token flags does not refresh actors, including when rules are disabled',async t=>{
  const f=await runtimeFixture(t);
  f.updateToken(f.ta,{x:100,'flags.other-module.movementMarker':1});
  assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);
  f.configure({enabled:false});f.clear();
  f.updateToken(f.ta,{x:200,flags:{'other-module':{movementMarker:2}}});
  assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);
});

test('unrelated token, scene and region flags do not schedule global actor refreshes',async t=>{
  const f=await runtimeFixture(t);
  for(const [event,document] of [['updateToken',f.ta],['updateScene',f.main],['updateRegion',{}]]){
    for(const changes of [{'flags.other-module.value':1},{flags:{'other-module':{value:1}}},{'flags.-=other-module':null}])f.emit(event,document,changes);
  }
  assert.deepEqual(f.calls.reset,[]);assert.deepEqual(f.calls.render,[]);
});

test('native deletion forms still refresh consumed token flags and restore inherited weather',async t=>{
  const f=await runtimeFixture(t);
  for(const changes of [
    {[`flags.${ID}.-=exposure`]:null},{flags:{[ID]:{'-=exposure':null}}},
    {[`flags.-=${ID}`]:null},{flags:{[`-=${ID}`]:null}},
    {'-=flags':null},{flags:null},{flags:{}}
  ]){
    f.ta.flags={[ID]:{exposure:'indoors'}};f.runtime.refresh();f.clear();
    f.ta.flags={};f.emit('updateToken',f.ta,changes);
    assert.ok(f.slugs(f.a).includes('bob-weather-perception'),JSON.stringify(changes));
  }
});

test('deleting consumed scene or region flags still cleans up the previous rules',async t=>{
  const f=await runtimeFixture(t);
  f.remote.flags={};f.emit('updateScene',f.remote,{[`flags.-=${ID}`]:null});
  assert.deepEqual(f.slugs(f.r),['official-weather']);
  const region={flags:{[ID]:{exposure:'indoors'}}};
  f.updateToken(f.ta,{regions:[region]});assert.deepEqual(f.slugs(f.a),['bob-moon-fear']);
  region.flags={};f.emit('updateRegion',region,{flags:{[ID]:{'-=exposure':null}}});
  assert.ok(f.slugs(f.a).includes('bob-weather-perception'));
});
