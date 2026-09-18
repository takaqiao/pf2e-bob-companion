import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentAt, classifyRole, nativeRules, knownSkyEffect } from '../scripts/model.mjs';

test('chapter narrative sunrise and sunset are inclusive at the correct edges across midnight', () => {
  for (const [chapter, dawn, dusk] of [[1,450,1170],[2,480,1140],[3,510,1110],[4,540,1080],[5,600,1080],[6,660,1020],[7,720,960],[8,780,900]]) {
    for (const [seconds,night] of [[dawn*60-1,true],[dawn*60,false],[dusk*60-1,false],[dusk*60,true],[0,true],[86400,true]]) {
      assert.equal(environmentAt({chapter,seconds}).night,night, `${chapter}/${seconds}`);
    }
  }
  for (const seconds of [0, 50399,50400,50401,86400,172800]) assert.equal(environmentAt({chapter:9,seconds}).night,true);
});
test('unknown time/chapter fails closed and overrides are deliberate', () => {
  assert.equal(environmentAt({chapter:0,seconds:3600}).valid,false);
  assert.equal(environmentAt({chapter:1,seconds:NaN}).valid,false);
  assert.equal(environmentAt({chapter:1,seconds:50000,phase:'night'}).night,true);
  assert.equal(environmentAt({chapter:9,seconds:50400,phase:'day'}).night,false);
});
test('fog and sixth-chapter rain break change only their own modifiers', () => {
  for (const [minute,fog] of [[119,false],[120,true],[1319,true],[1320,false],[1439,false],[0,false]]) {
    assert.equal(environmentAt({chapter:4,seconds:minute*60}).fog,fog);
  }
  for (const [minute,raining] of [[779,true],[780,false],[869,false],[870,true]]) {
    const state = environmentAt({chapter:6,seconds:minute*60});
    assert.equal(state.raining,raining);
    const rules=nativeRules({environment:state,role:'pc',exposure:'outdoors',perception:'visual'});
    assert.equal(rules.find(r=>r.slug==='bob-weather-ranged')?.value,raining ? -1 : undefined);
    assert.equal(rules.some(r=>r.slug==='bob-weather-perception'),raining);
  }
});
test('fog note follows the official 50-foot threshold and does not choose lightning victims', () => {
  const fog=nativeRules({environment:environmentAt({chapter:4,seconds:12*3600}),role:'ally',exposure:'outdoors'});
  assert.deepEqual(fog.find(r=>r.key==='Note').predicate,[{gte:['target:distance',50]}]);
});
test('identity excludes allies, neutral NPCs, player summons and conflicting dispositions', () => {
  assert.equal(classifyRole({type:'character',owned:true,alliance:'party',dispositions:[1]}),'pc');
  assert.equal(classifyRole({type:'character',owned:false,alliance:'party',dispositions:[1]}),'ally');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'opposition',dispositions:[-1]}),'enemy');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'opposition',dispositions:[0]}),'unknown');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'party',dispositions:[-1]}),'unknown');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'opposition',dispositions:[1]}),'unknown');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'opposition',dispositions:[-1,1]}),'unknown');
  assert.equal(classifyRole({type:'npc',owned:true,alliance:'opposition',dispositions:[-1]}),'ally');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'party',dispositions:[1],traits:['minion']}),'ally');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'opposition',dispositions:[-1],traits:['minion']}),'enemy');
  assert.equal(classifyRole({type:'npc',owned:false,alliance:'opposition',dispositions:[]}),'unknown');
  assert.equal(classifyRole({type:'npc',override:'enemy',dispositions:[]}),'enemy');
});
test('native rules distinguish holy/fear saves and do not penalize unrelated saves', () => {
  const environment=environmentAt({chapter:1,seconds:0});
  const enemy=nativeRules({environment,role:'enemy',exposure:'indoors'});
  assert.deepEqual(enemy.map(r=>[r.selector,r.value,r.type,r.predicate]),[
    ['initiative',1,'circumstance',undefined],['saving-throw',1,'circumstance',['item:trait:holy']]
  ]);
  const pc=nativeRules({environment,role:'pc',exposure:'indoors'});
  assert.deepEqual(pc.map(r=>[r.selector,r.value,r.predicate]),[['saving-throw',-1,['item:trait:fear']]]);
  assert.deepEqual(nativeRules({environment,role:'ally',exposure:'indoors'}),[]);
});
test('chapter9 all perception is corrected; other chapters retain visual conditional scope', () => {
  const args={role:'ally',exposure:'outdoors',perception:'auto'};
  const n=nativeRules({...args,environment:environmentAt({chapter:9,seconds:0})});
  assert.equal(n.find(r=>r.slug==='bob-weather-perception').value,-4);
  assert.equal(n.find(r=>r.slug==='bob-weather-perception').predicate,undefined);
  const e=nativeRules({...args,environment:environmentAt({chapter:8,seconds:0})});
  assert.deepEqual(e.find(r=>r.slug==='bob-weather-perception').predicate,['item:trait:visual']);
  assert.equal(e.find(r=>r.slug==='bob-weather-ranged').value,-3);
});
test('shelter and unknown exposure do not apply ungrounded weather penalties', () => {
  const environment=environmentAt({chapter:8,seconds:0});
  for (const exposure of ['unknown','indoors']) assert.deepEqual(nativeRules({environment,role:'ally',exposure}),[]);
  const rainShelter=nativeRules({environment,role:'ally',exposure:'rain-shelter',perception:'visual'});
  assert.deepEqual(rainShelter.map(r=>r.slug),['bob-weather-ranged']);
  const windShelter=nativeRules({environment,role:'ally',exposure:'wind-shelter',perception:'visual'});
  assert.deepEqual(windShelter.map(r=>r.slug),['bob-weather-perception']);
});
test('source identity detection never captures a similarly named unrelated effect', () => {
  assert.equal(knownSkyEffect({system:{slug:'effect-the-skies-above-chapter-9'}}),9);
  assert.equal(knownSkyEffect({name:'Effect: The Skies Above (Chapter 9)',system:{slug:'custom-weather'}}),null);
});
