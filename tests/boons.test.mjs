import test from 'node:test';
import assert from 'node:assert/strict';
import {recordBoon, consumeBoon, transferBoon, correctBoon, voidBoon, cooldownRemaining, crossedDawn, c45Active, expireBoons} from '../scripts/boon-model.mjs';
import {boonEffectData, boonRoomActors, boonBathClock, createBoonController} from '../scripts/boons.mjs';
import {translateItem} from '../scripts/i18n.mjs';

const meditate = (id, actorId, at, extra = {}) => ({id, kind:'A14', actorId, start:at-3600, at, degree:'success', cleaned:true, ...extra});

test('weekly meditation is individual, applies to all outcomes, and does not reset on clock reversal', () => {
  const state = {};
  recordBoon(state, meditate('m1','a',3600));
  assert.equal(cooldownRemaining(state,'A14','a',608399),1);
  assert.equal(cooldownRemaining(state,'A14','a',608400),0);
  assert.equal(cooldownRemaining(state,'A14','b',3600),0);
  assert.throws(() => recordBoon(state,meditate('m2','a',0)), /BOB\.Boon\.Error\.Cooldown/);
  assert.equal(state.uses.m1.bonus,1);
  assert.equal(state.uses.m1.expiresAt,90000);
  recordBoon(state,meditate('m3','b',3600,{degree:'failure',cleaned:false}));
  assert.equal(state.uses.m3.condition,'stupefied');
  assert.equal(state.uses.m3.expiresAt,90000);
});

test('meditation critical success lasts one week and explicit consumption cannot repeat', () => {
  const state = {};
  recordBoon(state,meditate('m1','a',3600,{degree:'criticalSuccess'}));
  assert.equal(state.uses.m1.bonus,2);
  assert.equal(state.uses.m1.expiresAt,608400);
  consumeBoon(state,{id:'consume1',useId:'m1',at:4000});
  consumeBoon(state,{id:'consume1',useId:'m1',at:5000});
  assert.equal(state.uses.m1.consumedAt,4000);
  assert.throws(() => consumeBoon(state,{id:'consume2',useId:'m1',at:5000}), /BOB\.Boon\.Error\.Consumed/);
});

test('bath requires one hour, uses individual weekly cooldown and crossing dawn grants only the remaining day', () => {
  const state = {};
  assert.equal(crossedDawn({start:25000,at:28600,dayStart:0,dawn:27000}),true);
  assert.equal(crossedDawn({start:28000,at:31600,dayStart:0,dawn:27000}),false);
  assert.equal(crossedDawn({start:26000,at:27000,dayStart:0,dawn:27000}),true);
  assert.throws(() => recordBoon(state,{id:'b0',kind:'A19',actorId:'a',start:0,at:3599}), /BOB\.Boon\.Error\.OneHour/);
  recordBoon(state,{id:'b1',kind:'A19',actorId:'a',start:25000,at:28600,dayStart:0,dawn:27000});
  assert.equal(state.uses.b1.expiresAt,86400);
  assert.equal(state.uses.b1.diseasePending,true);
  assert.equal(cooldownRemaining(state,'A19','a',28600),604800);
  assert.equal(cooldownRemaining(state,'A19','b',28600),0);
});

test('statues share a 24h cooldown and bonus requires bound room, daylight and 8h duration', () => {
  const state = {};
  recordBoon(state,{id:'c1',kind:'C45',actorId:'a',at:10000,choice:'crafting'});
  assert.throws(() => recordBoon(state,{id:'c2',kind:'C45',actorId:'b',at:96399,choice:'athletics'}), /BOB\.Boon\.Error\.Cooldown/);
  assert.equal(c45Active(state.uses.c1,{at:38799,inRoom:true,day:true}),true);
  for (const context of [{at:38800,inRoom:true,day:true},{at:11000,inRoom:false,day:true},{at:11000,inRoom:true,day:false},{at:9999,inRoom:true,day:true}]) {
    assert.equal(c45Active(state.uses.c1,context),false);
  }
  recordBoon(state,{id:'c3',kind:'C45',actorId:'b',at:96400,choice:'athletics'});
});

