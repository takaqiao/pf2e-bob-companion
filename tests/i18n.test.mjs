import test from 'node:test';
import assert from 'node:assert/strict';
import {t, markLocalized, translateItem, localizeHTML, translateHTML, preferredActor} from '../scripts/i18n.mjs';
import * as presentation from '../scripts/i18n.mjs';
import {readCatalog} from './helpers/localization.mjs';
import {readFile,readdir} from 'node:fs/promises';

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
