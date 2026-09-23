import test from 'node:test';
import assert from 'node:assert/strict';

const model = await import('../scripts/soulheart-model.mjs').catch(() => ({}));
const {soulheartGrade, phantomRank, planUpgrade, runUpgrade, correctUpgrade, planLife, runLife} = model;
const native = await import('../scripts/soulhearts.mjs').catch(() => ({}));
const ID='pf2e-bob-companion';
const hpTemplate={name:'Official HP effect',type:'effect',system:{rules:[{key:'FlatModifier',selector:['hp'],value:'@item.badge.value'}],badge:{type:'counter',value:1,max:21},duration:{value:-1,unit:'unlimited'},description:{value:'Future spoilers',gm:'secret'}}};
function nativeFixture({manual=0,clock=()=>100,environment=()=>({valid:true,night:false,seconds:clock()%86400})}={}) {
  let next=0,state={};
  const actors=new Map();
  function document(data,parent) {
    const doc=structuredClone(data);doc.id??=doc._id??`doc${++next}`;doc.uuid=`Actor.${parent.id}.Item.${doc.id}`;doc.parent=parent;
    doc.update=async patch=>{for(const [path,value] of Object.entries(patch)){const keys=path.split('.');let cursor=doc;for(const key of keys.slice(0,-1)) cursor=cursor[key]??={};cursor[keys.at(-1)]=structuredClone(value);}return doc;};
    return doc;
  }
  function actor(id,type='character') {
    const actor={id,name:id,type,items:new Map(),async createEmbeddedDocuments(kind,rows){assert.equal(kind,'Item');return rows.map(row=>{const doc=document(row,actor);assert.ok(!actor.items.has(doc.id));actor.items.set(doc.id,doc);return doc;});},async deleteEmbeddedDocuments(kind,ids){for(const id of ids)actor.items.delete(id);},async toggleRollOption(domain,option,itemId,value,selection){assert.equal(domain,'all');assert.equal(option,'support-rank');const rule=actor.items.get(itemId).system.rules[0];rule.value=value;rule.selection=selection;}};
    actors.set(id,actor);return actor;
  }
  const holder=actor('holder');holder.items.set('heart',document(item(),holder));
  const ghost=actor('phantom','npc');ghost.items.set('manifest',document(phantom(0).items[0],ghost));
  for(const id of ['pc1','pc2']) {const pc=actor(id);if(manual)pc.items.set('existing',document({...hpTemplate,_id:'existing',flags:{core:{sourceId:'Item.mE0lIeDPfDvm7Qhy'}},system:{...hpTemplate.system,badge:{type:'counter',value:manual,max:null}}},pc));}
  const port=native.makeSoulheartPort({read:()=>structuredClone(state),save:async mutate=>{const next=structuredClone(state);mutate(next);state=next;return structuredClone(next);},actor:id=>actors.get(id),load:async uuid=>uuid===native.SOULHEART_LIFE_SOURCE?{type:'effect',system:{rules:[{key:'TempHP',value:6}],description:{value:''}}}:structuredClone(hpTemplate),assertGM:()=>{},time:clock,environment});
  return {port,actors,state:()=>state,plan:()=>planUpgrade({...context(),beneficiaries:['pc1','pc2'].map(id=>({id,effect:native.findHPEffect(actors.get(id))})),state})};
}
const item = (grade = 'ordinary', quantity = 2) => ({id:'heart', uuid:'Actor.holder.Item.heart', type:'equipment', system:{slug:{ordinary:'soulheart',greater:'soulheart-greater',major:'soulheart-major'}[grade],quantity}});
const phantom = rank => ({id:'phantom',items:[{id:'manifest',type:'action',system:{rules:[{key:'RollOption',option:'support-rank',toggleable:true,value:rank>0,selection:String(rank||1),suboptions:[{value:'1'},{value:'2'},{value:'3'}]}]}}]});
const context = (grade='ordinary', rank=0) => ({id:'op1',holderId:'holder',item:item(grade),phantom:phantom(rank),beneficiaries:[{id:'pc1',effect:null},{id:'pc2',effect:null}],state:{},time:100});
function fixture() {
  const db = {itemQuantity:2,rank:0,hp:{pc1:0,pc2:0},state:{},effects:{},events:[],fail:null};
  const port = {
    read: () => structuredClone(db.state),
    save: async mutate => {const next=structuredClone(db.state);mutate(next);db.state=next;db.events.push('save');return structuredClone(next);},
    preflight: async () => {},
    apply: async (op,step,undo=false) => {
      assert.ok(db.state.operations[op.id], 'pending receipt must exist before document mutation');
      const key=`${undo?'undo:':''}${step}`;
      if (db.fail===key) {db.fail=null;throw new Error('simulated document failure');}
      if(step==='quantity') db.itemQuantity=undo?op.quantityBefore:op.quantityAfter;
      else if(step==='rank') db.rank=undo?op.rankBefore:op.rankAfter;
      else {const pc=op.beneficiaries.find(pc=>`hp:${pc.id}`===step);db.hp[pc.id]=undo?pc.before:op.totalAfter;}
      db.events.push(key);
    },
    checkCorrection: async op => {
      if(db.itemQuantity!==op.quantityAfter || db.rank!==op.rankAfter) throw new Error('document changed');
      for(const pc of op.beneficiaries) if(db.hp[pc.id]!==op.totalAfter) throw new Error('document changed');
    }
  };
  return {db,port};
}

