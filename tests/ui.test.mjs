import test from 'node:test';
import assert from 'node:assert/strict';
import * as panel from '../scripts/ui.mjs';

test('batch exposure writes only selected token flags and never reads actors',async t=>{
  const oldGame=globalThis.game;globalThis.game={user:{isGM:true}};t.after(()=>{globalThis.game=oldGame;});
  assert.equal(typeof panel.applyExposure,'function');
  const updates=[];
  const tokens=['a','b'].map(id=>({id,get actor(){assert.fail('exposure must not read actors');},async setFlag(namespace,key,value){updates.push([id,namespace,key,value]);}}));
  await panel.applyExposure(tokens,'indoors');
  assert.deepEqual(updates,[['a','pf2e-bob-companion','exposure','indoors'],['b','pf2e-bob-companion','exposure','indoors']]);
  await assert.rejects(panel.applyExposure(tokens,'invalid'),/环境/);
  assert.equal(updates.length,2);
});

test('player cannot batch change environment',async t=>{
  const oldGame=globalThis.game;globalThis.game={user:{isGM:false}};t.after(()=>{globalThis.game=oldGame;});
  assert.equal(typeof panel.applyExposure,'function');
  await assert.rejects(panel.applyExposure([{setFlag(){assert.fail('player must not write');}}],'outdoors'),/GM/);
});

test('failed native dialog submission restores buttons so edits can be retried',async () => {
  assert.equal(typeof panel.createEditorDialog,'function');
  const save={disabled:false},other={disabled:true};
  class NativeDialog {async _onSubmit(){save.disabled=true;throw new Error('write failed');}}
  const Editor=panel.createEditorDialog(NativeDialog),editor=new Editor();
  editor.element={querySelectorAll:()=>[save,other]};
  assert.equal(await editor._onSubmit(),editor);
  assert.equal(save.disabled,false);assert.equal(other.disabled,true);
});

test('region editor keeps its original scene when the GM views a different scene',async t=>{
  const oldCanvas=globalThis.canvas;t.after(()=>{globalThis.canvas=oldCanvas;});
  let change;
  const exposure={value:'unknown'},region={value:'room',addEventListener(_event,fn){change=fn;}};
  const source={regions:new Map([['room',{flags:{'pf2e-bob-companion':{exposure:'indoors'}}}]])};
  globalThis.canvas={scene:{regions:new Map([['room',{flags:{'pf2e-bob-companion':{exposure:'outdoors'}}}]])}};
  class NativeDialog {async _onRender(){}}
  const Editor=panel.createEditorDialog(NativeDialog,source),editor=new Editor();
  editor.element={querySelector:selector=>selector.includes('regionId')?region:exposure};
  await editor._onRender({},{});change();assert.equal(exposure.value,'indoors');
});

test('open console preserves drafts on status refresh, coalesces clock minutes and removes hooks on close',async t=>{
  const keys=['game','canvas','foundry','Hooks','ui','setTimeout','clearTimeout'];
  const previous=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const key of keys)previous[key]?Object.defineProperty(globalThis,key,previous[key]):delete globalThis[key];});
  const hooks=new Map(),timers=new Map();let seq=0,calendarReads=0;
  const cfg={enabled:true,chapter:9,phase:'auto',rain:'auto',weather:true,stormEnded:false,rainBreak:[780,870]};
  const nodes=new Map();
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',disabled:false,hidden:false,addEventListener(){},classList:{toggle(){}}});return nodes.get(selector);};
  const element={isConnected:true,addEventListener(){},querySelector:node,querySelectorAll(){return [];}};
  class Application {constructor(){this.element=element;this.rendered=false;} async render(){this.rendered=true;this._replaceHTML(await this._renderHTML(),node('content'));await this._onRender({},{});return this;}async _onRender(){}async close(){this.rendered=false;return this;}bringToFront(){}}
  globalThis.foundry={applications:{api:{ApplicationV2:Application,DialogV2:{confirm:async()=>true}}}};
  globalThis.Hooks={on(name,fn){const id=++seq;hooks.set(id,{name,fn});return id;},off(name,id){assert.equal(hooks.get(id)?.name,name);hooks.delete(id);}};
  globalThis.setTimeout=fn=>{const id=++seq;timers.set(id,fn);return id;};globalThis.clearTimeout=id=>timers.delete(id);
  globalThis.canvas={tokens:{controlled:[]},scene:{name:'主岛'}};
  globalThis.ui={notifications:{warn(){}}};
  const worldTime={isValid:true,hour:23,minute:0,second:0};
  globalThis.game={ready:false,user:{isGM:true},get actors(){assert.fail('opening or refreshing must not enumerate actors');},
    pf2e:{worldClock:{worldTime}},settings:{get(){return cfg;}},modules:new Map([['pf2e-bob-companion',{api:{getCalendarStatus(){calendarReads++;return {available:false,label:'未安装日历'};}}}]])};
  const consolePanel=await panel.openPanel();
  consolePanel.draft.set('phase','day');
  await consolePanel.act('refresh');
  assert.equal(consolePanel.draft.value.phase,'day');assert.equal(consolePanel.draft.dirty,true);
  const initialReads=calendarReads;
  const tick=[...hooks.values()].find(hook=>hook.name==='updateWorldTime').fn;
  const setting=[...hooks.values()].find(hook=>hook.name==='updateSetting').fn;
  const moving=[...hooks.values()].find(hook=>hook.name==='updateToken').fn;
  for(let second=1;second<60;second++){worldTime.second=second;setting({key:'core.time'});moving({id:'unselected-token'},{x:second});tick();}
  assert.equal(timers.size,0);assert.equal(calendarReads,initialReads);
  worldTime.minute=1;tick();tick();assert.equal(timers.size,1);
  for(const [id,fn] of timers){timers.delete(id);fn();}
  assert.equal(calendarReads,initialReads+2);
  assert.ok(hooks.size>0);await consolePanel.close({discard:true});assert.equal(hooks.size,0);assert.equal(timers.size,0);
});
