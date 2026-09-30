const ID = 'pf2e-bob-companion';
const fullKey = key => key.startsWith('BOB.') ? key : `BOB.${key}`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const safeValues = values => Object.fromEntries(Object.entries(values ?? {}).map(([key,value]) => [key,escape(value)]));
const translatedValues = (values,valueKeys) => ({...values,...Object.fromEntries(Object.entries(valueKeys ?? {}).map(([key,value])=>[key,t(value,values)]))});
const documents = value => Array.from(value?.values?.() ?? value ?? []);
const isPlayer = () => globalThis.game?.user?.isGM === false;
const ownedFlags = item => item?.flags?.[ID];
const revealed = item => {
  const flags=ownedFlags(item);
  return flags?.revealed===true || flags?.playerRevealed===true || flags?.nightmare?.revealed===true || flags?.boon?.revealed===true;
};
const managed = item => {
  const flags=ownedFlags(item);
  return Boolean(flags?.nightmare || flags?.boon || flags?.soulheartHP || flags?.soulheartLife);
};
const privateOwned = item => managed(item) && !revealed(item);
const plainKey = key => String(key ?? '').replace(/^BOB\./,'');
const privateKey = key => /^(?:Nightmare\.(?:Phobia[1-9](?:Name|Description)|Unease(?:Name|Description))|Boon\.Effect\.|Soulheart\.(?:HP|Life)Effect)/.test(plainKey(key));
const publicName = key => {
  const name=plainKey(key);
  if (name==='Soulheart.HPEffectName') return 'Common.CurrentHPName';
  if (name==='Soulheart.LifeEffectName') return 'Common.CurrentTempHPName';
  return privateKey(name) || /^Rule\.(?:Moon|Weather|Wind)/.test(name) ? 'Common.CurrentModifier' : key;
};
const publicTextKey = key => {
  const name=plainKey(key);
  if (name==='Soulheart.HPEffectName') return 'Common.CurrentHPName';
  if (name==='Soulheart.HPEffectDescription') return 'Common.CurrentHPDescription';
  if (name==='Soulheart.LifeEffectName') return 'Common.CurrentTempHPName';
  if (name==='Soulheart.LifeEffectDescription') return 'Common.CurrentTempHPDescription';
  return /(?:Name|NoteTitle)$/.test(name) ? 'Common.CurrentEffectName' : 'Common.CurrentEffectDescription';
};

function actorAt(uuid) {
  if (!uuid) return null;
  const id=/^Actor\.([^.]+)$/.exec(uuid)?.[1];
  return (id && globalThis.game?.actors?.get?.(id)) || globalThis.fromUuidSync?.(uuid) || null;
}

/** A native ephemeral helper belongs to the marked phobia that supplied its exact UUID. */
function helperOwner(item) {
  const actor=actorAt(item.system?.context?.origin?.actor);
  if (!actor) return null;
  const id=item.id ?? item._id ?? item._source?._id;
  const sources=new Set([item.uuid,item.sourceId,item._stats?.duplicateSource,item._stats?.compendiumSource,id && `Item.${id}`].filter(Boolean));
  return documents(actor.items).find(owner => privateOwned(owner) && ownedFlags(owner)?.nightmare?.kind==='phobia' &&
    owner.system?.rules?.some(rule => rule.key==='EphemeralEffect' && sources.has(rule.uuid))) ?? null;
}

const privateText = text => /data-bob-private-note\s*=/.test(String(text ?? '')) ||
  [...String(text ?? '').matchAll(/data-bob-i18n=["']([^"']+)["']/g)].some(([,key])=>privateKey(key));
const markPrivateNote = text => /data-bob-private-note\s*=/.test(String(text ?? '')) ? text :
  `<div><div data-bob-private-note="true">${text}</div></div>`;

function protectNotes(item) {
  for (const rule of item.system?.rules ?? []) {
    if (rule.key!=='Note') continue;
    rule.visibility='gm';
    rule.text=markPrivateNote(rule.text);
  }
}