test('soulhearts feature exports are implemented',()=>assert.equal(typeof soulheartGrade,'function'));
test('the operation form offers only holders with recognized, usable soulhearts',()=>{
  const valid={id:'valid',items:new Map([['one',{...item(),system:{slug:'soulheart',quantity:1}}]])};
  const exhausted={id:'exhausted',items:new Map([['empty',{...item(),system:{slug:'soulheart',quantity:0}}]])};
  const other={id:'other',items:new Map([['sword',{...item(),system:{slug:'sword',quantity:3}}]])};
  assert.deepEqual(native.soulheartEligibleHolders([valid,exhausted,other]).map(actor=>actor.id),['valid']);
  assert.deepEqual(native.soulheartEligibleItems(valid).map(row=>row.id),['heart']);
  assert.deepEqual(native.soulheartEligibleHolders([exhausted,other]),[]);
});
test('confirmation uses the displayed proposal only while selections match',()=>{
  const shown={id:'shown',quantityAfter:1};
  assert.equal(native.displayedProposal(shown,'holder:heart:phantom:pc1','holder:heart:phantom:pc1'),shown);
  assert.throws(()=>native.displayedProposal(shown,'holder:heart:phantom:pc1','holder:heart:phantom:pc2'),/ErrorSelectionChanged/);
  assert.throws(()=>native.displayedProposal(null,'same','same'),/ErrorSelectionChanged/);
});
test('mixed existing and new beneficiaries each see their actual HP catch-up in the same preview',()=>{
  const previous=globalThis.game;
  globalThis.game={i18n:{format:(key,values)=>key==='BOB.Soulheart.BeneficiaryPreview'?`${values.actor}: HP bonus ${values.before} → ${values.after}`:key}};
  try {
    const op=planUpgrade({...context(),beneficiaries:[{id:'existing',effect:{id:'old',value:20}},{id:'new',effect:null}],state:{total:20}});
    const html=native.beneficiaryPreviewHTML(op,id=>({existing:'Existing PC',new:'New PC'}[id]));
    assert.match(html,/Existing PC: HP bonus 20 → 21/);
    assert.match(html,/New PC: HP bonus 0 → 21/);
    assert.equal((html.match(/<li>/g)??[]).length,2);
  } finally {globalThis.game=previous;}
});
test('baseline sync discloses catch-up for each selected character even when the ledger stays unchanged',()=>{
  const previous=globalThis.game;
  globalThis.game={i18n:{format:(key,values)=>key==='BOB.Soulheart.BeneficiaryPreview'?`${values.actor}: HP bonus ${values.before} → ${values.after}`:key}};
  try {
    const op=model.planHPSync({id:'sync-preview',beneficiaries:[{id:'existing',effect:{id:'old',value:20}},{id:'new',effect:null}],state:{total:20},time:100});
    const html=native.beneficiaryPreviewHTML(op,id=>id);
    assert.equal(op.totalBefore,op.totalAfter);
    assert.match(html,/existing: HP bonus 20 → 20/);
    assert.match(html,/new: HP bonus 0 → 20/);
  } finally {globalThis.game=previous;}
});
test('a completed expired life retry displays its no-grant notice instead of a granted HP record',()=>{
  const previous=globalThis.game;
  globalThis.game={actors:new Map([['holder',{name:'Holder'}]]),i18n:{format:(key,values)=>{
    if(key==='BOB.Soulheart.RecordLifeAttempt')return `${values.actor}: Bolster Life attempt`;
    if(key==='BOB.Soulheart.NoticeExpired')return 'Expired; no temporary HP was granted.';
    return key;
  }}};
  try {
    const html=native.soulheartRecordHTML({kind:'life',holderId:'holder',temporaryHP:6,createdAt:100,notice:'Soulheart.NoticeExpired'});
    assert.match(html,/Holder: Bolster Life attempt/);
    assert.match(html,/Expired; no temporary HP was granted/);
    assert.doesNotMatch(html,/Holder: 6 temporary HP/);
  } finally {globalThis.game=previous;}
});
test('only exact source, exact slug, or explicit GM binding identifies an actual equipment item',()=>{
  assert.equal(soulheartGrade(item()),'ordinary');
  assert.equal(soulheartGrade({...item(),system:{slug:'not-a-soulheart'},name:'Greater Soulheart'}),null);
  assert.equal(soulheartGrade({...item(),system:{slug:null},_stats:{compendiumSource:'Compendium.pf2e.equipment-srd.Item.05h3LWflr74iJiVg'}}),'major');
  assert.equal(soulheartGrade({...item(),system:{slug:'custom'}},'greater'),'greater');
  assert.equal(soulheartGrade({...item(),system:{slug:'soulheart-pure'}}),null);
});
test('all three grades require the exact rank and award literal 1/2/3 HP',()=>{
  for(const [grade,rank,total] of [['ordinary',0,1],['greater',1,2],['major',2,3]]) {
    const op=planUpgrade(context(grade,rank));
    assert.equal(op.rankAfter,rank+1);assert.equal(op.totalAfter,total);assert.equal(op.quantityAfter,1);
  }
  assert.equal(phantomRank(phantom(0)).rank,0);
  assert.throws(()=>planUpgrade(context('greater',0)),/ErrorRequiredRank/);
  assert.throws(()=>planUpgrade({...context(),item:item('ordinary',0)}),/ErrorQuantity/);
  assert.throws(()=>planUpgrade({...context(),beneficiaries:[]}),/ErrorBeneficiaries/);
});
test('adopts existing manual HP as visible baseline and never caps complete award at 21',()=>{
  const op=planUpgrade({...context('major',2),beneficiaries:[{id:'pc1',effect:{id:'manual',value:21}},{id:'pc2',effect:{id:'other',value:20}}]});
  assert.equal(op.totalBefore,21);assert.equal(op.totalAfter,24);
  assert.deepEqual(op.beneficiaries.map(pc=>pc.before),[21,20]);
});
test('cancelling confirmation changes neither state nor documents',async()=>{
  const {db,port}=fixture();await runUpgrade(port,planUpgrade(context()),false);
  assert.deepEqual(db.state,{});assert.equal(db.itemQuantity,2);assert.equal(db.events.length,0);
});
test('persisted operation survives failed rank mutation and retry never consumes or awards twice',async()=>{
  const {db,port}=fixture(),op=planUpgrade(context());db.fail='rank';
  await assert.rejects(runUpgrade(port,op,true),/simulated/);
  assert.equal(db.itemQuantity,1);assert.equal(db.state.operations.op1.status,'pending');
  await runUpgrade(port,op,true);await runUpgrade(port,op,true);
  assert.equal(db.itemQuantity,1);assert.equal(db.rank,1);assert.deepEqual(db.hp,{pc1:1,pc2:1});
  assert.equal(db.events.filter(x=>x==='quantity').length,1);assert.equal(db.state.total,1);
});
test('another pending operation cannot interleave with a partial upgrade',async()=>{
  const {db,port}=fixture();db.fail='rank';await assert.rejects(runUpgrade(port,planUpgrade(context()),true));
  await assert.rejects(runUpgrade(port,planUpgrade({...context(),id:'op2'}),true),/ErrorPending/);
});
test('correction restores only the latest exact operation and survives partial correction',async()=>{
  const {db,port}=fixture(),op=planUpgrade(context());await runUpgrade(port,op,true);db.fail='undo:rank';
  await assert.rejects(correctUpgrade(port,'op1'),/simulated/);
  await correctUpgrade(port,'op1');await correctUpgrade(port,'op1');
  assert.equal(db.itemQuantity,2);assert.equal(db.rank,0);assert.deepEqual(db.hp,{pc1:0,pc2:0});assert.equal(db.state.total,0);
});
test('correction refuses subsequent document changes or a later completed award',async()=>{
  const {db,port}=fixture(),op=planUpgrade(context());await runUpgrade(port,op,true);db.itemQuantity=8;
  await assert.rejects(correctUpgrade(port,'op1'),/changed/);assert.equal(db.itemQuantity,8);
  db.itemQuantity=1;db.state.lastCompleted='later';await assert.rejects(correctUpgrade(port,'op1'),/ErrorLaterAward/);
});
test('Bolster Life uses grade and day/night values with an 8-hour effect and does not consume',()=>{
  for(const [grade,day,night] of [['ordinary',6,3],['greater',12,6],['major',18,9]]) {
    assert.equal(planLife({id:'life',holderId:'holder',item:item(grade),phase:'day',time:100,seconds:100}).temporaryHP,day);
    const op=planLife({id:'life',holderId:'holder',item:item(grade),phase:'night',time:100,seconds:100});
    assert.equal(op.temporaryHP,night);assert.equal(op.expiresAt,28900);assert.equal(op.resetAt,86400);
  }
});
test('daily item cooldown persists through backward time and resets only at its saved next midnight',()=>{
  const ctx={id:'life',holderId:'holder',item:item(),phase:'day',time:200,seconds:200,lastUse:{id:'old',usedAt:100,resetAt:86400}};
  assert.throws(()=>planLife(ctx),/ErrorDailyUsed/);assert.throws(()=>planLife({...ctx,time:0}),/ErrorDailyUsed/);
  assert.equal(planLife({...ctx,time:86400,seconds:0}).temporaryHP,6);
});
test('native mutation uses one official unlimited badge per PC and reuses an adopted effect',async()=>{
  const f=nativeFixture({manual:21}),op=f.plan();await runUpgrade(f.port,op,true);
  for(const id of ['pc1','pc2']) {
    const actor=f.actors.get(id);assert.equal(actor.items.size,1);
    const effect=actor.items.get('existing');assert.equal(effect.system.badge.value,22);assert.equal(effect.system.badge.max,null);
    assert.doesNotMatch(effect.system.description.value,/Future|spoilers/);assert.equal(effect.system.description.gm,'');
    assert.deepEqual(effect.flags[ID].localization,{name:'Soulheart.HPEffectName',description:'Soulheart.HPEffectDescription',values:{value:22}});
  }
  assert.equal(f.actors.get('holder').items.get('heart').system.quantity,1);
  assert.equal(phantomRank(f.actors.get('phantom')).rank,1);
});
test('native retry recognizes a successful item write whose acknowledgement was interrupted',async()=>{
  const f=nativeFixture(),heart=f.actors.get('holder').items.get('heart'),update=heart.update;let interrupted=true;
  heart.update=async patch=>{await update(patch);if(interrupted){interrupted=false;throw new Error('acknowledgement lost');}};
  const op=f.plan();await assert.rejects(runUpgrade(f.port,op,true),/lost/);await runUpgrade(f.port,op,true);
  assert.equal(heart.system.quantity,1);assert.equal(f.actors.get('pc1').items.size,1);
});
test('native correction protects subsequent item changes and never deletes an adopted reward',async()=>{
  const f=nativeFixture({manual:3}),op=f.plan();await runUpgrade(f.port,op,true);
  const heart=f.actors.get('holder').items.get('heart');heart.system.quantity=5;
  await assert.rejects(correctUpgrade(f.port,op.id),/ErrorStale/);heart.system.quantity=1;
  await correctUpgrade(f.port,op.id);
  assert.equal(f.actors.get('pc1').items.get('existing').system.badge.value,3);assert.equal(heart.system.quantity,2);
});
test('missing native HP template fails before consuming the actual item',async()=>{
  const f=nativeFixture(),op=f.plan();const port=native.makeSoulheartPort({...f.port,actor:id=>f.actors.get(id),load:async()=>{throw new Error('missing official asset');},assertGM:()=>{}});
  await assert.rejects(runUpgrade(port,op,true),/missing/);assert.equal(f.actors.get('holder').items.get('heart').system.quantity,2);assert.deepEqual(f.state(),{});
});
test('stale preview refuses changes to quantity, rank or ledger before any side effects',async()=>{
  const f=nativeFixture(),op=f.plan();f.actors.get('holder').items.get('heart').system.quantity=9;
  await assert.rejects(runUpgrade(f.port,op,true),/ErrorStale/);assert.deepEqual(f.state(),{});
});
test('duplicate existing HP effects are rejected for GM reconciliation',()=>{
  const f=nativeFixture({manual:2}),actor=f.actors.get('pc1');actor.items.set('duplicate',{...actor.items.get('existing'),id:'duplicate'});
  assert.throws(()=>native.findHPEffect(actor),/ErrorMultipleHPEffects/);
});
test('native temporary HP effect retains TempHP machinery but removes choices and hidden description',()=>{
  const template={type:'effect',system:{rules:[{key:'ChoiceSet',prompt:'Future reward'},{key:'TempHP',value:'@item.flags.example'}],description:{value:'Future spoiler'}}};
  const result=native.lifeEffectData(template,{id:'life',holderId:'pc1',temporaryHP:12,createdAt:100,expiresAt:28900});
  assert.deepEqual(result.system.rules,[{key:'TempHP',value:12}]);assert.equal(result.system.duration.unit,'hours');assert.equal(result.system.duration.value,8);assert.equal(result.system.start.value,100);
  assert.doesNotMatch(result.system.description.value,/Future/);
  assert.deepEqual(result.flags[ID].localization,{name:'Soulheart.LifeEffectName',description:'Soulheart.LifeEffectDescription',values:{value:12}});
});
test('daily activation retries a lost effect acknowledgement without a second effect or item consumption',async()=>{
  const f=nativeFixture(),heart=f.actors.get('holder').items.get('heart');
  const op=planLife({id:'life',holderId:'holder',item:heart,phase:'day',time:100,seconds:100});
  const apply=f.port.applyLife;let interrupted=true;
  f.port.applyLife=async (op,step)=>{await apply(op,step);if(step==='effect'&&interrupted){interrupted=false;throw new Error('lost acknowledgement');}};
  await assert.rejects(runLife(f.port,op,true),/lost/);
  await runLife(f.port,op,true);await runLife(f.port,op,true);
  assert.equal(heart.system.quantity,2);assert.equal(f.actors.get('holder').items.size,2);
  assert.equal(heart.flags[ID].soulheartDaily.resetAt,86400);assert.equal(f.state().operations.life.status,'complete');
});
test('the persisted transaction, not changed caller data, defines retry recipients',async()=>{
  const {db,port}=fixture(),op=planUpgrade(context());db.fail='rank';await assert.rejects(runUpgrade(port,op,true));
  await runUpgrade(port,{...op,beneficiaries:[]},true);
  assert.deepEqual(db.hp,{pc1:1,pc2:1});
});
test('new PCs can adopt the complete party HP ledger without consuming an item or changing rank',async()=>{
  const f=nativeFixture();await f.port.save(state=>{state.total=24;});
  const op=model.planHPSync({id:'sync',beneficiaries:[{id:'pc1',effect:null}],state:f.state(),time:100});
  await runUpgrade(f.port,op,true);
  assert.equal(native.findHPEffect(f.actors.get('pc1')).value,24);assert.equal(f.actors.get('holder').items.get('heart').system.quantity,2);
  assert.equal(phantomRank(f.actors.get('phantom')).rank,0);
  await correctUpgrade(f.port,op.id);assert.equal(f.actors.get('pc1').items.size,0);assert.equal(f.state().total,24);
});
test('GM manual baseline cannot reduce a previously earned reward',()=>{
  assert.throws(()=>model.planHPSync({id:'sync',beneficiaries:[{id:'pc1',effect:{id:'old',value:9}}],baseline:3,state:{total:7},time:100}),/ErrorBaselineDecrease/);
});
test('ordinary players cannot open the GM soulheart choices',async()=>{
  const oldGame=globalThis.game;globalThis.game={user:{isGM:false}};
  try {await assert.rejects(native.openSoulhearts(),/ErrorGMOnly/);}finally{globalThis.game=oldGame;}
});
test('canonical source wins over an inconsistent slug and narrative soulhearts cannot be bound for consumption',()=>{
  assert.equal(soulheartGrade({...item(),_stats:{compendiumSource:'Compendium.pf2e.equipment-srd.Item.05h3LWflr74iJiVg'}}),'major');
  assert.equal(soulheartGrade({...item(),system:{slug:'soulheart-pure',quantity:1}},'ordinary'),null);
  assert.equal(soulheartGrade({...item(),_stats:{compendiumSource:'Compendium.pf2e.equipment-srd.Item.Y10KCgi8mOL2iAkS'}},'major'),null);
});
test('native HP effect acknowledgement failure does not create a duplicate on retry',async()=>{
  const f=nativeFixture(),op=f.plan(),apply=f.port.apply;let interrupt=true;
  f.port.apply=async (...args)=>{await apply(...args);if(args[1]==='hp:pc1'&&interrupt){interrupt=false;throw new Error('effect acknowledgement lost');}};
  await assert.rejects(runUpgrade(f.port,op,true),/lost/);await runUpgrade(f.port,op,true);
  assert.equal(f.actors.get('pc1').items.size,1);assert.equal(native.findHPEffect(f.actors.get('pc1')).value,1);
});
test('losing primary GM during effect loading prevents the subsequent document mutation',async()=>{
  const f=nativeFixture(),op=f.plan();let allowed=true;
  const port=native.makeSoulheartPort({...f.port,actor:id=>f.actors.get(id),assertGM:()=>{if(!allowed)throw new Error('not primary GM');},load:async()=>{allowed=false;return structuredClone(hpTemplate);}});
  await assert.rejects(port.apply(op,'hp:pc1'),/primary/);assert.equal(f.actors.get('pc1').items.size,0);
});
test('delayed temporary HP retry preserves absolute expiry when PF2e replaces the start time',async()=>{
  let time=100;const f=nativeFixture({clock:()=>time}),heart=f.actors.get('holder').items.get('heart'),op=planLife({id:'delayed',holderId:'holder',item:heart,phase:'day',time,seconds:time});
  const apply=f.port.applyLife;let fail=true;
  f.port.applyLife=async (op,step)=>{if(step==='effect'&&fail){fail=false;throw new Error('network unavailable');}await apply(op,step);};
  await assert.rejects(runLife(f.port,op,true),/network/);time=500;await runLife(f.port,op,true);
  const effect=[...f.actors.get('holder').items.values()].find(effect=>effect.type==='effect');
  const seconds=effect.system.duration.value*(effect.system.duration.unit==='hours'?3600:60);
  assert.equal(time+seconds,28900);
});
test('resolved native Bolster Life no longer depends on removed grade ChoiceSet predicates',()=>{
  const template={type:'effect',system:{description:{value:''},rules:[
    {key:'ChoiceSet',flag:'soulheart'},
    {key:'TempHP',predicate:['soulheart:soulheart'],value:6},
    {key:'TempHP',predicate:['soulheart:soulheart-greater'],value:12},
    {key:'TempHP',predicate:['soulheart:soulheart-major'],value:18}
  ]}};
  const data=native.lifeEffectData(template,{id:'resolved',temporaryHP:9,createdAt:100,expiresAt:28900});
  assert.deepEqual(data.system.rules,[{key:'TempHP',value:9}]);
});