test('gear boons have one holder, transfer and one-use ledger with idempotent operation IDs', () => {
  const state = {};
  recordBoon(state,{id:'g1',kind:'G4',actorId:'a',at:10});
  recordBoon(state,{id:'g1',kind:'G4',actorId:'a',at:10});
  assert.equal(Object.keys(state.uses).length,1);
  assert.throws(() => recordBoon(state,{id:'g2',kind:'G4',actorId:'a',at:11}), /BOB\.Boon\.Error\.AlreadyHolds/);
  transferBoon(state,{id:'t1',useId:'g1',actorId:'b',at:12});
  transferBoon(state,{id:'t1',useId:'g1',actorId:'b',at:12});
  assert.equal(state.uses.g1.actorId,'b');
  assert.equal(state.uses.g1.transfers.length,1);
  assert.doesNotThrow(()=>recordBoon(state,{id:'g1',kind:'G4',actorId:'a',at:10}));
  consumeBoon(state,{id:'x1',useId:'g1',at:15});
  assert.equal(state.uses.g1.consumedAt,15);
  assert.throws(() => transferBoon(state,{id:'t2',useId:'g1',actorId:'a',at:16}), /BOB\.Boon\.Error\.Consumed/);
  recordBoon(state,{id:'g3',kind:'G4',actorId:'a',at:20});
});

test('expiry is sticky across time reversal and ordinary time updates leave state untouched', () => {
  const state = {};
  recordBoon(state,meditate('m1','a',3600));
  const before = JSON.stringify(state);
  expireBoons(state,89999);
  assert.equal(JSON.stringify(state),before);
  expireBoons(state,90000);
  assert.equal(state.uses.m1.expired,true);
  expireBoons(state,5000);
  assert.equal(state.uses.m1.expired,true);
});

test('GM corrections preserve audit and move both end and cooldown without resetting other actors', () => {
  const state = {};
  recordBoon(state,meditate('m1','a',3600));
  recordBoon(state,meditate('m2','b',3600));
  const other = JSON.stringify(state.uses.m2);
  correctBoon(state,{id:'fix1',useId:'m1',start:0,at:7200,expiresAt:100000,reason:'钟表校准'});
  assert.equal(cooldownRemaining(state,'A14','a',7200),604800);
  assert.equal(state.uses.m1.expiresAt,100000);
  assert.equal(state.uses.m1.corrections[0].reason,'钟表校准');
  assert.equal(JSON.stringify(state.uses.m2),other);
});

test('native rule payload limits meditation to Int skills and sanitizes official current effects', () => {
  const state = {};
  recordBoon(state,meditate('m1','a',3600));
  const meditation = boonEffectData(state.uses.m1);
  assert.deepEqual(meditation.system.rules.find(rule => rule.key === 'FlatModifier').selector,['int-skill-check']);
  assert.equal(meditation.system.duration.value,1440);
  assert.equal(meditation.system.duration.unit,'minutes');
  const bath = boonEffectData({id:'bath',kind:'A19',at:100,expiresAt:200,crossedDawn:true},{_id:'original',name:'secret',type:'effect',system:{description:{value:'plot',gm:'hidden'},rules:[{key:'FlatModifier',selector:['crafting'],value:1,type:'item',predicate:['action:craft']} ]}});
  assert.equal(bath._id,undefined);
  assert.equal(bath.system.description.gm,'');
  assert.equal(bath.system.description.value.includes('plot'),false);
  assert.deepEqual(bath.system.rules[0].predicate,['action:craft']);
  assert.equal(bath.system.duration.value,100/60);
  assert.equal(meditation.flags['pf2e-bob-companion'].localization.name,'Boon.Effect.Meditation.Name');
  assert.deepEqual(meditation.flags['pf2e-bob-companion'].localization.rules.map(rule=>rule.index),[1]);
  assert.equal(bath.flags['pf2e-bob-companion'].localization.description,'Boon.Effect.Bath.Description');
});

test('bath midnight and dawn come from the active clock, including a completion just after midnight', () => {
  const clock=boonBathClock({at:86400+1800,now:86400+1800,environment:{valid:true,seconds:1800,dawn:450,chapter:2}});
  assert.deepEqual(clock,{dayStart:86400,dawn:27000});
  const earlier=boonBathClock({at:86400+600,now:86400+1800,environment:{valid:true,seconds:1800,dawn:450,chapter:2}});
  assert.deepEqual(earlier,{dayStart:86400,dawn:27000});
  assert.throws(()=>boonBathClock({at:3600,now:3600,environment:{valid:false,seconds:3600,dawn:450}}),/ClockUnavailable/);
  assert.throws(()=>boonBathClock({at:3600,now:3600,environment:{valid:true,seconds:3600,dawn:NaN}}),/ClockUnavailable/);
  assert.throws(()=>boonBathClock({at:100,now:500,environment:{valid:true,seconds:300,dawn:450}}),/PreviousDay/);
});