function neutralItem(item) {
  const flags=ownedFlags(item), hp=flags?.soulheartHP, life=flags?.soulheartLife;
  const value=hp ? item.system?.badge?.value : item.system?.rules?.find(rule=>rule.key==='TempHP')?.value;
  item.name=t(hp?'Common.CurrentHPName':life?'Common.CurrentTempHPName':'Common.CurrentEffectName');
  item.img='systems/pf2e/icons/default-icons/effect.svg';
  if (item.system?.description) {
    item.system.description.value=t(hp?'Common.CurrentHPDescription':life?'Common.CurrentTempHPDescription':'Common.CurrentEffectDescription',safeValues({value}));
    item.system.description.gm='';
  }
  // Native unidentified effects omit their source, timer, and expiry UI while preserving all rule mechanics.
  if (item.type==='effect') item.system.unidentified=true;
  for (const rule of item.system?.rules ?? []) {
    if (rule.key==='Note') {
      rule.title=t('Common.CurrentEffectName');
      rule.text=markPrivateNote(t('Common.CurrentEffectDescription'));
    } else if (rule.key==='FlatModifier' || rule.key==='RollOption' || rule.label) {
      rule.label=t('Common.CurrentModifier');
    }
  }
}

function preservePrivateIdentities(item) {
  const sluggify=globalThis.game?.pf2e?.system?.sluggify;
  if (!sluggify) return;
  // Native item.slug also falls back to item.name; capture it before any localized or neutral display name.
  if (item.system && !item.system.slug && item.name) item.system.slug=sluggify(item.name);
  const reduce=globalThis.game?.pf2e?.RuleElement?.prototype?.getReducedLabel;
  for (const rule of item.system?.rules ?? []) {
    if (rule.key!=='FlatModifier' || rule.slug) continue;
    const label=rule.label ? globalThis.game?.i18n?.format?.(rule.label,{actor:item.actor?.name,item:item.name,origin:item.origin?.name}) ?? rule.label : item.name;
    rule.slug=rule.type==='ability' && rule.ability ? rule.ability : sluggify(reduce?.call({parent:item,label}) ?? label);
  }
}

export function t(key, values = {}) {
  const id = fullKey(key);
  return globalThis.game?.i18n?.format?.(id, values) ?? id;
}

/** Store translation keys with owned data; each client prepares its own display. */
export function markLocalized(data, localization) {
  data.flags ??= {};
  data.flags[ID] = {...data.flags[ID], localization};
  translateItem(data);
  return data;
}

function ownedLocalization(item) {
  const flags=item.flags?.[ID];
  if (!flags) return null;
  const chapter=flags.nightmare?.chapter;
  if (flags.nightmare?.kind==='phobia'&&Number.isInteger(chapter)&&chapter>=1&&chapter<=9) {
    const rules=[];
    for (const [index,rule] of (item.system?.rules ?? []).entries()) {
      if (rule.key==='RollOption'&&rule.option==='lake-laroba-in-sight') rules.push({index,label:'Nightmare.DeepWaterVisible'});
      if (rule.key==='Note') rules.push({index,title:`Nightmare.Phobia${chapter}Name`,text:`Nightmare.Phobia${chapter}Description`});
    }
    return {...flags.localization,name:`Nightmare.Phobia${chapter}Name`,description:`Nightmare.Phobia${chapter}Description`,rules};
  }
  if (flags.localization) return flags.localization;
  // Older releases saved display text. Recognize only our own marked effects.
  if (flags.soulheartHP) return {name:'Soulheart.HPEffectName',description:'Soulheart.HPEffectDescription',values:{value:item.system?.badge?.value}};
  if (flags.soulheartLife) return {name:'Soulheart.LifeEffectName',description:'Soulheart.LifeEffectDescription',values:{value:item.system?.rules?.find(rule=>rule.key==='TempHP')?.value}};
  if (flags.nightmare?.kind==='unease') return {name:'Nightmare.UneaseName',description:'Nightmare.UneaseDescription'};
  if (!flags.boon) return null;
  const rules=item.system?.rules??[], modifier=rules.find(rule=>rule.key==='FlatModifier'),selectors=[modifier?.selector].flat();
  let type,values={};
  if (item.type==='feat'&&item.system?.slug==='pharasma-minor-boon') type='Gear';
  else if (selectors.includes('int-skill-check')) {type='Meditation';values={bonus:modifier.value};}
  else if (rules.some(rule=>rule.key==='GrantItem'&&rule.uuid==='Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg')) type='Stupefied';
  else if (modifier?.predicate?.includes('action:craft')) type='Bath';
  else if (selectors.some(selector=>['performance','crafting','athletics'].includes(selector))) {
    const skill=selectors.find(selector=>['performance','crafting','athletics'].includes(selector));
    type=`Statue.${skill[0].toUpperCase()}${skill.slice(1)}`;
  }
  if (!type) return null;
  const note=rules.findIndex(rule=>rule.key==='Note');
  return {name:`Boon.Effect.${type}.Name`,description:`Boon.Effect.${type}.Description`,values,
    rules:['Gear','Meditation'].includes(type)&&note>=0?[{index:note,title:`Boon.Effect.${type}.NoteTitle`,text:`Boon.Effect.${type}.NoteText`}]:[]};
}

