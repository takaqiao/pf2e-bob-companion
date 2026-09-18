import test from 'node:test';
import assert from 'node:assert/strict';
import {environmentAt} from '../scripts/model.mjs';
import {calendarPlan} from '../scripts/weather.mjs';

const at = (chapter,minute,config={}) => calendarPlan({environment:environmentAt({chapter,seconds:minute*60,...config}),config});

test('calendar weather uses the same custom sixth-chapter rain break as the rule engine',()=>{
  for (const [minute,id] of [[599,'bob-cold-rain'],[600,'bob-cold-overcast'],[689,'bob-cold-overcast'],[690,'bob-cold-rain']]) {
    const plan=at(6,minute,{rainBreak:[600,690]});
    assert.equal(plan.valid,true);
    assert.equal(plan.zoneId,'bob-private');
    assert.equal(plan.weather?.id,id);
  }
  assert.equal(at(6,800,{rainBreak:[600,690]}).weather?.id,'bob-cold-rain');
  assert.equal(at(6,610,{rainBreak:[600,690],rain:'rain'}).weather?.id,'bob-cold-rain');
  assert.equal(at(6,710,{rain:'dry'}).weather?.id,'bob-cold-overcast');
});

test('fourth-chapter calendar fog follows rule boundaries and chapter daylight',()=>{
  for(const [minute,id,temperatureRange] of [[119,'clear',[-4,-1]],[120,'fog',[-4,-1]],[540,'fog',[3,8]],[1080,'fog',[-4,-1]],[1320,'clear',[-4,-1]]]) {
    const plan=at(4,minute);
    assert.equal(plan.weather?.id,id);
    assert.deepEqual(plan.temperatureRange,temperatureRange);
    assert.equal(plan.temperatureRequired,true);
  }
});

test('eighth-chapter snow and cold windows change only at their own boundaries',()=>{
  for(const [minute,id,range] of [[0,'bob-cold-snow',[-18,-12]],[29,'bob-cold-snow',[-18,-12]],[30,'bob-severe-thunderstorm',[-18,-12]],[359,'bob-severe-thunderstorm',[-18,-12]],[360,'bob-severe-thunderstorm',[-7,-2]],[1260,'bob-severe-thunderstorm',[-18,-12]]]) {
    const plan=at(8,minute);
    assert.equal(plan.weather?.id,id);
    assert.deepEqual(plan.temperatureRange,range);
  }
});

test('ordinary ticks and day jumps within the same weather window have a stable key',()=>{
  assert.equal(at(6,700).key,at(6,700.05).key);
  assert.equal(at(6,700).key,at(6,2140).key);
  assert.notEqual(at(6,779).key,at(6,780).key);
  assert.notEqual(at(8,359).key,at(8,360).key);
  assert.equal(at(1,700).weatherRequired,false);
  assert.equal(at(1,700).temperatureRequired,false);
});

test('chapter two clears only during its two-hour window and returns to overcast',()=>{
  assert.equal(at(2,659).weather?.id,'overcast');
  assert.equal(at(2,660).weather?.id,'clear');
  assert.equal(at(2,779).weather?.id,'clear');
  assert.equal(at(2,780).weather?.id,'overcast');
});

test('missing clock, ended storm and unsupported dry overrides fail closed',()=>{
  assert.equal(calendarPlan({environment:environmentAt({chapter:6,seconds:NaN})}).valid,false);
  assert.equal(calendarPlan({environment:{...environmentAt({chapter:9,seconds:0}),stormEnded:true}}).valid,false);
  assert.equal(at(7,700,{rain:'dry'}).valid,false);
  assert.equal(at(9,700).weather?.id,'bob-severe-thunderstorm');
  assert.deepEqual(at(9,700).temperatureRange,[-18,-12]);
});
