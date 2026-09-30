import test from 'node:test';
import assert from 'node:assert/strict';
import {t, markLocalized, translateItem, localizeHTML, translateHTML, preferredActor} from '../scripts/i18n.mjs';
import * as presentation from '../scripts/i18n.mjs';
import {readCatalog} from './helpers/localization.mjs';
import {readFile,readdir} from 'node:fs/promises';

test('unrevealed boon icons use neutral presentation while stored artwork remains intact', async () => {
  const catalog = await readCatalog('en');
  globalThis.game = {user:{isGM:false},i18n:{format:(key,values={}) => (catalog[key] ?? key).replace(/\{(\w+)\}/g,(_match,key) => values[key] ?? '')}};
  const source = {name:'Pharasma boon',img:'systems/pf2e/icons/deities/pharasma.webp',type:'feat',
    flags:{'pf2e-bob-companion':{boon:{id:'private-gear'}}},
    system:{slug:'pharasma-minor-boon',rules:[],description:{value:'Future boon use'}}};
  const item = {...structuredClone(source),_source:structuredClone(source)};
  translateItem(item);
  assert.equal(item.img,'systems/pf2e/icons/default-icons/effect.svg');
  assert.deepEqual(item._source,source);
});

const catalog={en:{'BOB.Test.Name':'Health bonus','BOB.Test.Description':'<p>Maximum HP +{hp}.</p>'},'zh-cn':{'BOB.Test.Name':'生命值提升','BOB.Test.Description':'<p>最大生命值 +{hp}。</p>'}};
function language(lang){globalThis.game={i18n:{lang,format:(key,values)=>Object.entries(values??{}).reduce((text,[key,value])=>text.replaceAll(`{${key}}`,String(value)),catalog[lang][key]??key)}};}
test('owned item presentation follows each client without editing stored data',()=>{
  language('zh-cn');
  const data=markLocalized({name:'old',system:{description:{value:'old',gm:''}},flags:{other:{keep:true}}},{name:'Test.Name',description:'Test.Description',values:{hp:6}});
  const item={...structuredClone(data),_source:structuredClone(data)};
  language('en');translateItem(item);
  assert.equal(item.name,'Health bonus');assert.equal(item.system.description.value,'<p>Maximum HP +6.</p>');
  assert.equal(item._source.name,'生命值提升');assert.equal(item.flags.other.keep,true);
});
test('chat marker escapes attributes and formats values',()=>{
  language('en');const html=localizeHTML('Test.Description',{hp:'<b>6</b>"'});
  assert.ok(!html.includes('<b>6</b>'));assert.ok(html.includes('data-bob-i18n='));
  assert.ok(html.startsWith('<div '));
});
test('unmarked documents are unchanged',()=>{language('en');const item={name:'Custom',system:{description:{value:'My text'}}};translateItem(item);assert.equal(item.name,'Custom');});
test('selection prefers a controlled eligible actor',()=>{
  const actors=[{id:'a'},{id:'b'}];globalThis.canvas={tokens:{controlled:[{actor:actors[1]}]}};
  assert.equal(preferredActor(actors)?.id,'b');assert.equal(preferredActor([actors[0]])?.id,'a');assert.equal(preferredActor([]),null);
});

