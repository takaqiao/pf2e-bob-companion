import test from 'node:test';
import assert from 'node:assert/strict';
import * as uiState from '../scripts/ui-state.mjs';
const cfg = () => ({enabled:true,chapter:0,phase:'auto',rain:'auto',weather:true,stormEnded:false,rainBreak:[780,870]});

test('failed saves retain edits, and later save preserves another GM unrelated change', async () => {
  assert.equal(typeof uiState.RuleDraft,'function');
  const draft=new uiState.RuleDraft(cfg());
  draft.set('phase','night');
  await assert.rejects(draft.save(() => cfg(),async () => {throw new Error('offline');}),/offline/);
  assert.equal(draft.dirty,true);
  let saved;
  await draft.save(() => ({...cfg(),weather:false}),async value => {saved=value;});
  assert.equal(saved.phase,'night');
  assert.equal(saved.weather,false);
  assert.equal(draft.dirty,false);
});

test('same field changed by another GM is not silently overwritten',async () => {
  assert.equal(typeof uiState.RuleDraft,'function');
  const draft=new uiState.RuleDraft(cfg());draft.set('phase','night');
  let writes=0;
  await assert.rejects(draft.save(() => ({...cfg(),phase:'day'}),async () => {writes++;}),/其他 GM/);
  assert.equal(writes,0);assert.equal(draft.dirty,true);assert.equal(draft.value.phase,'night');
});

test('edits typed while a save is in flight remain as an unsaved draft',async () => {
  const draft=new uiState.RuleDraft(cfg());draft.set('phase','night');
  let finish,submitted;
  const saving=draft.save(cfg,value=>{submitted=structuredClone(value);return new Promise(resolve=>{finish=resolve;});});
  draft.set('phase','day');draft.set('rain','dry');
  finish();await saving;
  assert.equal(submitted.phase,'night');assert.equal(submitted.rain,'auto');
  assert.equal(draft.base.phase,'night');
  assert.equal(draft.value.phase,'day');assert.equal(draft.value.rain,'dry');assert.equal(draft.dirty,true);
  await draft.save(()=>submitted,async value=>{submitted=value;});
  assert.equal(submitted.phase,'day');assert.equal(submitted.rain,'dry');assert.equal(draft.dirty,false);
});

test('rain break validation rejects malformed, overnight and out of bounds times without losing draft',async () => {
  assert.equal(typeof uiState.RuleDraft,'function');
  for(const range of [[780,800],[1380,30],[1500,1590],[NaN,870]]) {
    const draft=new uiState.RuleDraft(cfg());draft.set('rainBreak',range);
    await assert.rejects(draft.save(cfg,async () => assert.fail('must not write invalid times')),/停雨/);
    assert.equal(draft.dirty,true);
  }
});

test('rule labels identify target and expose conditions rather than pretending all modifiers apply', () => {
  assert.equal(typeof uiState.describeRule,'function');
  assert.deepEqual(uiState.describeRule({selector:'perception',value:-2,label:'风暴',predicate:['item:trait:visual']}),
    {target:'察觉',value:'−2',source:'风暴',condition:'仅视觉检定；普通察觉需指定视觉方式',conditional:true});
  assert.equal(uiState.describeRule({selector:'saving-throw',value:1,predicate:['item:trait:holy']}).target,'圣洁豁免');
  assert.equal(uiState.describeRule({selector:'ranged-strike-attack-roll',value:-4}).target,'远程打击');
});