test('owned boon item and rule note can render in each client language from saved keys', () => {
  const prior=globalThis.game;
  const messages={
    'BOB.Boon.Effect.Meditation.Name':{en:'Mental insight',zh:'心智启迪'},
    'BOB.Boon.Effect.Meditation.Description':{en:'<p>Bonus +{bonus}</p>',zh:'<p>加值 +{bonus}</p>'},
    'BOB.Boon.Effect.Meditation.NoteTitle':{en:'Insight',zh:'启迪'},
    'BOB.Boon.Effect.Meditation.NoteText':{en:'Use it once',zh:'使用一次'}
  };
  let language='en';
  globalThis.game={i18n:{format:(key,values={})=>String(messages[key]?.[language]??key).replace(/\{(\w+)\}/g,(_,name)=>values[name]??'')}};
  try {
    const data=boonEffectData({id:'one',kind:'A14',at:0,expiresAt:86400,bonus:2});
    assert.equal(data.name,'Mental insight');
    assert.equal(data.system.description.value,'<p>Bonus +2</p>');
    language='zh';translateItem(data);
    assert.equal(data.name,'心智启迪');
    assert.equal(data.system.description.value,'<p>加值 +2</p>');
    assert.equal(data.system.rules[1].title.replace(/<[^>]*>/g,''),'启迪');
    assert.equal(data.system.rules[1].text.replace(/<[^>]*>/g,''),'使用一次');
    assert.match(data.system.rules[1].title,/data-bob-i18n="BOB.Boon.Effect.Meditation.NoteTitle"/);
    assert.match(data.system.rules[1].text,/data-bob-i18n="BOB.Boon.Effect.Meditation.NoteText"/);
  } finally {globalThis.game=prior;}
});

function fixture({roomActors:roomQuery}={}) {
  let state = {}, writes = 0, creates = 0, failCreate = false, primary = true, time = 4000, day = true, members = [];
  const actors = new Map(['a','b'].map(id => [id,{id,items:[],async createEmbeddedDocuments(_type,items) {
    if (failCreate) {failCreate = false;throw new Error('document failure');}
    const docs = items.map((data,index) => ({...structuredClone(data),id:`${id}-${creates++}-${index}`}));
    this.items.push(...docs);return docs;
  },async deleteEmbeddedDocuments(_type,ids) {this.items = this.items.filter(item => !ids.includes(item.id));},
  async updateEmbeddedDocuments(_type,items) {for (const item of items) Object.assign(this.items.find(old => old.id === item._id),item);}}]));
  let tail = Promise.resolve();
  const requirePrimary = () => {if (!primary) throw new Error('primary GM');};
  const controller = createBoonController({read:() => structuredClone(state),update:async fn => {
    requirePrimary();const next = structuredClone(state);fn(next);if (JSON.stringify(state)!==JSON.stringify(next)) writes++;state=next;return structuredClone(state);
  },serialize:fn => {const result=tail.catch(()=>{}).then(fn);tail=result;return result;},requirePrimary,
  actor:id=>actors.get(id),load:async kind=>({type:kind==='G4'?'feat':'effect',system:{rules:[],description:{value:'source plot',gm:'secret'}}}),
  time:()=>time,roomActors:(binding,recalculate)=>roomQuery?roomQuery(actors,binding,recalculate):members.map(id=>actors.get(id)),environment:()=>({valid:true,night:!day}),enabled:()=>true});
  return {controller,actors,state:()=>state,writes:()=>writes,creates:()=>creates,fail:()=>{failCreate=true;},demote:()=>{primary=false;},clock:at=>{time=at;},day:value=>{day=value;},room:ids=>{members=ids;}};
}