export function translateItem(item) {
  const localization = ownedLocalization(item);
  const helper=helperOwner(item);
  if (!localization && !helper && !privateOwned(item)) return;
  // The native darkness adjustment targets this slug; it must not follow the translated name.
  if (item.flags?.[ID]?.nightmare?.kind==='phobia'&&item.flags[ID].nightmare.chapter===4) {
    for (const rule of item.system?.rules ?? []) {
      if (rule.key==='FlatModifier'&&!rule.slug&&[rule.selector].flat().includes('will')) rule.slug='nyctophobia';
    }
  }
  if (privateOwned(item)) preservePrivateIdentities(item);
  if (helper) {
    protectNotes(item);
    if (isPlayer()) {
      item.name=t('Common.CurrentEffectName');
      if (item.system?.description) item.system.description.value=t('Common.CurrentEffectDescription');
    }
  }
  if (!localization) {
    if (privateOwned(item)) {protectNotes(item);if (isPlayer()) neutralItem(item);}
    return;
  }
  const values=item.flags?.[ID]?.soulheartHP?{...localization.values,value:item.system?.badge?.value}:localization.values;
  if (localization.name) item.name = t(localization.name, values);
  if (localization.description && item.system?.description) {
    item.system.description.value = t(localization.description, safeValues(values));
  }
  for (const {index,values,...fields} of localization.rules ?? []) {
    const rule = item.system?.rules?.[index];
    if (!rule) continue;
    for (const [field,key] of Object.entries(fields)) {
      if (!['title','text','label'].includes(field)) continue;
      const parameters=values ?? localization.values;
      if (rule.key==='Note'&&field==='text') rule[field] = `<div>${localizeHTML(key,parameters)}</div>`;
      else if (rule.key==='Note'&&field==='title') rule[field] = localizeHTML(key,parameters);
      else rule[field] = t(key,field === 'text' ? safeValues(parameters) : parameters);
    }
  }
  if (privateOwned(item)) {
    protectNotes(item);
    if (isPlayer()) {
      neutralItem(item);
    }
  }
}

export function localizeHTML(key, values = {}, valueKeys = {}) {
  const body=t(key,safeValues(translatedValues(values,valueKeys)));
  const tag=/<(?:p|div|ul|ol|table|section)\b/i.test(body)?'div':'span';
  const keys=Object.keys(valueKeys).length?` data-bob-value-keys="${escape(JSON.stringify(valueKeys))}"`:'';
  return `<${tag} data-bob-i18n="${escape(fullKey(key))}" data-bob-values="${escape(JSON.stringify(values))}"${keys}>${body}</${tag}>`;
}