test('English and Chinese catalogs have matching keys and placeholders',async()=>{
  const en=await readCatalog('en'),zh=await readCatalog('zh-cn');
  assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());
  const parameters=text=>[...text.matchAll(/\{([\w]+)\}/g)].map(match=>match[1]).sort();
  for(const key of Object.keys(en)){
    assert.ok(en[key].trim(),key);assert.ok(zh[key].trim(),key);
    assert.deepEqual(parameters(en[key]),parameters(zh[key]),key);
  }
});
test('literal translation calls and owned effect metadata resolve in the shipped catalogs',async()=>{
  const catalog=await readCatalog();
  for(const file of await readdir(new URL('../scripts/',import.meta.url))){
    if(!file.endsWith('.mjs'))continue;
    const source=await readFile(new URL(`../scripts/${file}`,import.meta.url),'utf8');
    for(const [,key] of source.matchAll(/['"]((?:BOB\.)?(?:Common|Environment|Rule|Weather|Calendar|Chapter|Hub|Hazard|UI|Soulheart|Nightmare|Boon)\.[A-Za-z][\w.]+)['"]/g)){
      const full=key.startsWith('BOB.')?key:`BOB.${key}`;
      assert.ok(catalog[full],`${file}: ${full}`);
    }
  }
});
test('legacy owned effects localize without changing their source or granting anything',async()=>{
  const catalog=await readCatalog();globalThis.game={i18n:{format:(key,values={})=>(catalog[key]??key).replace(/\{(\w+)\}/g,(_m,k)=>values[k]??'')}};
  for(const [flags,system,expected] of [
    [{soulheartHP:true},{badge:{value:6},rules:[]},'Soulheart HP bonus'],
    [{nightmare:{kind:'phobia',chapter:1}},{rules:[]},catalog['BOB.Nightmare.Phobia1Name']],
    [{boon:{id:'old'}},{rules:[{key:'FlatModifier',selector:['crafting'],predicate:['action:craft'],value:1}]},catalog['BOB.Boon.Effect.Bath.Name']]
  ]){
    const source={name:'旧效果',type:'effect',flags:{'pf2e-bob-companion':flags},system:{...system,description:{value:'原说明'}}};
    const item={...structuredClone(source),_source:structuredClone(source)};translateItem(item);
    assert.equal(item.name,expected);assert.deepEqual(item._source,source);assert.equal(item.flags['pf2e-bob-companion'].localization,undefined);
  }
});
test('chat rendering translates each viewer and preserves escaped values',()=>{
  const node={dataset:{bobI18n:'BOB.Test.Description',bobValues:JSON.stringify({hp:'<script>6</script>'})},innerHTML:''};
  language('en');translateHTML({querySelectorAll:()=>[node]});assert.equal(node.innerHTML,'<p>Maximum HP +&lt;script&gt;6&lt;/script&gt;.</p>');
  language('zh-cn');translateHTML({querySelectorAll:()=>[node]});assert.equal(node.innerHTML,'<p>最大生命值 +&lt;script&gt;6&lt;/script&gt;。</p>');
});
test('native roll labels keep translation keys after the originating effect is gone',()=>{
  language('zh-cn');
  const source='Actor.pc.Item.reward';
  const item={uuid:source,flags:{'pf2e-bob-companion':{localization:{name:'Test.Name'}}}};
  let labels;
  const message={actor:{items:[item]},flags:{pf2e:{modifiers:[
    {slug:'reward',source,modifier:2,enabled:true},
    {slug:'other',source:'Actor.pc.Item.custom',modifier:1,enabled:true}
  ]}},updateSource:patch=>{labels=patch['flags.pf2e-bob-companion.rollLabels'];}};
  presentation.markRollLabels(message);
  assert.equal(labels.length,1);
  const reward={dataset:{slug:'reward'},textContent:'生命值提升 +2'},other={dataset:{slug:'other'},textContent:'Custom +1'};
  const saved={flags:{'pf2e-bob-companion':{rollLabels:labels}}};
  language('en');presentation.translateRollLabels(saved,{querySelectorAll:()=>[reward,other]});
  assert.equal(reward.textContent,'Health bonus +2');assert.equal(other.textContent,'Custom +1');
  const reroll={dataset:{slug:'reward',bobRollLabel:'Test.Name',bobRollValues:'{}',bobRollValue:'2'},textContent:'生命值提升 +2'};
  presentation.translateRollLabels({flags:{}},{querySelectorAll:()=>[reroll]});
  assert.equal(reroll.textContent,'Health bonus +2');
});
test('translated native fear effects retain the modifier slug targeted by their darkness adjustment',async()=>{
  const catalog=await readCatalog('zh-cn');globalThis.game={i18n:{format:key=>catalog[key]??key}};
  for(const metadata of [undefined,{name:'Nightmare.Phobia4Name',description:'Nightmare.Phobia4Description',rules:[]}]) {
    const source={name:'Nyctophobia',flags:{'pf2e-bob-companion':{nightmare:{kind:'phobia',chapter:4},localization:metadata}},system:{slug:null,description:{value:''},rules:[
      {key:'FlatModifier',selector:['will'],value:-1,predicate:['self:lighting:dim-light']},
      {key:'AdjustModifier',selector:'will',slug:'nyctophobia',mode:'override',value:-2,predicate:['self:lighting:darkness']}
    ]}};
    const item={...structuredClone(source),_source:structuredClone(source)};translateItem(item);
    assert.equal(item.name,catalog['BOB.Nightmare.Phobia4Name']);
    assert.equal(item.system.rules[0].slug,item.system.rules[1].slug);
    assert.deepEqual(item._source,source);
  }
});
test('translated chat keeps native check links enriched and usable',async()=>{
  const prior=globalThis.foundry;
  const node={dataset:{bobI18n:'BOB.Test.Check',bobValues:'{}'},innerHTML:'<a>旧检定</a>'};
  globalThis.game={i18n:{format:()=>'<p>Attempt @Check[will|dc:31].</p>'}};
  globalThis.foundry={applications:{ux:{TextEditor:{implementation:{enrichHTML:async text=>text.replace('@Check[will|dc:31]','<a data-pf2-check="will" data-pf2-dc="31">Will DC 31</a>')}}}}};
  try {
    await translateHTML({querySelectorAll:()=>[node]});
    assert.match(node.innerHTML,/data-pf2-check="will"/);assert.doesNotMatch(node.innerHTML,/@Check/);
  } finally {globalThis.foundry=prior;}
});

async function viewer(language='en',isGM=false) {
  const catalog=await readCatalog(language);
  globalThis.game={user:{isGM},i18n:{lang:language,format:(key,values={})=>(catalog[key]??key).replace(/\{(\w+)\}/g,(_m,k)=>values[k]??'')},
    pf2e:{system:{sluggify:text=>text.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}},actors:new Map()};
  return catalog;
}
const prepared=source=>({...structuredClone(source),_source:structuredClone(source)});
const moduleFlags=flags=>({'pf2e-bob-companion':flags});

test('unrevealed nightmare presentation withholds future rules in both languages and preserves mechanics',async()=>{
  for(const lang of ['en','zh-cn']) {
    await viewer(lang);
    for(let chapter=1;chapter<=9;chapter++) {
      const source={name:'A named curse',type:'effect',flags:moduleFlags({nightmare:{kind:'phobia',chapter}}),
        system:{slug:'native-phobia',description:{value:'secret',gm:''},unidentified:false,duration:{value:24,unit:'hours'},rules:[
          {key:'FlatModifier',slug:'native-adjustment',selector:['will'],value:-1,type:'circumstance',predicate:['native-trigger']},
          {key:'RollOption',option:'native-trigger',toggleable:true,value:false,label:'Hidden trigger'},
          {key:'Note',selector:['initiative'],title:'Hidden curse',text:'Future consequence',predicate:['encounter']}
        ]}};
      const item=prepared(source);translateItem(item);
      assert.ok(!/curse|phobia|frightened|hours|GM|诅咒|恐惧|惊恐|小时|主持人/i.test(item.name+item.system.description.value),`${lang}: chapter ${chapter}`);
      assert.equal(item.system.unidentified,true);
      assert.equal(item.system.rules[2].visibility,'gm');
      assert.equal(item.system.rules[0].slug,'native-adjustment');
      assert.equal(item.system.rules[0].value,-1);
      assert.deepEqual(item.system.rules.map(rule=>rule.predicate),source.system.rules.map(rule=>rule.predicate));
      assert.equal(item.system.rules[1].option,'native-trigger');assert.equal(item.system.rules[1].toggleable,true);
      assert.deepEqual(item._source,source);
    }
  }
});

test('player HP and boon presentation retains current mechanics without source or administrative conditions',async()=>{
  for(const lang of ['en','zh-cn']) {
    await viewer(lang);
    for(const [flags,system,value] of [
      [{soulheartHP:true},{badge:{value:6},rules:[{key:'FlatModifier',selector:['hp'],value:'@item.badge.value'}]},6],
      [{soulheartLife:'life'},{rules:[{key:'TempHP',value:9}]},9],
      [{boon:{id:'boon'},localization:{name:'Boon.Effect.Meditation.Name',description:'Boon.Effect.Meditation.Description',values:{bonus:2}}},{rules:[{key:'FlatModifier',slug:'meditation',selector:['int-skill-check'],value:2}]},null]
    ]) {
      const source={name:'secret source',type:'effect',flags:moduleFlags(flags),system:{...system,description:{value:'secret source'},duration:{value:8,unit:'hours'}}};
      const item=prepared(source);translateItem(item);
      assert.ok(!/soulheart|curse|stay|unused|next|GM|灵心|诅咒|停留|未使用|下次|主持人/i.test(item.name+item.system.description.value));
      if(value!==null)assert.ok(item.system.description.value.includes(String(value)));
      assert.deepEqual(item._source,source);
      assert.deepEqual(item.system.rules.map(rule=>rule.value),source.system.rules.map(rule=>rule.value));
    }
  }
});

test('GM and explicitly revealed owned effects retain descriptive presentation',async()=>{
  const source={name:'old',type:'effect',flags:moduleFlags({nightmare:{kind:'phobia',chapter:9}}),system:{description:{value:''},rules:[]}};
  for(const [isGM,revealed] of [[true,false],[false,true]]) {
    const catalog=await viewer('en',isGM),item=prepared(source);
    item.flags['pf2e-bob-companion'].revealed=revealed;translateItem(item);
    assert.equal(item.name,catalog['BOB.Nightmare.Phobia9Name']);
    assert.ok(item.system.description.value.includes('DC')||item.system.description.value.includes('dc:31'));
    assert.notEqual(item.system.unidentified,true);
  }
});

test('historical and rerolled module modifier labels are neutral after their source is removed',async()=>{
  await viewer();
  const original={dataset:{slug:'nyctophobia'},textContent:'Nyctophobia -2'};
  const reroll={dataset:{slug:'meditation',bobRollLabel:'Boon.Effect.Meditation.Name',bobRollValues:'{"bonus":2}',bobRollValue:'2'},textContent:'Mental insight (unused) +2'};
  const custom={dataset:{slug:'custom'},textContent:'A native modifier +1'};
  presentation.translateRollLabels({flags:{'pf2e-bob-companion':{rollLabels:[{slug:'nyctophobia',name:'Nightmare.Phobia4Name',value:-2}]}}},{querySelectorAll:()=>[original]});
  presentation.translateRollLabels({flags:{}},{querySelectorAll:()=>[reroll,custom]});
  assert.equal(original.textContent,'Current modifier -2');assert.equal(reroll.textContent,'Current modifier +2');
  assert.equal(custom.textContent,'A native modifier +1');
});

test('historical localized future notes disappear for players while unrelated notes stay visible',async()=>{
  await viewer();
  const privateNote={removed:false,remove(){this.removed=true;}};
  const future={dataset:{bobI18n:'BOB.Nightmare.Phobia9Description',bobValues:'{}'},innerHTML:'Future consequence',closest:()=>privateNote};
  const custom={dataset:{bobI18n:'BOB.Test.Description',bobValues:'{}'},innerHTML:'An unrelated note',closest:()=>null};
  await translateHTML({querySelectorAll:selector=>selector==='[data-bob-i18n]'?[future,custom]:[]},{flags:{}});
  assert.equal(privateNote.removed,true);assert.equal(custom.innerHTML,'BOB.Test.Description');
});

test('ephemeral native helper notes are private only when sourced from a marked phobia',async()=>{
  await viewer('en',true);
  const owner={id:'pc',uuid:'Actor.pc',items:[{flags:moduleFlags({nightmare:{kind:'phobia',chapter:3}}),system:{rules:[{key:'EphemeralEffect',uuid:'Item.EHMgAsmdOUqOGl3O'}]}}]};
  game.actors.set('pc',owner);
  const source={_id:'EHMgAsmdOUqOGl3O',name:'Effect: Enochlophobia (Note)',type:'effect',flags:{},system:{description:{value:'Future frightened trigger'},context:{origin:{actor:'Actor.pc'}},rules:[{key:'Note',selector:['attack-roll'],title:'{item|name}',text:'{item|description}',predicate:['self:flanking']}]}};
  const helper=prepared(source);translateItem(helper);
  assert.equal(helper.system.rules[0].visibility,'gm');assert.deepEqual(helper.system.rules[0].predicate,['self:flanking']);assert.deepEqual(helper._source,source);
  const unrelated=prepared({...source,system:{...source.system,context:{origin:{actor:'Actor.someone-else'}}}});translateItem(unrelated);
  assert.equal(unrelated.system.rules[0].visibility,undefined);assert.equal(unrelated.name,source.name);
});

test('GM public rolls snapshot owned future notes as GM-only and keep native modifier data safe',async()=>{
  await viewer('en',true);
  const source='Actor.pc.Item.phobia',item={uuid:source,flags:moduleFlags({nightmare:{kind:'phobia',chapter:9}}),system:{rules:[]}};
  let patch;
  const message={actor:{items:[item]},flags:{pf2e:{modifiers:[{slug:'phobia',source,modifier:-1,enabled:true,label:'Hidden curse'}],context:{notes:[
    {selector:'initiative',title:'Teraphobia',text:localizeHTML('Nightmare.Phobia9Description'),outcome:[],predicate:[]},
    {selector:'initiative',title:'A different feature',text:'An ordinary native note',outcome:[],predicate:[]}
  ]}}},updateSource:value=>{patch=value;}};
  presentation.markRollLabels(message);
  const notes=patch['flags.pf2e.context.notes']??message.flags.pf2e.context.notes;
  const modifiers=patch['flags.pf2e.modifiers']??message.flags.pf2e.modifiers;
  assert.equal(notes[0].visibility,'gm');assert.equal(notes[1].visibility,undefined);
  assert.equal(modifiers[0].label,'Current modifier');
  assert.equal(modifiers[0].modifier,-1);assert.equal(modifiers[0].slug,'phobia');
});

test('private native sheet controls and phobia toggles stay out of player UI without affecting unrelated items',async()=>{
  await viewer();
  const callbacks=new Map();const prior=globalThis.Hooks;
  globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
  const node=()=>({removed:false,remove(){this.removed=true;}}),rules=node(),details=node(),editor=node(),toggle=node(),custom=node();
  const item={id:'phobia',flags:moduleFlags({nightmare:{kind:'phobia',chapter:4}}),system:{rules:[]}};
  try {
    presentation.registerI18n();
    callbacks.get('renderItemSheet')?.({item},{querySelectorAll:selector=>selector.includes('rules')?[rules,details,editor]:[]});
    const actor={items:[item,{id:'custom',flags:{},system:{rules:[]}}]};
    toggle.dataset={itemId:'phobia'};custom.dataset={itemId:'custom'};
    callbacks.get('renderActorSheet')?.({actor},{querySelectorAll:()=>[toggle,custom]});
    assert.equal(rules.removed,true);assert.equal(details.removed,true);assert.equal(editor.removed,true);
    assert.equal(toggle.removed,true);assert.equal(custom.removed,false);
  } finally {globalThis.Hooks=prior;}
});

test('an expired marked phobia still scopes its exact archived helper note through recorded history',async()=>{
  await viewer();
  const actor={id:'pc',uuid:'Actor.pc',items:[]};game.actors.set('pc',actor);
  const helper={id:'EHMgAsmdOUqOGl3O',uuid:'Item.EHMgAsmdOUqOGl3O',name:'Effect: Enochlophobia (Note)',system:{description:{value:'A future frightened trigger'},rules:[{key:'Note',text:'{item|description}'}]}};
  game.items=new Map([[helper.id,helper]]);
  game.settings={get:()=>({nightmares:{characters:{pc:{chapters:{3:{sessionId:'old-rest',phobiaAt:100}}}},sessions:{'old-rest':{chapter:3,results:{pc:{applyPhobia:true,status:'complete'}}}}}})};
  const hidden={dataset:{itemId:helper.id},removed:false,remove(){this.removed=true;},querySelectorAll:()=>[]};
  const native={dataset:{itemId:'custom-native'},removed:false,remove(){this.removed=true;},querySelectorAll:()=>[]};
  const element={querySelectorAll:selector=>selector==='.roll-note'?[hidden,native]:[]};
  await translateHTML(element,{actor,flags:{pf2e:{context:{notes:[]}}}});
  assert.equal(hidden.removed,true);assert.equal(native.removed,false);
  hidden.removed=false;
  game.settings.get=()=>({});
  await translateHTML(element,{actor,flags:{pf2e:{context:{notes:[]}}}});
  assert.equal(hidden.removed,false,'a bare helper identity without module ownership/history is not enough');
});

test('native roll inspection neutralizes archived private modifier details without hiding unrelated modifiers',async()=>{
  await viewer();
  const callbacks=new Map(),prior=globalThis.Hooks;
  globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
  const privateLabel={textContent:'Nyctophobia (nyctophobia)'},customLabel={textContent:'My native feat (custom)'};
  const privateOptions={removed:false,remove(){this.removed=true;}},rollOptions={removed:false,remove(){this.removed=true;}};
  const rows=[{dataset:{idx:'0'},querySelector:selector=>selector==='.label-slug'?privateLabel:privateOptions},
    {dataset:{idx:'1'},querySelector:selector=>selector==='.label-slug'?customLabel:null}];
  try {
    presentation.registerI18n();
    const message={flags:{'pf2e-bob-companion':{rollLabels:[{slug:'nyctophobia',name:'Nightmare.Phobia4Name',value:-2}]},pf2e:{modifiers:[
      {slug:'nyctophobia',label:'Nyctophobia',modifier:-2},{slug:'custom',label:'My native feat',modifier:1}
    ]}}};
    callbacks.get('renderRollInspector')?.({message},{querySelectorAll:()=>rows,querySelector:()=>rollOptions});
    assert.equal(privateLabel.textContent,'Current modifier -2');assert.equal(customLabel.textContent,'My native feat (custom)');
    assert.equal(privateOptions.removed,true);assert.equal(rollOptions.removed,true);
  } finally {globalThis.Hooks=prior;}
});

test('the public native hook leaves unrelated message source and flavor untouched',async()=>{
  await viewer('en',true);
  const prior=globalThis.document;let writes=0;
  globalThis.document={createElement:()=>({innerHTML:'',querySelectorAll:()=>[]})};
  try {
    const message={actor:{items:[]},flavor:'<div>An ordinary native roll</div>',flags:{pf2e:{modifiers:[{slug:'custom',label:'A normal feat',modifier:1,enabled:true}],context:{notes:[]}}},updateSource(){writes++;}};
    presentation.markRollLabels(message);assert.equal(writes,0);
  } finally {globalThis.document=prior;}
});

test('GM native temporary HP owner notices use the current HP value without revealing its source',async()=>{
  await viewer('en',true);
  const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper'].map(key=>[key,globalThis[key]]));
  const hooks=new Map(),wrappers=new Map();
  const item={name:'Soulheart temporary HP',flags:moduleFlags({soulheartLife:'life'}),system:{rules:[{key:'TempHP',value:9}]}};
  const native=function(value){return `${this.actor.name}: ${value} temporary HP from ${this.item.name}`;};
  globalThis.Hooks={once:(name,callback)=>hooks.set(name,callback),on(){}};
  globalThis.CONFIG={Item:{documentClass:class{}}};
  globalThis.libWrapper={register:(_id,target,callback)=>wrappers.set(target,callback)};
  game.pf2e.RuleElements={all:{TempHP:class{broadcast(){}}}};
  try {
    presentation.registerI18n();hooks.get('setup')();
    const rule={item,actor:{name:'PC'}},wrapper=wrappers.get('game.pf2e.RuleElements.all.TempHP.prototype.broadcast');
    const notice=wrapper ? wrapper.call(rule,native.bind(rule),9,0) : native.call(rule,9);
    assert.equal(notice,'PC: 9 temporary HP from Temporary HP');
    assert.equal(item.name,'Soulheart temporary HP');
    const custom={item:{name:'A native spell',flags:{}},actor:{name:'PC'}};
    assert.equal(wrapper.call(custom,native.bind(custom),7,0),'PC: 7 temporary HP from A native spell');
  } finally {Object.assign(globalThis,saved);}
});

test('disabled owned modifiers retain private presentation receipts on GM and player public rolls',async()=>{
  for(const isGM of [true,false]) {
    await viewer('en',isGM);
    const item={uuid:'Actor.pc.Item.phobia',flags:moduleFlags({nightmare:{kind:'phobia',chapter:4}}),system:{rules:[]}};
    const modifiers=[
      {slug:'nyctophobia',source:item.uuid,label:isGM?'Nyctophobia':'Current modifier',modifier:-1,enabled:false,ignored:true,predicate:['nyctophobia']},
      {slug:'stacked-boon',source:'Actor.pc.Item.boon',label:'Mental insight (unused)',modifier:1,enabled:false,ignored:false,predicate:[]},
      {slug:'ordinary',label:'A native feat',modifier:2,enabled:false,ignored:true,predicate:['custom']}
    ];
    const boon={uuid:'Actor.pc.Item.boon',flags:moduleFlags({boon:{id:'b'},localization:{name:'Boon.Effect.Meditation.Name'}}),system:{rules:[]}};
    let patch;
    const message={actor:{items:[item,boon]},flags:{pf2e:{modifiers,context:{notes:[],options:[]}}},updateSource:value=>{patch=value;}};
    presentation.markRollLabels(message);
    assert.equal(patch?.['flags.pf2e-bob-companion.rollLabels']?.length,2);
    const saved=patch['flags.pf2e.modifiers'];
    assert.deepEqual(saved.map(({label,...mechanics})=>mechanics),modifiers.map(({label,...mechanics})=>mechanics));
    assert.equal(saved[0].label,'Current modifier');assert.equal(saved[1].label,'Current modifier');assert.equal(saved[2].label,'A native feat');
    await viewer('en',false);
    const callbacks=new Map(),prior=globalThis.Hooks;globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
    try {
      presentation.registerI18n();
      const labels=saved.map(modifier=>({textContent:`${modifier.label} (${modifier.slug})`}));
      const tooltips=saved.map(()=>({removed:false,remove(){this.removed=true;}}));
      const rows=saved.map((_modifier,index)=>({dataset:{idx:String(index)},querySelector:selector=>selector==='.label-slug'?labels[index]:tooltips[index]}));
      const rollOptions={removed:false,remove(){this.removed=true;}};
      const archived={actor:{items:[]},flags:{pf2e:{modifiers:saved,context:{notes:[],options:[]}},'pf2e-bob-companion':{rollLabels:patch['flags.pf2e-bob-companion.rollLabels']}}};
      callbacks.get('renderRollInspector')({message:archived},{querySelectorAll:()=>rows,querySelector:()=>rollOptions});
      assert.equal(labels[0].textContent,'Current modifier -1');assert.equal(labels[1].textContent,'Current modifier +1');
      assert.equal(labels[2].textContent,'A native feat (ordinary)');assert.equal(tooltips[0].removed,true);assert.equal(tooltips[1].removed,true);assert.equal(tooltips[2].removed,false);
      assert.equal(rollOptions.removed,true);
    } finally {globalThis.Hooks=prior;}
  }
});

test('native rerolls preserve disabled-modifier privacy after losing module flags and their source',async()=>{
  await viewer('en',true);
  const prior=globalThis.document;
  const decode=text=>text.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
  globalThis.document={createElement:()=>({innerHTML:'',insertAdjacentHTML(_position,html){this.innerHTML+=html;},querySelectorAll(selector){
    if(!selector.includes('data-bob-roll-label'))return [];
    return [...this.innerHTML.matchAll(/<span\b([^>]*)>/g)].flatMap(([,attributes])=>{
      const raw=Object.fromEntries([...attributes.matchAll(/(data-[\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)]));
      if(!raw['data-bob-roll-label'])return [];
      return [{dataset:{slug:raw['data-slug'],bobRollLabel:raw['data-bob-roll-label'],bobRollValue:raw['data-bob-roll-value'],bobRollValues:raw['data-bob-roll-values'],bobRollSource:raw['data-bob-roll-source']}}];
    });
  }})};
  try {
    const item={uuid:'Actor.pc.Item.phobia',flags:moduleFlags({nightmare:{kind:'phobia',chapter:4}}),system:{rules:[]}},modifiers=[{slug:'nyctophobia',source:item.uuid,label:'Nyctophobia',modifier:-1,enabled:false,ignored:true,predicate:['nyctophobia']}];
    let firstPatch;
    presentation.markRollLabels({actor:{items:[item]},flavor:'<div>A native Will save</div>',flags:{pf2e:{modifiers,context:{notes:[]}}},updateSource:patch=>{firstPatch=patch;}});
    assert.match(firstPatch?.flavor??'',/data-bob-roll-label=/);
    let rerollPatch;
    const reroll={actor:{items:[]},flavor:firstPatch.flavor,flags:{pf2e:{modifiers:firstPatch['flags.pf2e.modifiers'],context:{notes:[]}}},updateSource:patch=>{rerollPatch=patch;}};
    presentation.markRollLabels(reroll);
    assert.equal(rerollPatch?.['flags.pf2e-bob-companion.rollLabels']?.[0]?.name,'Nightmare.Phobia4Name');
    assert.equal(rerollPatch['flags.pf2e.modifiers'][0].slug,'nyctophobia');assert.equal(rerollPatch['flags.pf2e.modifiers'][0].enabled,false);
  } finally {globalThis.document=prior;}
});

test('private workflow and owned-effect evidence hides native roll options without requiring a modifier or note',async()=>{
  await viewer();
  const callbacks=new Map(),prior=globalThis.Hooks;globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
  try {
    presentation.registerI18n();
    for(const [marker,actor,hidden] of [
      ['bob-nightmare:rest-1',{items:[]},true],['bob-boon:will-1',{items:[]},true],['bob-hazard:air-1',{items:[]},true],
      ['an-unrelated-option',{items:[{flags:moduleFlags({nightmare:{kind:'phobia',chapter:4}}),system:{rules:[]}}]},true],
      ['other:bob-nightmare:rest-1',{items:[]},false]
    ]) {
      const options={removed:false,remove(){this.removed=true;}};
      const message={actor,flags:{pf2e:{modifiers:[],context:{notes:[],options:[marker,'check:total:delta:-7']}}}};
      callbacks.get('renderRollInspector')({message},{querySelectorAll:()=>[],querySelector:()=>options});
      assert.equal(options.removed,hidden,marker);
    }
  } finally {globalThis.Hooks=prior;}
});

test('localized chat values translate with the viewing GM language after reload',async()=>{
  await viewer('zh-cn',true);
  const html=localizeHTML('Boon.Chat.Captured',{actor:'PC',outcome:'old outcome'},{outcome:'Boon.Degree.Success'});
  assert.ok(html.includes('成功：下次智力技能 +1'));assert.ok(!html.includes('old outcome</'));
  assert.ok(html.includes('data-bob-value-keys='));
  const node={dataset:{bobI18n:'BOB.Boon.Chat.Captured',bobValues:'{"actor":"PC","outcome":"old outcome"}',bobValueKeys:'{"outcome":"Boon.Degree.Success"}'},innerHTML:html};
  await viewer('en',true);await translateHTML({querySelectorAll:()=>[node]});
  assert.match(node.innerHTML,/Success: \+1 on next Intelligence skill check/);assert.ok(!node.innerHTML.includes('old outcome'));
  await viewer('zh-cn',true);await translateHTML({querySelectorAll:()=>[node]});
  assert.ok(node.innerHTML.includes('成功：下次智力技能 +1'));
});

test('private native item headers show prepared names and icons without stored curse traits or editing controls',async()=>{
  await viewer();
  const source={name:'Effect: Nyctophobia',img:'secret-phobia.svg',type:'effect',flags:moduleFlags({nightmare:{kind:'phobia',chapter:4}}),
    system:{description:{value:'A future trigger'},traits:{value:['curse']},rules:[{key:'FlatModifier',slug:'nyctophobia',selector:['will'],value:-1,predicate:['nyctophobia']}]}};
  const item=prepared(source);translateItem(item);
  // The native items/sheet.hbs header reads item._source.name and item._source.img.
  const input={value:source.name,disabled:false,readOnly:false,removeAttribute(key){delete this[key];},name:'name'};
  const image={src:source.img,dataset:{edit:'img'},removeAttribute(key){if(key==='data-edit')delete this.dataset.edit;}};
  const traits={name:'system.traits.value',value:'[{"value":"curse","label":"Curse"}]',removed:false,remove(){this.removed=true;}};
  const root={querySelector:selector=>selector==='.sheet-header input[name="name"]'?input:selector==='.sheet-header img[data-edit="img"]'?image:null,
    querySelectorAll:selector=>selector.includes('tagify-tags')?[traits]:[]};
  const callbacks=new Map(),prior=globalThis.Hooks;globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
  try {
    presentation.registerI18n();callbacks.get('renderItemSheet')({item},root);
    assert.equal(input.value,'Current effect');assert.equal(input.name,undefined);assert.equal(input.readOnly,true);
    assert.equal(image.src,'systems/pf2e/icons/default-icons/effect.svg');assert.equal(image.dataset.edit,undefined);
    assert.equal(traits.removed,true);assert.deepEqual(item._source,source);assert.deepEqual(item.system.traits.value,['curse']);
    assert.deepEqual(item.system.rules[0].predicate,['nyctophobia']);assert.equal(item.system.rules[0].slug,'nyctophobia');
    input.value=source.name;traits.removed=false;
    callbacks.get('renderItemSheet')({item:{...item,flags:moduleFlags({...item.flags['pf2e-bob-companion'],revealed:true})}},root);
    assert.equal(input.value,source.name);assert.equal(traits.removed,false,'explicitly revealed and unrelated headers remain native');
  } finally {globalThis.Hooks=prior;}
});

test('untriggered private effects retain inspector context privacy after removal and native reroll',async()=>{
  await viewer('en',true);
  const priorDocument=globalThis.document,priorHooks=globalThis.Hooks,callbacks=new Map();
  globalThis.document={createElement:()=>({innerHTML:'',querySelectorAll:()=>[],insertAdjacentHTML(_position,html){this.innerHTML+=html;}})};
  globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
  try {
    let patch;
    const message={actor:{items:[{flags:moduleFlags({nightmare:{kind:'phobia',chapter:9}}),system:{rules:[{key:'Note',predicate:['encounter'],text:'A future trigger'}]}}]},
      flavor:'<div>An ordinary native skill check</div>',flags:{pf2e:{modifiers:[],context:{notes:[],options:['self:effect:teraphobia']}}},updateSource:value=>{patch=value;}};
    presentation.markRollLabels(message);
    assert.equal(patch?.['flags.pf2e-bob-companion.privateRollContext'],true);
    assert.match(patch?.flavor??'',/data-bob-private-context="true"/);
    await viewer('en',false);presentation.registerI18n();
    for(const flags of [
      {pf2e:message.flags.pf2e,'pf2e-bob-companion':{privateRollContext:true}},
      {pf2e:message.flags.pf2e}
    ]) {
      const archived={actor:{items:[]},flags,flavor:patch.flavor};
      const options={removed:false,remove(){this.removed=true;}};
      callbacks.get('renderRollInspector')({message:archived},{querySelectorAll:()=>[],querySelector:()=>options});
      assert.equal(options.removed,true,'source removal and native module-flag loss do not disclose historical triggers');
    }
  } finally {globalThis.document=priorDocument;globalThis.Hooks=priorHooks;}
});

test('source-specific disabled receipts do not neutralize an unrelated modifier with the same native slug',async()=>{
  await viewer('en',true);
  const item={uuid:'Actor.pc.Item.phobia',flags:moduleFlags({nightmare:{kind:'phobia',chapter:4}}),system:{rules:[]}};
  const modifiers=[{slug:'nyctophobia',source:item.uuid,label:'Nyctophobia',modifier:-1,enabled:false},
    {slug:'nyctophobia',source:'Actor.pc.Item.native',label:'A custom native feature',modifier:2,enabled:true}];
  let patch;presentation.markRollLabels({actor:{items:[item]},flags:{pf2e:{modifiers}},updateSource:value=>{patch=value;}});
  assert.equal(patch['flags.pf2e.modifiers'][0].label,'Current modifier');
  assert.equal(patch['flags.pf2e.modifiers'][1].label,'A custom native feature');
  assert.equal(patch['flags.pf2e-bob-companion.rollLabels'][0].source,item.uuid);
});

test('native effect deletion floaties use neutral player names while retaining source and unrelated payloads',async()=>{
  await viewer();
  const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper'].map(key=>[key,globalThis[key]])),hooks=new Map(),targets=[];
  const payloads=[];
  class AbstractEffect {
    constructor(source){Object.assign(this,prepared(source));this.isIdentified=true;this.actor={getActiveTokens:()=>[{showFloatyText:payload=>payloads.push(payload)}]};}
    _onDelete(){this.handleChange({delete:{name:this._source.name}});}
    handleChange(payload){if(game.user.isGM||this.isIdentified)this.actor.getActiveTokens().shift().showFloatyText(payload);}
  }
  class NativeEffect extends AbstractEffect {}
  globalThis.Hooks={once:(name,callback)=>hooks.set(name,callback),on(){}};
  globalThis.CONFIG={Item:{documentClass:class{}},PF2E:{Item:{documentClasses:{effect:NativeEffect}}}};
  globalThis.libWrapper={register:(_id,target,callback)=>{
    targets.push(target);
    if(target==='CONFIG.PF2E.Item.documentClasses.effect.prototype.handleChange') {
      const native=NativeEffect.prototype.handleChange;
      NativeEffect.prototype.handleChange=function(...args){return callback.call(this,native.bind(this),...args);};
    }
  }};
  try {
    presentation.registerI18n();hooks.get('setup')();
    for(const [flags,expected] of [[{boon:{id:'b'}},'Current effect'],[{soulheartHP:true},'Maximum HP bonus'],[{soulheartLife:'life'},'Temporary HP']]) {
      const source={name:'A secret source',img:'native.svg',type:'effect',flags:moduleFlags(flags),system:{description:{value:'secret'},rules:[]}};
      const item=new NativeEffect(source);item._onDelete();
      assert.deepEqual(payloads.at(-1),{delete:{name:expected}});assert.deepEqual(item._source,source);
    }
    assert.ok(targets.includes('CONFIG.PF2E.Item.documentClasses.effect.prototype.handleChange'));
    const native=new NativeEffect({name:'A native spell',flags:{},system:{rules:[]}});native._onDelete();
    assert.deepEqual(payloads.at(-1),{delete:{name:'A native spell'}});
    const revealed=new NativeEffect({name:'An explicitly revealed source',flags:moduleFlags({boon:{id:'b'},revealed:true}),system:{rules:[]}});revealed._onDelete();
    assert.equal(payloads.at(-1).delete.name,'An explicitly revealed source');
    game.user.isGM=true;
    const gm=new NativeEffect({name:'GM secret source',flags:moduleFlags({soulheartHP:true}),system:{rules:[]}});gm._onDelete();
    assert.equal(payloads.at(-1).delete.name,'GM secret source');
  } finally {Object.assign(globalThis,saved);}
});

test('native init prepares embedded player and GM item presentation before first actor rule construction',async()=>{
  const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper'].map(key=>[key,globalThis[key]]));
  try {
    for(const [lang,isGM] of [['en',false],['zh-cn',false],['en',true],['zh-cn',true]]) {
      const catalog=await viewer(lang,isGM),hooks=new Map(),targets=[];
      class NativeItem {
        constructor(source){Object.assign(this,prepared(source));}
        prepareData(){this.prepareBaseData();}
        prepareBaseData(){this.rollOptionSlug=this.system.slug;}
        prepareRuleElements(){this.rules=structuredClone(this.system.rules);}
      }
      class NativeActor {
        constructor(items){this.items=items;}
        prepareEmbeddedDocuments(){for(const item of this.items)item.prepareData();for(const item of this.items)item.prepareRuleElements();}
      }
      globalThis.CONFIG={Item:{documentClass:NativeItem}};
      globalThis.Hooks={once:(name,callback)=>hooks.set(name,callback),on(){}};
      globalThis.libWrapper={register:(_id,target,callback)=>{
        targets.push(target);
        if(target==='CONFIG.Item.documentClass.prototype.prepareData') {
          const native=NativeItem.prototype.prepareData;
          NativeItem.prototype.prepareData=function(...args){return callback.call(this,native.bind(this),...args);};
        }
      }};
      const sources=[...Array.from({length:9},(_unused,index)=>({name:`Private phobia ${index+1}`,img:'secret-phobia.svg',type:'effect',
        flags:moduleFlags({nightmare:{kind:'phobia',chapter:index+1}}),system:{slug:`native-phobia-${index+1}`,description:{value:'Future frightened trigger'},traits:{value:['curse']},rules:[
          {key:'FlatModifier',slug:`native-adjustment-${index+1}`,selector:['will'],value:-1,predicate:['native-trigger']},
          {key:'Note',selector:['initiative'],title:'Hidden cause',text:'Future trigger',predicate:['encounter']}]}})),
        {name:'Mental insight (unused)',img:'secret-insight.svg',type:'effect',flags:moduleFlags({boon:{id:'b'},localization:{name:'Boon.Effect.Meditation.Name',description:'Boon.Effect.Meditation.Description',values:{bonus:1}}}),
          system:{slug:'native-meditation',description:{value:'Future Int bonus'},rules:[{key:'FlatModifier',slug:'meditation',selector:['int-skill-check'],value:1,predicate:['int-based']}]}},
        {name:'Soulheart HP',img:'secret-hp.svg',type:'effect',flags:moduleFlags({soulheartHP:true}),system:{slug:'native-hp',badge:{value:6},description:{value:'Secret soulheart'},rules:[{key:'FlatModifier',selector:['hp'],value:'@item.badge.value'}]}},
        {name:'Ordinary native effect',img:'ordinary.svg',type:'effect',flags:{},system:{slug:'ordinary',description:{value:'Ordinary description'},rules:[]}}];
      // Foundry calls module init, initializeDocuments, then setup. No reset or later update runs here.
      presentation.registerI18n();
      const items=sources.map(source=>new NativeItem(source)),actor=new NativeActor(items);actor.prepareEmbeddedDocuments();
      for(let chapter=1;chapter<=9;chapter++) {
        const item=items[chapter-1];
        assert.equal(item.name,isGM?catalog[`BOB.Nightmare.Phobia${chapter}Name`]:catalog['BOB.Common.CurrentEffectName']);
        assert.equal(item.rules[1].visibility,'gm');assert.equal(item.rules[0].slug,`native-adjustment-${chapter}`);
        assert.deepEqual(item.rules[0].predicate,['native-trigger']);assert.equal(item.rollOptionSlug,`native-phobia-${chapter}`);
        assert.deepEqual(item._source,sources[chapter-1]);
        if(!isGM){assert.equal(item.img,'systems/pf2e/icons/default-icons/effect.svg');assert.equal(item.system.unidentified,true);}
      }
      assert.equal(items[9].name,catalog[isGM?'BOB.Boon.Effect.Meditation.Name':'BOB.Common.CurrentEffectName']);
      assert.equal(items[10].name,catalog[isGM?'BOB.Soulheart.HPEffectName':'BOB.Common.CurrentHPName']);
      if(!isGM)for(const item of items.slice(9,11))assert.equal(item.img,'systems/pf2e/icons/default-icons/effect.svg');
      assert.equal(items[11].name,sources[11].name);assert.equal(items[11].img,sources[11].img);
      hooks.get('setup')?.();assert.equal(targets.filter(target=>target==='CONFIG.Item.documentClass.prototype.prepareData').length,1,'setup does not double-register the first-load wrapper');
    }
  } finally {Object.assign(globalThis,saved);}
});

test('native private-only intercession sections use a neutral heading and preserve other categories',async()=>{
  await viewer();const callbacks=new Map(),prior=globalThis.Hooks;globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
  const privateFeat={id:'g4',type:'feat',flags:moduleFlags({boon:{id:'g4'}}),system:{slug:'pharasma-minor-boon',rules:[]}};
  const browseButton={dataset:{action:'browse-feats',type:'feat'}},header={text:'Divine Intercessions',children:[browseButton],
    get textContent(){return this.text;},set textContent(value){this.text=value;this.children=[];},nextElementSibling:{querySelectorAll:()=>[{dataset:{itemId:'g4'}}]}};
  const root={querySelector:selector=>selector==='[data-tab="effects"] header[data-group-id="intercession"]'?header:null,querySelectorAll:()=>[]};
  try {
    presentation.registerI18n();callbacks.get('renderActorSheet')({actor:{items:[privateFeat]}},root);
    assert.equal(header.textContent,'Current effect');assert.equal(header.children.length,0,'the native category Browse button would reveal divine classification');
    for(const publicFeat of [{id:'g4',flags:{}},{...privateFeat,flags:moduleFlags({boon:{id:'g4'},revealed:true})}]) {
      header.textContent='Divine Intercessions';header.children=[browseButton];callbacks.get('renderActorSheet')({actor:{items:[publicFeat]}},root);
      assert.equal(header.textContent,'Divine Intercessions');assert.deepEqual(header.children,[browseButton]);
    }
    header.textContent='Divine Intercessions';header.children=[browseButton];header.nextElementSibling.querySelectorAll=()=>[{dataset:{itemId:'g4'}},{dataset:{itemId:'native'}}];
    callbacks.get('renderActorSheet')({actor:{items:[privateFeat,{id:'native',flags:{}}]}},root);assert.equal(header.textContent,'Divine Intercessions');assert.deepEqual(header.children,[browseButton]);
  } finally {globalThis.Hooks=prior;}
});

test('native private effect tooltips and panel expiry labels omit future timing while keeping duration mechanics',async()=>{
  await viewer();const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper','foundry'].map(key=>[key,globalThis[key]])),hooks=new Map(),callbacks=new Map(),wrappers=new Map();
  const item={id:'hp',flags:moduleFlags({soulheartHP:true}),system:{expired:true,duration:{value:8,unit:'hours'},rules:[]}};
  const native={id:'native',flags:{},system:{expired:true,duration:{value:8,unit:'hours'},rules:[]}};
  globalThis.CONFIG={Item:{documentClass:class{}}};globalThis.Hooks={once:(name,callback)=>hooks.set(name,callback),on:(name,callback)=>callbacks.set(name,callback)};
  globalThis.foundry={applications:{handlebars:{renderTemplate:async(_path,data)=>data.remaining}}};
  globalThis.libWrapper={register:(_id,target,callback)=>wrappers.set(target,callback)};
  try {
    presentation.registerI18n();hooks.get('setup')?.();
    item.type='effect';item.system.description={value:'Secret source'};translateItem(item);
    // Native EffectsPanel and actor partial render only identified effects for players.
    const visibleEffects=[item,native].filter(effect=>!effect.system.unidentified || game.user.isGM);
    assert.deepEqual(visibleEffects,[native]);
    assert.equal(wrappers.has('foundry.applications.handlebars.renderTemplate'),false);
    const expiry=()=>({removed:false,remove(){this.removed=true;}}),ownedExpiry=expiry(),nativeExpiry=expiry();
    const rows=[{dataset:{itemId:item.id},querySelector:()=>ownedExpiry},{dataset:{itemId:native.id},querySelector:()=>nativeExpiry}];
    callbacks.get('renderEffectsPanel')?.({}, {querySelectorAll:selector=>selector==='.effect-item[data-item-id]'?rows:[]}, {actor:{items:[item,native]}});
    assert.equal(ownedExpiry.removed,true);assert.equal(nativeExpiry.removed,false);
    assert.equal(item.system.expired,true);assert.deepEqual(item.system.duration,{value:8,unit:'hours'});
  } finally {Object.assign(globalThis,saved);}
});

test('a non-configurable native template export cannot interrupt module initialization',async()=>{
  await viewer();const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper','foundry'].map(key=>[key,globalThis[key]])),callbacks=new Map(),targets=[];
  const handlebars={};Object.defineProperty(handlebars,'renderTemplate',{value:async()=>'<p>native</p>',configurable:false});
  globalThis.foundry={applications:{handlebars}};globalThis.CONFIG={Item:{documentClass:class{prepareData(){}}}};
  globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
  globalThis.libWrapper={register:(_id,target)=>{
    const segments=target.split('.'),property=segments.pop();let owner=globalThis;
    for(const segment of segments)owner=owner[segment];
    if(Object.getOwnPropertyDescriptor(owner,property)?.configurable===false)throw new Error(`Cannot wrap ${target}: configurable=false`);
    targets.push(target);
  }};
  try {
    assert.doesNotThrow(()=>presentation.registerI18n());
    assert.ok(targets.includes('CONFIG.Item.documentClass.prototype.prepareData'));
    assert.equal(targets.includes('foundry.applications.handlebars.renderTemplate'),false);
    assert.ok(callbacks.has('renderActorSheet'),'later native UI hooks remain registered');
    assert.ok(callbacks.has('renderRollInspector'));
  } finally {Object.assign(globalThis,saved);}
});

test('unrevealed owned effects use native unidentified visibility while current mechanics and granted conditions remain intact',async()=>{
  for(const lang of ['en','zh-cn']) {
    await viewer(lang);
    for(const flags of [{boon:{id:'known'}},{soulheartHP:true},{soulheartLife:'life'},{boon:{id:'legacy-unknown'}}]) {
      const source={name:'Private source',img:'secret.svg',type:'effect',flags:moduleFlags(flags),system:{description:{value:'Future consequence'},unidentified:false,
        badge:{value:6},duration:{value:8,unit:'hours'},rules:[{key:'FlatModifier',slug:'native-adjustment',selector:['hp'],value:6,predicate:['native-predicate']},{key:'TempHP',value:9}]}};
      const item=prepared(source);translateItem(item);
      assert.equal(item.system.unidentified,true);assert.deepEqual(item._source,source);
      assert.equal(item.system.rules[0].value,6);assert.equal(item.system.rules[0].slug,'native-adjustment');assert.deepEqual(item.system.rules[0].predicate,['native-predicate']);
      assert.deepEqual(item.system.duration,{value:8,unit:'hours'});assert.equal(item.system.rules[1].value,9);
    }
    const condition={name:'Stupefied 1',type:'condition',flags:{},system:{unidentified:false,rules:[]}};translateItem(condition);
    assert.equal(condition.system.unidentified,false);assert.equal(condition.name,'Stupefied 1');
  }
});

test('expired native boon roll labels recover only from exact module note and modifier source provenance',async()=>{
  const priorDocument=globalThis.document,priorHooks=globalThis.Hooks;
  const itemId='gEApUqwmmU1YKlBh',source=`Actor.ckq5d8zM6Hwe1LHd.Item.${itemId}`;
  const marker={dataset:{bobI18n:'BOB.Boon.Effect.Meditation.NoteTitle',bobValues:'{"bonus":1}'}};
  const note={dataset:{itemId},querySelectorAll:selector=>selector==='[data-bob-i18n]'?[marker]:[]};
  globalThis.document={createElement:()=>({innerHTML:'',querySelectorAll:selector=>selector==='.roll-note[data-item-id]'?[note]:[]})};
  try {
    for(const lang of ['en','zh-cn']) {
      const catalog=await viewer(lang),callbacks=new Map();globalThis.Hooks={once(){},on:(name,callback)=>callbacks.set(name,callback)};
      presentation.registerI18n();
      const modifier={slug:'心智启迪-未使用',source,label:'心智启迪（未使用）',modifier:1,enabled:true,predicate:['int-based']};
      const unrelated={slug:'native-feat',source:'Actor.ckq5d8zM6Hwe1LHd.Item.native',label:'A native feat',modifier:2,enabled:true};
      const message={actor:{items:[]},flavor:`<ul><li class="roll-note" data-item-id="${itemId}"><span data-bob-i18n="BOB.Boon.Effect.Meditation.NoteTitle" data-bob-values="{&quot;bonus&quot;:1}">Hidden source</span></li></ul>`,
        flags:{pf2e:{modifiers:[modifier,unrelated],context:{notes:[],options:['self:effect:hidden-source']}}}};
      const tag={dataset:{slug:modifier.slug},textContent:'心智启迪（未使用） +1'},nativeTag={dataset:{slug:unrelated.slug},textContent:'A native feat +2'};
      presentation.translateRollLabels(message,{querySelectorAll:()=>[tag,nativeTag]});
      assert.equal(tag.textContent,`${catalog['BOB.Common.CurrentModifier']} +1`);assert.equal(nativeTag.textContent,'A native feat +2');
      const label={textContent:'心智启迪（未使用） (心智启迪-未使用)'},tooltip={removed:false,remove(){this.removed=true;}},options={removed:false,remove(){this.removed=true;}};
      callbacks.get('renderRollInspector')({message},{querySelectorAll:()=>[{dataset:{idx:'0'},querySelector:selector=>selector==='.label-slug'?label:tooltip}],querySelector:()=>options});
      assert.equal(label.textContent,`${catalog['BOB.Common.CurrentModifier']} +1`);assert.equal(tooltip.removed,true);assert.equal(options.removed,true);
      let patch;presentation.markRollLabels({...message,flavor:undefined,updateSource:value=>{patch=value;}});
      assert.equal(patch,undefined,'a deleted source alone, without the proven marker, is not a module modifier');
      modifier.source='Actor.ckq5d8zM6Hwe1LHd.Item.some-unrelated-item';tag.textContent='A custom native source +1';
      presentation.translateRollLabels(message,{querySelectorAll:()=>[tag]});assert.equal(tag.textContent,'A custom native source +1');
    }
  } finally {globalThis.document=priorDocument;globalThis.Hooks=priorHooks;}
});

test('private legacy and localized modifiers keep their native identity for sibling adjustments before presentation changes',async()=>{
  for(const [lang,isGM] of [['en',false],['zh-cn',false],['en',true],['zh-cn',true]]) {
    await viewer(lang,isGM);
    for(const localization of [undefined,{name:'Boon.Effect.Meditation.Name',rules:[{index:0,label:'Rule.MoonFear'}]}]) {
      const source={name:'Private native effect',type:'effect',flags:moduleFlags({boon:{id:'legacy'},...(localization?{localization}:{})}),
        system:{slug:'native-private-effect',description:{value:'Future cause'},rules:[
          {key:'FlatModifier',label:'Native adjustment',selector:['initiative'],value:-1,type:'circumstance',predicate:['native-trigger']},
          {key:'AdjustModifier',slug:'native-adjustment',selector:'initiative',mode:'add',value:-1,predicate:['native-trigger']},
          {key:'RollOption',option:'native-trigger',domain:'all',toggleable:true,label:'A hidden trigger'},
          {key:'Note',selector:['initiative'],title:'Hidden future',text:'A future consequence',predicate:['native-trigger']}
        ]}};
      const item=prepared(source);item.rollOptionSlug=item.system.slug;translateItem(item);
      // Native FlatModifier uses rule.slug ?? sluggify(getReducedLabel()); AdjustModifier targets that exact slug.
      const rule=item.system.rules[0],modifier={slug:rule.slug??game.pf2e.system.sluggify(rule.label??item.name),value:rule.value};
      const sibling=item.system.rules[1];if(sibling.slug===modifier.slug)modifier.value+=sibling.value;
      assert.equal(modifier.slug,'native-adjustment');assert.equal(modifier.value,-2,'the sibling adjustment still contributes');
      assert.equal(item.rollOptionSlug,'native-private-effect');assert.equal(item.system.slug,'native-private-effect');
      assert.equal(item.system.rules[2].option,'native-trigger');assert.equal(item.system.rules[2].domain,'all');
      assert.deepEqual(item.system.rules.map(rule=>rule.predicate),source.system.rules.map(rule=>rule.predicate));
      assert.deepEqual(item.system.rules[1],source.system.rules[1]);assert.equal(item.system.rules[3].visibility,'gm');
      assert.deepEqual(item._source,source);translateItem(item);assert.equal(item.system.rules[0].slug,'native-adjustment');
    }
  }
});

test('private legacy item slug fallback retains its native identity after the prepared name changes',async()=>{
  await viewer();
  const source={name:'Private native effect',type:'effect',flags:moduleFlags({boon:{id:'legacy'}}),system:{description:{value:'Future cause'},rules:[
    {key:'FlatModifier',label:'Native adjustment',selector:['initiative'],value:-1}]}};
  const item=prepared(source);Object.defineProperty(item,'slug',{get(){return this.system.slug??game.pf2e.system.sluggify(this.name);}});
  const nativeSlug=item.slug;translateItem(item);
  assert.equal(item.slug,nativeSlug);assert.deepEqual(item._source,source);
});

test('native reduced item-name slugs are captured before private localization for missing and matching labels',async()=>{
  await viewer();let calls=0;
  game.pf2e.RuleElement=class{getReducedLabel(label=this.label){calls++;return label===this.parent.name?label.replace(/^Effect: /,''):label;}};
  for(const label of [undefined,'Effect: Native adjustment']) {
    const source={name:'Effect: Native adjustment',type:'effect',flags:moduleFlags({boon:{id:'legacy'},localization:{name:'Boon.Effect.Meditation.Name'}}),
      system:{description:{value:'Secret'},rules:[{key:'FlatModifier',...(label?{label}:{}),selector:['initiative'],value:-1}]}};
    const item=prepared(source);translateItem(item);assert.equal(item.system.rules[0].slug,'native-adjustment');assert.deepEqual(item._source,source);
  }
  assert.equal(calls,2);
});

test('Calendaria player weather uses physical bilingual labels on copied owned records and preserves native state',async()=>{
  const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper','CALENDARIA'].map(key=>[key,globalThis[key]]));
  const types={'bob-cold-drizzle':'ColdDrizzle','bob-cold-rain':'ColdRain','bob-cold-overcast':'ColdOvercast','bob-cold-thunderstorm':'ColdThunderstorm','bob-severe-thunderstorm':'SevereThunderstorm','bob-cold-snow':'ColdSnow'};
  try {
    for(const language of ['en','zh-cn']) {
      const catalog=await viewer(language),hooks=new Map(),targets=[],calls=[];
      const make=id=>({id,label:'诅咒寒雨·猛烈风暴',description:'Room A23 causes this curse for one week; GM applies the future trigger.',
        icon:'cloud-bolt',color:'#667788',category:'rain',temperature:3,wind:{speed:40,direction:'NE'},precipitation:90,darknessPenalty:2,
        environmentBase:0.4,environmentDark:0.6,environmentCycle:true,fx:{name:'rain'},sound:{volume:0.2},setAt:100,setBy:'gm',generated:true,season:'winter'});
      const stored=make('bob-severe-thunderstorm');stored.activePeriod='morning';stored.periods={morning:{...make('bob-cold-drizzle'),severity:2},evening:{preset:make('bob-cold-snow'),temperature:-2},custom:make('custom-storm')};
      const forecast=Object.keys(types).map((id,index)=>({year:4726,month:8,dayOfMonth:index,preset:make(id),temperature:3,wind:40,precipitation:90,isVaried:false,
        periods:{night:{preset:make(id),temperature:2}}}));forecast.push({year:4726,month:8,dayOfMonth:7,preset:make('custom-storm')});
      const before=structuredClone({stored,forecast});
      class WeatherManager {
        static getCurrentWeather(...args){calls.push(['current',...args]);return {...stored,severity:7,periods:{...stored.periods}};}
        static getForecast(options){calls.push(['forecast',options]);return forecast;}
        static resolveDisplayLabel(...args){calls.push(['label',...args]);return 'Secret curse alias';}
      }
      globalThis.CALENDARIA={managers:{WeatherManager}};globalThis.CONFIG={Item:{documentClass:class{prepareData(){}}}};
      globalThis.Hooks={once:(name,callback)=>hooks.set(name,callback),on(){}};
      globalThis.libWrapper={register:(_id,target,callback)=>{
        targets.push(target);const segments=target.split('.'),key=segments.pop();let owner=globalThis;for(const segment of segments)owner=owner[segment];
        const native=owner[key];owner[key]=function(...args){return callback.call(this,native.bind(this),...args);};
      }};
      presentation.registerI18n();
      const current=WeatherManager.getCurrentWeather('bob-s34',{id:'scene'}),upcoming=WeatherManager.getForecast({days:7,playerView:true});
      const assertOwned=(record,id)=>{
        assert.equal(record.label,catalog[`BOB.Weather.Display.${types[id]}.Label`]);assert.equal(record.description,catalog[`BOB.Weather.Display.${types[id]}.Description`]);
        const original=make(id);for(const key of Object.keys(original).filter(key=>!['label','description'].includes(key)))assert.deepEqual(record[key],original[key],key);
      };
      assertOwned(current,current.id);assertOwned(current.periods.morning,'bob-cold-drizzle');assertOwned(current.periods.evening.preset,'bob-cold-snow');
      assert.deepEqual(current.periods.custom,stored.periods.custom);assert.equal(current.activePeriod,'morning');assert.equal(current.severity,7);
      upcoming.slice(0,6).forEach((entry,index)=>{
        assertOwned(entry.preset,forecast[index].preset.id);assertOwned(entry.periods.night.preset,forecast[index].preset.id);
        assert.deepEqual({year:entry.year,month:entry.month,dayOfMonth:entry.dayOfMonth},{year:4726,month:8,dayOfMonth:index});
      });
      assert.equal(upcoming.at(-1),forecast.at(-1));assert.deepEqual({stored,forecast},before);
      for(const [id,type] of Object.entries(types))assert.equal(WeatherManager.resolveDisplayLabel(id,'secret','calendar','zone'),catalog[`BOB.Weather.Display.${type}.Label`]);
      assert.equal(WeatherManager.resolveDisplayLabel('custom-storm','private user weather','calendar','zone'),'Secret curse alias');
      assert.equal(calls.filter(call=>call[0]==='label').length,7,'all native resolver calls remain chained even when the displayed label is neutral');
      game.user.isGM=true;assert.equal(WeatherManager.getCurrentWeather().label,stored.label);assert.equal(WeatherManager.getForecast(),forecast);
      assert.equal(WeatherManager.resolveDisplayLabel('bob-severe-thunderstorm','secret','calendar','zone'),'Secret curse alias');
      hooks.get('setup')?.();hooks.get('calendaria.init')?.();
      for(const method of ['getCurrentWeather','getForecast','resolveDisplayLabel'])assert.equal(targets.filter(target=>target===`CALENDARIA.managers.WeatherManager.${method}`).length,1);
    }
  } finally {Object.assign(globalThis,saved);}
});

test('Calendaria display wrappers install after its init independently of the item preparation guard',async()=>{
  await viewer();const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper','CALENDARIA'].map(key=>[key,globalThis[key]])),hooks=new Map(),targets=[];
  globalThis.CALENDARIA=undefined;globalThis.CONFIG={Item:{documentClass:class{prepareData(){}}}};
  globalThis.Hooks={once:(name,callback)=>hooks.set(name,callback),on(){}};
  globalThis.libWrapper={register:(_id,target)=>targets.push(target)};
  try {
    presentation.registerI18n();
    globalThis.CALENDARIA={managers:{WeatherManager:class{static getCurrentWeather(){}static getForecast(){}static resolveDisplayLabel(){}}}};
    hooks.get('calendaria.init')?.();hooks.get('setup')?.();
    for(const method of ['getCurrentWeather','getForecast','resolveDisplayLabel'])assert.equal(targets.filter(target=>target===`CALENDARIA.managers.WeatherManager.${method}`).length,1);
    assert.equal(targets.filter(target=>target==='CONFIG.Item.documentClass.prototype.prepareData').length,1);
  } finally {Object.assign(globalThis,saved);}
});

test('Calendaria owned label wrappers chain the native resolver and allow subsequent native rendering',async()=>{
  const catalog=await viewer();const saved=Object.fromEntries(['Hooks','CONFIG','libWrapper','CALENDARIA'].map(key=>[key,globalThis[key]])),calls=[];
  class WeatherManager {
    static getCurrentWeather(){return {id:'bob-cold-rain'};}
    static getForecast(){return [];}
    static resolveDisplayLabel(...args){calls.push(args);return 'A secret native alias';}
  }
  globalThis.CALENDARIA={managers:{WeatherManager}};globalThis.CONFIG={Item:{documentClass:class{prepareData(){}}}};
  globalThis.Hooks={once(){},on(){}};
  globalThis.libWrapper={register:(_id,target,callback,type)=>{
    const segments=target.split('.'),key=segments.pop();let owner=globalThis;for(const segment of segments)owner=owner[segment];
    const native=owner[key];owner[key]=function(...args){
      let chained=false;const wrapped=(...nativeArgs)=>{chained=true;return native.apply(this,nativeArgs);};
      const result=callback.call(this,wrapped,...args);
      if(type==='WRAPPER'&&!chained){owner[key]=native;throw new Error('libWrapper WRAPPER did not chain and was unregistered');}
      return result;
    };
  }};
  try {
    presentation.registerI18n();const args=['bob-cold-rain','A hidden fallback','calendar-id','zone-id'];
    const renderDay=()=>`<span>${WeatherManager.resolveDisplayLabel(...args)}</span>`;
    assert.doesNotThrow(()=>renderDay());assert.equal(renderDay(),`<span>${catalog['BOB.Weather.Display.ColdRain.Label']}</span>`);
    assert.deepEqual(calls,[args,args]);
    game.user.isGM=true;assert.equal(renderDay(),'<span>A secret native alias</span>');assert.deepEqual(calls[2],args);
  } finally {Object.assign(globalThis,saved);}
});