test('a failed native creation retains the reserved cooldown and same operation retry creates only one effect', async () => {
  const f = fixture();f.fail();
  await assert.rejects(f.controller.use(meditate('m1','a',3600)),/document failure/);
  assert.equal(f.state().uses.m1.status,'pending');
  assert.equal(cooldownRemaining(f.state(),'A14','a',3600),604800);
  await f.controller.use(meditate('m1','a',3600));
  await f.controller.use(meditate('m1','a',3600));
  assert.equal(f.actors.get('a').items.length,1);
  assert.equal(f.state().uses.m1.status,'done');
});

test('concurrent duplicate grants and consumption produce one current effect and no stale transferred copy', async () => {
  const f = fixture();
  await Promise.all([f.controller.use({id:'g1',kind:'G4',actorId:'a',at:1}),f.controller.use({id:'g1',kind:'G4',actorId:'a',at:1})]);
  assert.equal(f.creates(),1);
  await f.controller.transfer({id:'t1',useId:'g1',actorId:'b',at:2});
  assert.equal(f.actors.get('a').items.length,0);
  assert.equal(f.actors.get('b').items.length,1);
  await f.controller.consume({id:'x1',useId:'g1',at:3});
  await f.controller.consume({id:'x1',useId:'g1',at:3});
  assert.equal(f.actors.get('b').items.length,0);
});

test('ordinary unchanged ticks have zero writes and do not touch unrelated actors; non-primary mutations reject', async () => {
  const f = fixture();
  await f.controller.use(meditate('m1','a',3600));
  const writes = f.writes(), creates = f.creates();
  await f.controller.tick(5000);await f.controller.tick(6000);
  assert.equal(f.writes(),writes);
  assert.equal(f.creates(),creates);
  assert.equal(f.actors.get('b').items.length,0);
  f.demote();
  await assert.rejects(f.controller.use(meditate('m2','b',7000)),/primary GM/);
});

test('temporary stupefied uses a native in-memory condition without taking ownership of pre-existing conditions', () => {
  const data=boonEffectData({id:'m',kind:'A14',actorId:'a',at:0,expiresAt:86400,condition:'stupefied'});
  assert.equal(data.system.rules[0].inMemoryOnly,true);
});

test('C45 native effect follows native membership/daylight, affects newcomers and does not write on repeated ticks', async () => {
  const f=fixture();f.room(['a']);
  await f.controller.use({id:'c',kind:'C45',actorId:'a',at:4000,choice:'crafting'});
  assert.equal(f.actors.get('a').items.length,1);
  assert.equal(f.actors.get('b').items.length,0);
  const writes=f.writes();
  await f.controller.tick(4100);await f.controller.tick(4200);
  assert.equal(f.writes(),writes);
  f.room(['b']);await f.controller.syncRoom();
  assert.equal(f.actors.get('a').items.length,0);
  assert.equal(f.actors.get('b').items.length,1);
  f.day(false);await f.controller.syncRoom();
  assert.equal(f.actors.get('b').items.length,0);
  f.day(true);f.clock(32800);await f.controller.tick(32800);
  f.clock(5000);await f.controller.tick(5000);
  assert.equal(f.actors.get('b').items.length,0);
});

test('a pending room creation is recoverable without resetting the shared cooldown', async () => {
  const f=fixture();f.room(['a','b']);f.fail();
  await assert.rejects(f.controller.use({id:'c',kind:'C45',actorId:'a',at:4000,choice:'performance'}),/document failure/);
  assert.equal(f.state().uses.c.status,'pending');
  assert.equal(cooldownRemaining(f.state(),'C45','b',4000),86400);
  await f.controller.retry('c');
  assert.equal(f.actors.get('a').items.length,1);
  assert.equal(f.actors.get('b').items.length,1);
});

test('recording an already-held official minor boon adopts it instead of creating a duplicate', async () => {
  const f=fixture();
  f.actors.get('a').items.push({id:'existing',type:'feat',name:'Native',system:{slug:'pharasma-minor-boon'}});
  await f.controller.use({id:'g',kind:'G4',actorId:'a',at:1000});
  assert.equal(f.actors.get('a').items.length,1);
  assert.equal(f.actors.get('a').items[0].id,'existing');
});