export function translateHTML(element,message) {
  const root = element?.[0] ?? element;
  const pending=[];
  if (isPlayer()) hidePrivateNotes(message,root);
  for (const node of root?.querySelectorAll?.('[data-bob-i18n]') ?? []) {
    if (!node.dataset.bobI18n?.startsWith('BOB.')) continue;
    if (isPlayer() && privateKey(node.dataset.bobI18n)) {
      const note=node.closest?.('.roll-note');
      if (note) {note.remove();continue;}
    }
    try {
      const key=isPlayer() && privateKey(node.dataset.bobI18n) ? publicTextKey(node.dataset.bobI18n) : node.dataset.bobI18n;
      const values=JSON.parse(node.dataset.bobValues ?? '{}'),valueKeys=JSON.parse(node.dataset.bobValueKeys ?? '{}');
      const html=t(key, safeValues(translatedValues(values,valueKeys)));
      const editor=globalThis.foundry?.applications?.ux?.TextEditor?.implementation;
      if (/@\w+\[/.test(html)&&editor?.enrichHTML) {
        pending.push(editor.enrichHTML(html,{secrets:false,rollData:message?.getRollData?.()}).then(value=>{node.innerHTML=value;}).catch(()=>{}));
      } else node.innerHTML=html;
    }
    catch { /* Leave the saved text readable if an old marker is malformed. */ }
  }
  return Promise.all(pending);
}

const environmentLabels={
  'bob-moon-initiative':'Rule.MoonInitiative','bob-moon-holy':'Rule.MoonHoly','bob-moon-fear':'Rule.MoonFear',
  'bob-weather-perception':'Rule.Weather','bob-weather-ranged':'Rule.Wind'
};

function messageActors(message) {
  const context=message?.flags?.pf2e?.context;
  return [...new Set([message?.actor,actorAt(context?.origin?.actor),actorAt(context?.target?.actor)].filter(Boolean))];
}

// These imported helper UUIDs are used only with a recorded, completed module phobia for the involved actor.
const historicalHelpers={3:['Item.EHMgAsmdOUqOGl3O'],5:['Item.2XdaFz49WGJtSoQG'],8:['Item.f5H0uN5KDCvM2q20']};
function recordedHelpers(actor) {
  let history;
  try {history=globalThis.game?.settings?.get?.(ID,'assistantState')?.nightmares;}
  catch {return [];}
  const sources=[];
  for (const [chapter,record] of Object.entries(history?.characters?.[actor.id]?.chapters ?? {})) {
    const result=history.sessions?.[record.sessionId]?.results?.[actor.id];
    if (!record.sessionId || !result?.applyPhobia || result.status!=='complete' || result.revealed===true) continue;
    if (documents(actor.items).some(item=>ownedFlags(item)?.nightmare?.chapter===Number(chapter) && revealed(item))) continue;
    for (const uuid of historicalHelpers[chapter] ?? []) {
      const item=globalThis.fromUuidSync?.(uuid) ?? globalThis.game?.items?.get?.(uuid.slice(5));
      if (item?.system?.rules?.some(rule=>rule.key==='Note')) sources.push(item);
    }
  }
  return sources;
}

function noteSources(message) {
  const sources=[];
  for (const actor of messageActors(message)) {
    for (const item of documents(actor.items)) {
      if (!privateOwned(item)) continue;
      if (item.system?.rules?.some(rule=>rule.key==='Note')) sources.push(item);
      for (const rule of item.system?.rules ?? []) {
        if (ownedFlags(item)?.nightmare?.kind!=='phobia' || rule.key!=='EphemeralEffect') continue;
        const native=globalThis.fromUuidSync?.(rule.uuid) ?? (/^Item\./.test(rule.uuid ?? '') && globalThis.game?.items?.get?.(rule.uuid.slice(5)));
        // An exact referenced helper identity is sufficient for scoped rendered-note matching.
        sources.push(native || {id:/^Item\.([^.]+)$/.exec(rule.uuid ?? '')?.[1],uuid:rule.uuid});
      }
    }
    sources.push(...recordedHelpers(actor));
  }
  return sources;
}

function matchesPrivateSource(note,sources) {
  return sources.some(item => {
    const title=String(note.title ?? ''), description=item.system?.description?.value;
    return (item.name && (title===item.name || title.startsWith(`${item.name} (`))) ||
      (description && (note.text===description || note.text===`<div>${description}</div>`));
  });
}

function hidePrivateNotes(message,root) {
  const sources=noteSources(message),ids=new Set(sources.flatMap(item=>[item.id,item._id]).filter(Boolean));
  for (const note of root?.querySelectorAll?.('.roll-note') ?? []) {
    if (ids.has(note.dataset?.itemId) || note.querySelector?.('[data-bob-private-note]') ||
      [...note.querySelectorAll?.('[data-bob-i18n]') ?? []].some(node=>privateKey(node.dataset?.bobI18n))) note.remove();
  }
  for (const marker of root?.querySelectorAll?.('[data-bob-private-note]') ?? []) marker.closest?.('.roll-note')?.remove();
}

/** Preserve only our label keys alongside native rolls, including after an effect expires. */
export function markRollLabels(message) {
  const labels=[],previous=rollLabels(message),items=messageActors(message).flatMap(actor=>documents(actor.items));
  for (const modifier of message.flags?.pf2e?.modifiers ?? []) {
    // Native RollInspector includes disabled rows; presentation receipts cover every owned modifier.
    if (!Number.isFinite(modifier.modifier)) continue;
    const item=modifier.source?items.find(item=>item.uuid===modifier.source):null;
    const localization=ownedLocalization(item ?? {});
    const saved=modifierLabel(previous,modifier),name=environmentLabels[modifier.slug] ?? localization?.name ?? saved?.name;
    if (name) labels.push({slug:modifier.slug,...(modifier.source?{source:modifier.source}:{}),name,values:localization?.values ?? saved?.values ?? {},value:modifier.modifier,
      ...((item?revealed(item):saved?.revealed)?{revealed:true}:{})});
  }
  const update={},privateContext=privateRollContext(message);
  if (privateContext) update[`flags.${ID}.privateRollContext`]=true;
  if (labels.length) {
    update[`flags.${ID}.rollLabels`]=labels;
    update['flags.pf2e.modifiers']=(message.flags.pf2e.modifiers ?? []).map(modifier=>{
      const label=modifierLabel(labels,modifier);
      return label && !label.revealed ? {...modifier,label:t(publicName(label.name),label.values)} : modifier;
    });
  }
  const sources=noteSources(message),notes=message.flags?.pf2e?.context?.notes;
  if (Array.isArray(notes)) {
    const safe=notes.map(note => privateText(note.text) || privateText(note.title) || matchesPrivateSource(note,sources)
      ? {...note,visibility:'gm',text:markPrivateNote(note.text)} : note);
    if (safe.some((note,index)=>note!==notes[index])) update['flags.pf2e.context.notes']=safe;
  }
  if (globalThis.document?.createElement && message.flavor && (labels.length || privateContext || sources.length || privateText(message.flavor))) {
    const container=document.createElement('div');container.innerHTML=message.flavor;
    let flavorChanged=false;
    if (privateContext && !hasPrivateContext(message.flavor)) {
      container.insertAdjacentHTML('beforeend','<span hidden data-bob-private-context="true"></span>');
      flavorChanged=true;
    }
    for (const node of container.querySelectorAll('.tags.modifiers [data-slug]')) {
      const modifier=message.flags?.pf2e?.modifiers?.find(modifier=>modifier.slug===node.dataset.slug && modifier.enabled);
      const label=modifier?modifierLabel(labels,modifier):labels.find(label=>label.slug===node.dataset.slug);
      if (!label) continue;
      node.dataset.bobRollLabel=label.name;
      node.dataset.bobRollValues=JSON.stringify(label.values);
      node.dataset.bobRollValue=String(label.value);
      if (label.source) node.dataset.bobRollSource=label.source;
      if (label.revealed) node.dataset.bobRollRevealed='true';
      flavorChanged=true;
    }
    // Disabled modifiers have no native chat tag. Hidden receipts survive native rerolls, which copy flavor but omit our flags.
    const marked=[...container.querySelectorAll('[data-bob-roll-label]')];
    for (const label of labels) {
      if (marked.some(node=>node.dataset.slug===label.slug && (node.dataset.bobRollSource ?? '')===(label.source ?? ''))) continue;
      container.insertAdjacentHTML('beforeend',`<span hidden data-bob-roll-label="${escape(label.name)}" data-slug="${escape(label.slug)}" data-bob-roll-source="${escape(label.source ?? '')}" data-bob-roll-values="${escape(JSON.stringify(label.values))}" data-bob-roll-value="${escape(label.value)}"${label.revealed?' data-bob-roll-revealed="true"':''}></span>`);
      flavorChanged=true;
    }
    const ids=new Set(sources.flatMap(item=>[item.id,item._id]).filter(Boolean));
    for (const note of container.querySelectorAll('.roll-note')) {
      if (ids.has(note.dataset.itemId) || privateText(note.innerHTML)) {
        note.dataset.visibility='gm';
        note.dataset.bobPrivateNote='true';
        flavorChanged=true;
      }
    }
    // Native rerolls retain flavor but may drop other modules' flags.
    if (flavorChanged) update.flavor=container.innerHTML;
  }
  if (!Object.keys(update).length) return;
  message.updateSource(update);
}

export function translateRollLabels(message,element) {
  const labels=rollLabels(message);
  const root=element?.[0] ?? element;
  for (const node of root?.querySelectorAll?.('.tags.modifiers [data-slug]') ?? []) {
    const modifier=message.flags?.pf2e?.modifiers?.find(modifier=>modifier.slug===node.dataset.slug && modifier.enabled!==false && !modifier.ignored);
    let label=modifier?modifierLabel(labels,modifier):labels.find(label=>label.slug===node.dataset.slug);
    if (node.dataset.bobRollLabel) {
      try {label={name:node.dataset.bobRollLabel,values:JSON.parse(node.dataset.bobRollValues??'{}'),value:Number(node.dataset.bobRollValue),revealed:node.dataset.bobRollRevealed==='true'};}
      catch { /* Keep saved text if a marker is malformed. */ }
    }
    if (label && typeof label.name==='string' && Number.isFinite(label.value)) {
      const name=isPlayer() && !label.revealed ? publicName(label.name) : label.name;
      node.textContent=`${t(name,label.values)} ${label.value>=0?'+':''}${label.value}`;
    }
  }
}

function rollLabels(message) {
  const labels=[...(message.flags?.[ID]?.rollLabels ?? [])];
  if (globalThis.document?.createElement && message.flavor) {
    const container=document.createElement('div');container.innerHTML=message.flavor;
    for (const node of container.querySelectorAll('[data-bob-roll-label]')) {
      const value=Number(node.dataset.bobRollValue);
      try {
        if (Number.isFinite(value)) labels.push({slug:node.dataset.slug,source:node.dataset.bobRollSource || undefined,name:node.dataset.bobRollLabel,
          values:JSON.parse(node.dataset.bobRollValues ?? '{}'),value,revealed:node.dataset.bobRollRevealed==='true'});
      } catch { /* A malformed old receipt cannot identify a native modifier safely. */ }
    }
    // Legacy native rolls already carry exact module Note provenance, even after their effect is gone.
    for (const note of container.querySelectorAll('.roll-note[data-item-id]')) {
      const id=note.dataset.itemId;
      if (!id) continue;
      for (const node of note.querySelectorAll('[data-bob-i18n]')) {
        const key=plainKey(node.dataset.bobI18n),boon=/^(Boon\.Effect\..+)\.(?:NoteTitle|NoteText)$/.exec(key);
        const phobia=/^Nightmare\.Phobia([1-9])(?:Name|Description)$/.exec(key);
        const name=boon?`${boon[1]}.Name`:phobia?`Nightmare.Phobia${phobia[1]}Name`:null;
        if (!name) continue;
        let values;
        try {values=JSON.parse(node.dataset.bobValues ?? '{}');} catch {continue;}
        for (const modifier of message.flags?.pf2e?.modifiers ?? []) {
          if (!modifier.source?.endsWith(`.Item.${id}`) || !Number.isFinite(modifier.modifier)) continue;
          labels.push({slug:modifier.slug,source:modifier.source,name,values,value:modifier.modifier});
        }
      }
    }
  }
  return labels;
}

function modifierLabel(labels,modifier) {
  if (!modifier) return null;
  return labels.find(label=>label.slug===modifier.slug && label.source && label.source===modifier.source) ??
    labels.find(label=>label.slug===modifier.slug && !label.source) ?? null;
}

const hasPrivateContext = flavor => /data-bob-private-context=["']true["']/.test(String(flavor ?? ''));
function privateRollContext(message) {
  const options=message.flags?.pf2e?.context?.options ?? [];
  return message.flags?.[ID]?.privateRollContext===true || hasPrivateContext(message.flavor) || privateText(message.flavor) ||
    documents(options).some(option=>/^(?:bob-nightmare|bob-boon|bob-hazard):/.test(option)) ||
    messageActors(message).some(actor=>documents(actor.items).some(privateOwned)) || noteSources(message).length>0;
}

const weatherDisplay=new Map([
  ['bob-cold-drizzle','ColdDrizzle'],['bob-cold-rain','ColdRain'],['bob-cold-overcast','ColdOvercast'],
  ['bob-cold-thunderstorm','ColdThunderstorm'],['bob-severe-thunderstorm','SevereThunderstorm'],['bob-cold-snow','ColdSnow']
]);

/** Copy only Calendaria's displayed weather/preset/period paths; native storage and physical weather stay authoritative. */
function weatherView(value) {
  if (Array.isArray(value)) {
    const records=value.map(weatherView);
    return records.some((record,index)=>record!==value[index])?records:value;
  }
  if (!value || typeof value!=='object') return value;
  const type=weatherDisplay.get(value.id);
  let copy=type?{...value,label:t(`Weather.Display.${type}.Label`),description:t(`Weather.Display.${type}.Description`)}:null;
  if (value.preset) {
    const preset=weatherView(value.preset);
    if (preset!==value.preset) (copy??={...value}).preset=preset;
  }
  if (value.periods && typeof value.periods==='object') {
    const periods=Object.fromEntries(Object.entries(value.periods).map(([key,period])=>[key,weatherView(period)]));
    if (Object.keys(periods).some(key=>periods[key]!==value.periods[key])) (copy??={...value}).periods=periods;
  }
  return copy??value;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return t('Common.Unknown');
  const minutes = Math.max(0,Math.ceil(seconds / 60));
  if (minutes < 60) return t('Common.Minutes',{value:minutes});
  if (minutes < 1440) return t('Common.HoursMinutes',{hours:Math.floor(minutes/60),minutes:minutes%60});
  return t('Common.DaysHours',{days:Math.floor(minutes/1440),hours:Math.floor(minutes%1440/60)});
}

export function formatTime(at) {
  if (!Number.isFinite(at)) return t('Common.Unknown');
  const game = globalThis.game, current = game?.pf2e?.worldClock?.worldTime;
  if (current?.isValid !== false && typeof current?.plus === 'function' && Number.isFinite(game?.time?.worldTime)) {
    const offset = globalThis.CONFIG?.PF2E?.worldClock?.[game.pf2e.worldClock.dateTheme]?.yearOffset ?? 0;
    const date = current.plus({seconds:at-game.time.worldTime,years:offset});
    if (date.isValid !== false) return date.toFormat('yyyy-MM-dd HH:mm');
  }
  const delta = at - (game?.time?.worldTime ?? 0);
  if (Math.abs(delta) < 60) return t('Common.Now');
  return t(delta < 0 ? 'Common.Ago' : 'Common.In',{duration:formatDuration(Math.abs(delta))});
}

export function preferredActor(candidates) {
  const actors = Array.from(candidates ?? []);
  const ids = [globalThis.canvas?.tokens?.controlled?.[0]?.actor?.id,globalThis.game?.user?.character?.id,
    ...Array.from(globalThis.game?.actors?.party?.members ?? [],actor => actor.id)];
  for (const id of ids) { const actor = actors.find(actor => actor.id === id); if (actor) return actor; }
  return actors[0] ?? null;
}

export function registerI18n() {
  let installed=false;
  const weatherInstalled=new Set();
  const installWeather=() => {
    const manager=globalThis.CALENDARIA?.managers?.WeatherManager;
    if (!globalThis.libWrapper || !manager) return;
    for (const method of ['getCurrentWeather','getForecast','resolveDisplayLabel']) {
      if (weatherInstalled.has(method) || typeof manager[method]!=='function' || Object.getOwnPropertyDescriptor(manager,method)?.configurable===false) continue;
      libWrapper.register(ID,`CALENDARIA.managers.WeatherManager.${method}`,function(wrapped,...args) {
        const result=wrapped(...args);
        if (!isPlayer()) return result;
        if (method==='resolveDisplayLabel') {
          const type=weatherDisplay.get(args[0]);
          return type?t(`Weather.Display.${type}.Label`):result;
        }
        return weatherView(result);
      },'WRAPPER');
      weatherInstalled.add(method);
    }
  };
  const install=() => {
    if (installed || !globalThis.libWrapper || !globalThis.CONFIG?.Item?.documentClass) return;
    installed=true;
    libWrapper.register(ID,'CONFIG.Item.documentClass.prototype.prepareData',function(wrapped,...args) {
      const result = wrapped(...args);
      translateItem(this);
      return result;
    },'WRAPPER');
    if (globalThis.CONFIG?.PF2E?.Item?.documentClasses?.effect?.prototype?.handleChange) {
      libWrapper.register(ID,'CONFIG.PF2E.Item.documentClasses.effect.prototype.handleChange',function(wrapped,change,...args) {
        if (!isPlayer() || !privateOwned(this) || !change?.delete) return wrapped(change,...args);
        // PF2e deletion floaties use a copied _source.name; preserve the document and sanitize only that display payload.
        const flags=ownedFlags(this),name=t(flags.soulheartHP?'Common.CurrentHPName':flags.soulheartLife?'Common.CurrentTempHPName':'Common.CurrentEffectName');
        return wrapped({...change,delete:{...change.delete,name}},...args);
      },'WRAPPER');
    }
    if (globalThis.game?.pf2e?.RuleElements?.all?.TempHP?.prototype?.broadcast) {
      libWrapper.register(ID,'game.pf2e.RuleElements.all.TempHP.prototype.broadcast',function(wrapped,...args) {
        if (!privateOwned(this.item) || !ownedFlags(this.item)?.soulheartLife) return wrapped(...args);
        // Native PF2e builds its owner notice synchronously from item.name rather than the rule label.
        const name=this.item.name;
        try {this.item.name=t('Common.CurrentTempHPName');return wrapped(...args);}
        finally {this.item.name=name;}
      },'WRAPPER');
    }
  };
  // Foundry initializes world documents before setup. Main calls this from init, before embedded rule construction.
  install();
  installWeather();
  Hooks.once('calendaria.init',installWeather);
  Hooks.once('setup',()=>{install();installWeather();});
  Hooks.on('preCreateChatMessage', message => markRollLabels(message));
  Hooks.on('renderChatMessageHTML', (message,element) => {void translateHTML(element,message);translateRollLabels(message,element);});
  Hooks.on('renderItemSheet', (app,element) => {
    if (!isPlayer() || !privateOwned(app.item)) return;
    const root=element?.[0] ?? element;
    const name=root?.querySelector?.('.sheet-header input[name="name"]');
    if (name) {name.value=app.item.name;name.readOnly=true;name.removeAttribute('name');}
    const image=root?.querySelector?.('.sheet-header img[data-edit="img"]');
    if (image) {image.src=app.item.img;image.removeAttribute('data-edit');}
    for (const node of root?.querySelectorAll?.('[data-tab="rules"], [data-tab="details"], .sidebar, .editor-edit, .sheet-header tagify-tags[name="system.traits.value"], .sheet-header .traits-extra') ?? []) node.remove();
  });
  Hooks.on('renderActorSheet', (app,element) => {
    if (!isPlayer()) return;
    const root=element?.[0] ?? element;
    const ids=new Set(documents(app.actor?.items).filter(item=>privateOwned(item) && ownedFlags(item)?.nightmare).map(item=>item.id));
    for (const node of root?.querySelectorAll?.('[data-option-toggles] [data-item-id]') ?? []) if (ids.has(node.dataset.itemId)) node.remove();
    const header=root?.querySelector?.('[data-tab="effects"] header[data-group-id="intercession"]');
    const rows=documents(header?.nextElementSibling?.querySelectorAll?.(':scope > li[data-item-id]'));
    if (rows.length && rows.every(row=>documents(app.actor?.items).some(item=>item.id===row.dataset.itemId && privateOwned(item) && ownedFlags(item)?.boon))) {
      // Also remove the native Browse button: its category filter would disclose this private-only classification.
      header.textContent=t('Common.CurrentEffectName');
    }
  });
  Hooks.on('renderEffectsPanel', (_app,element,context) => {
    if (!isPlayer()) return;
    const root=element?.[0] ?? element,ids=new Set(documents(context?.actor?.items).filter(privateOwned).map(item=>item.id));
    for (const row of root?.querySelectorAll?.('.effect-item[data-item-id]') ?? []) if (ids.has(row.dataset.itemId)) row.querySelector('.expired')?.remove();
  });
  Hooks.on('renderRollInspector', (app,element) => {
    if (!isPlayer() || !app.message) return;
    const root=element?.[0] ?? element,labels=rollLabels(app.message);
    let privateDetails=false;
    for (const row of root?.querySelectorAll?.('.modifier-list li[data-type="modifier"][data-idx]') ?? []) {
      const modifier=app.message.flags?.pf2e?.modifiers?.[Number(row.dataset.idx)];
      const label=modifierLabel(labels,modifier);
      if (!label || label.revealed || publicName(label.name)===label.name) continue;
      const node=row.querySelector('.label-slug');
      if (node) node.textContent=`${t(publicName(label.name))} ${label.value>=0?'+':''}${label.value}`;
      row.querySelector('.options-note')?.remove();
      privateDetails=true;
    }
    if (privateDetails || privateRollContext(app.message)) root?.querySelector?.('.roll-options')?.remove();
  });
}
