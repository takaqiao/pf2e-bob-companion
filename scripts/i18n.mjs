const ID = 'pf2e-bob-companion';
const fullKey = key => key.startsWith('BOB.') ? key : `BOB.${key}`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const safeValues = values => Object.fromEntries(Object.entries(values ?? {}).map(([key,value]) => [key,escape(value)]));

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
  if (!localization) return;
  // The native darkness adjustment targets this slug; it must not follow the translated name.
  if (item.flags?.[ID]?.nightmare?.kind==='phobia'&&item.flags[ID].nightmare.chapter===4) {
    for (const rule of item.system?.rules ?? []) {
      if (rule.key==='FlatModifier'&&!rule.slug&&[rule.selector].flat().includes('will')) rule.slug='nyctophobia';
    }
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
}

export function localizeHTML(key, values = {}) {
  const body=t(key,safeValues(values));
  const tag=/<(?:p|div|ul|ol|table|section)\b/i.test(body)?'div':'span';
  return `<${tag} data-bob-i18n="${escape(fullKey(key))}" data-bob-values="${escape(JSON.stringify(values))}">${body}</${tag}>`;
}

export function translateHTML(element,message) {
  const root = element?.[0] ?? element;
  const pending=[];
  for (const node of root?.querySelectorAll?.('[data-bob-i18n]') ?? []) {
    if (!node.dataset.bobI18n?.startsWith('BOB.')) continue;
    try {
      const html=t(node.dataset.bobI18n, safeValues(JSON.parse(node.dataset.bobValues ?? '{}')));
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

/** Preserve only our label keys alongside native rolls, including after an effect expires. */
export function markRollLabels(message) {
  const labels=[];
  for (const modifier of message.flags?.pf2e?.modifiers ?? []) {
    if (!modifier.enabled || !Number.isFinite(modifier.modifier)) continue;
    const item=modifier.source?Array.from(message.actor?.items ?? []).find(item=>item.uuid===modifier.source):null;
    const localization=ownedLocalization(item ?? {});
    const name=environmentLabels[modifier.slug] ?? localization?.name;
    if (name) labels.push({slug:modifier.slug,name,values:localization?.values ?? {},value:modifier.modifier});
  }
  if (!labels.length) return;
  const update={[`flags.${ID}.rollLabels`]:labels};
  if (globalThis.document?.createElement && message.flavor) {
    const container=document.createElement('div');container.innerHTML=message.flavor;
    for (const node of container.querySelectorAll('.tags.modifiers [data-slug]')) {
      const label=labels.find(label=>label.slug===node.dataset.slug);
      if (!label) continue;
      node.dataset.bobRollLabel=label.name;
      node.dataset.bobRollValues=JSON.stringify(label.values);
      node.dataset.bobRollValue=String(label.value);
    }
    // Native rerolls retain flavor but may drop other modules' flags.
    update.flavor=container.innerHTML;
  }
  message.updateSource(update);
}

export function translateRollLabels(message,element) {
  const labels=message.flags?.[ID]?.rollLabels;
  const root=element?.[0] ?? element;
  for (const node of root?.querySelectorAll?.('.tags.modifiers [data-slug]') ?? []) {
    let label=Array.isArray(labels)?labels.find(label=>label.slug===node.dataset.slug):null;
    if (node.dataset.bobRollLabel) {
      try {label={name:node.dataset.bobRollLabel,values:JSON.parse(node.dataset.bobRollValues??'{}'),value:Number(node.dataset.bobRollValue)};}
      catch { /* Keep saved text if a marker is malformed. */ }
    }
    if (label && typeof label.name==='string' && Number.isFinite(label.value)) {
      node.textContent=`${t(label.name,label.values)} ${label.value>=0?'+':''}${label.value}`;
    }
  }
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
  Hooks.once('setup', () => {
    if (!globalThis.libWrapper || !globalThis.CONFIG?.Item?.documentClass) return;
    libWrapper.register(ID,'CONFIG.Item.documentClass.prototype.prepareData',function(wrapped,...args) {
      const result = wrapped(...args);
      translateItem(this);
      return result;
    },'WRAPPER');
  });
  Hooks.on('preCreateChatMessage', message => markRollLabels(message));
  Hooks.on('renderChatMessageHTML', (message,element) => {void translateHTML(element,message);translateRollLabels(message,element);});
}