test('voiding a mistaken grant clears only its cooldown and effect and retains the correction reason', async () => {
  const f=fixture();
  await f.controller.use(meditate('m1','a',3600));
  await f.controller.use(meditate('m2','b',3600));
  await f.controller.void({id:'v',useId:'m1',at:4000,reason:'选错角色'});
  assert.equal(f.actors.get('a').items.length,0);
  assert.equal(f.actors.get('b').items.length,1);
  assert.equal(cooldownRemaining(f.state(),'A14','a',4000),0);
  assert.equal(f.state().uses.m1.voided.reason,'选错角色');
  const s=f.state();voidBoon(s,{id:'v',useId:'m1',at:4000,reason:'选错角色'});
  assert.equal(s.uses.m1.voided.reason,'选错角色');
});

test('rejecting a conflicting repeated operation ID preserves the original boon', () => {
  const s={};recordBoon(s,meditate('one','a',3600));
  assert.throws(()=>recordBoon(s,meditate('one','b',3600)),/BOB\.Boon\.Error\.OperationActorConflict/);
  assert.equal(s.uses.one.actorId,'a');
});

test('bath day calibration rejects an unrelated midnight instead of creating an incorrect-duration bonus', () => {
  const state={};
  assert.throws(()=>recordBoon(state,{id:'bath',kind:'A19',actorId:'a',start:25000,at:28600,dayStart:86400,dawn:27000}),/BOB\.Boon\.Error\.Midnight/);
  assert.equal(Object.keys(state.uses??{}).length,0);
});

test('old retained scene tokens cannot receive current room bonuses, regardless of the GM viewed scene', () => {
  let reads=0;
  const actor={id:'a',uuid:'Actor.a',type:'character'},region={id:'room'};
  const old={id:'old',regions:new Map([['room',region]]),tokens:[{regions:new Set([region]),get actor(){reads++;return actor;}}]};
  const current={id:'current',regions:new Map(),tokens:[]};
  const scenes=new Map([['old',old],['current',current]]);scenes.active=current;scenes.viewed=old;
  assert.deepEqual(boonRoomActors({sceneId:'old',regionId:'room'},{scenes}),[]);
  assert.equal(reads,0);
  scenes.active=old;scenes.viewed=current;
  assert.deepEqual(boonRoomActors({sceneId:'old',regionId:'room'},{scenes}),[actor]);
});

test('conflicting linked tokens cannot give an out-of-room token the room-wide actor bonus', () => {
  const actor={id:'a',uuid:'Actor.a',type:'character'},region={id:'room'};
  const scene={id:'current',regions:new Map([['room',region]]),tokens:[
    {actorId:'a',actorLink:true,regions:new Set([region]),actor},
    {actorId:'a',actorLink:true,regions:new Set(),actor}
  ]};
  const scenes=new Map([['current',scene]]);scenes.active=scene;
  assert.deepEqual(boonRoomActors({sceneId:'current',regionId:'room'},{scenes}),[]);
});

test('editing and deleting the bound Region immediately reconcile C45 despite stale noHook token membership', async () => {
  let inside=false,geometryCalls=0;
  const region={id:'room'},scene={id:'current',regions:new Map([['room',region]]),tokens:[]};
  const scenes=new Map([['current',scene]]);scenes.active=scene;
  const f=fixture({roomActors:(actors,binding,recalculate)=>boonRoomActors(binding,{scenes},recalculate)});
  const actor=f.actors.get('a');actor.type='character';actor.uuid='a';
  const token={actorId:'a',actorLink:true,actor,regions:new Set(),testInsideRegion(actual){assert.equal(actual,region);geometryCalls++;return inside;}};
  scene.tokens.push(token);
  await f.controller.configure({binding:{sceneId:'current',regionId:'room'}});
  await f.controller.use({id:'c45',kind:'C45',actorId:'a',at:4000,choice:'performance'});
  assert.equal(actor.items.length,0);assert.equal(geometryCalls,0);
  inside=true;
  await f.controller.syncRoom(true);
  assert.equal(actor.items.length,1);
  assert.equal(geometryCalls,1);
  // Native noHook membership catches up after the Region hook without a token hook.
  token.regions.add(region);
  const writes=f.writes();await f.controller.tick(4100);await f.controller.tick(4200);
  assert.equal(geometryCalls,1);assert.equal(f.writes(),writes);
  scene.regions.delete('room');
  await f.controller.syncRoom(true);
  assert.equal(actor.items.length,0);
  assert.equal(geometryCalls,1);
});