test('uncommitted Bolster Life preview crossing day/night is rejected before daily use or effects',async()=>{
  let night=false;
  const f=nativeFixture({environment:()=>({valid:true,night,seconds:100})}),heart=f.actors.get('holder').items.get('heart');
  const op=planLife({id:'boundary',holderId:'holder',item:heart,phase:'day',time:100,seconds:100});
  night=true;
  await assert.rejects(runLife(f.port,op,true),/ErrorLifeStale/);
  assert.deepEqual(f.state(),{});assert.equal(heart.flags?.[ID]?.soulheartDaily,undefined);
  assert.equal(f.actors.get('holder').items.size,1);
});

test('uncommitted Bolster Life preview crossing midnight is rejected even when the phase remains night',async()=>{
  let time=86399;
  const f=nativeFixture({clock:()=>time,environment:()=>({valid:true,night:true,seconds:time%86400})}),heart=f.actors.get('holder').items.get('heart');
  const op=planLife({id:'midnight',holderId:'holder',item:heart,phase:'night',time,seconds:86399});
  time=86400;
  await assert.rejects(runLife(f.port,op,true),/ErrorLifeStale/);
  assert.deepEqual(f.state(),{});assert.equal(heart.flags?.[ID]?.soulheartDaily,undefined);
});

test('reserved Bolster Life retry retains its original day value after dusk',async()=>{
  let time=100,night=false;
  const f=nativeFixture({clock:()=>time,environment:()=>({valid:true,night,seconds:time})}),heart=f.actors.get('holder').items.get('heart');
  const op=planLife({id:'reserved',holderId:'holder',item:heart,phase:'day',time,seconds:time});
  const apply=f.port.applyLife;let fail=true;
  f.port.applyLife=async(operation,step)=>{if(step==='effect'&&fail){fail=false;throw new Error('connection failed');}await apply(operation,step);};
  await assert.rejects(runLife(f.port,op,true),/connection/);
  night=true;time=200;
  await runLife(f.port,{...op,phase:'night',temporaryHP:3},true);
  const effect=[...f.actors.get('holder').items.values()].find(effect=>effect.type==='effect');
  assert.equal(effect.system.rules[0].value,6);
  assert.equal(f.state().operations.reserved.phase,'day');
  assert.equal(heart.flags[ID].soulheartDaily.resetAt,86400);
});
