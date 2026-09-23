import {ID} from './model.mjs';
import {getEnvironment} from './runtime.mjs';
import {readState,updateState,withAction,requirePrimaryGM,isPrimaryGM,now,escapeHtml,partyMembers,loadEffect,whisperGM} from './assistant-core.mjs';
import {recordBoon,consumeBoon,transferBoon,correctBoon,voidBoon,cooldownRemaining,c45Active,expireBoons} from './boon-model.mjs';
import {t,markLocalized,localizeHTML,formatTime,formatDuration,preferredActor} from './i18n.mjs';

const SOURCES = {A19:'Item.Y2ix3ISFWBhXLsE0',G4:'Item.0vmwZrIhm5rWHkYh'};
const SHELYN = 'Compendium.pf2e.adventure-specific-actions.Item.8Ze3B6HWu2fyKETM';
const STUPEFIED = 'Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg';
const SPELLS = {performance:['sure-footing','Boon.Spell.SureFooting'],crafting:['clear-mind','Boon.Spell.ClearMind'],athletics:['sound-body','Boon.Spell.SoundBody']};
const LABELS = {A14:'Boon.A14',A19:'Boon.A19',C45:'Boon.C45',G4:'Boon.G4'};
const label = kind => t(LABELS[kind]);
const flag = item => item.flags?.[ID]?.boon;
const signature = use => JSON.stringify([use.id,use.actorId,use.at,use.expiresAt,use.bonus,use.condition,use.choice,use.corrections?.length??0]);
const alive = use => !use.voided && use.consumedAt == null && !use.expired;
const nativeGearBoon = item => item.type==='feat' && (item.system?.slug==='pharasma-minor-boon'||item.sourceId===SOURCES.G4);

/** Native PF2e effect/feat data. No source location or future rewards in player text. */
export function boonEffectData(use,source,at = use.at) {
  const data = source ? structuredClone(source) : {type:'effect',img:'systems/pf2e/icons/default-icons/effect.svg',system:{level:{value:1},traits:{value:[]}}};
  delete data._id;delete data._stats;delete data.folder;delete data.ownership;
  data.flags = {[ID]:{boon:{id:use.id,signature:signature(use)}}};
  data.system ??= {};
  let nameKey,descriptionKey,values={},rules=[];
  if (use.kind === 'A14' && use.bonus) {
    nameKey='Boon.Effect.Meditation.Name';descriptionKey='Boon.Effect.Meditation.Description';values={bonus:use.bonus};
    data.system.rules = [{key:'FlatModifier',selector:['int-skill-check'],type:'circumstance',value:use.bonus},
      {key:'Note',selector:['int-skill-check'],title:t('Boon.Effect.Meditation.NoteTitle'),text:t('Boon.Effect.Meditation.NoteText')}];
    rules=[{index:1,title:'Boon.Effect.Meditation.NoteTitle',text:'Boon.Effect.Meditation.NoteText'}];
  } else if (use.kind === 'A14' && use.condition) {
    nameKey='Boon.Effect.Stupefied.Name';descriptionKey='Boon.Effect.Stupefied.Description';
    data.system.rules = [{key:'GrantItem',uuid:STUPEFIED,inMemoryOnly:true}];
  } else if (use.kind === 'A19') {
    if (!source || !use.crossedDawn) return null;
    nameKey='Boon.Effect.Bath.Name';descriptionKey='Boon.Effect.Bath.Description';
  } else if (use.kind === 'C45') {
    const skill={performance:'Performance',crafting:'Crafting',athletics:'Athletics'}[use.choice];
    nameKey=`Boon.Effect.Statue.${skill}.Name`;descriptionKey=`Boon.Effect.Statue.${skill}.Description`;
    data.system.rules = [{key:'FlatModifier',selector:[use.choice],type:'item',value:1}];
  } else if (use.kind === 'G4') {
    if (!source) throw new Error(t('Boon.Error.NativeBoon'));
    nameKey='Boon.Effect.Gear.Name';descriptionKey='Boon.Effect.Gear.Description';
    data.system.rules = [{key:'Note',selector:'all',title:t('Boon.Effect.Gear.NoteTitle'),text:t('Boon.Effect.Gear.NoteText')}];
    rules=[{index:0,title:'Boon.Effect.Gear.NoteTitle',text:'Boon.Effect.Gear.NoteText'}];
  } else return null;
  data.system.description = {value:t(descriptionKey,values),gm:''};
  markLocalized(data,{name:nameKey,description:descriptionKey,values,rules});
  if (data.type === 'effect') {
    data.system.slug = 'bob-current-boon';
    data.system.duration = {unit:'minutes',value:Math.max(0,(use.expiresAt-at)/60),expiry:'turn-start',sustained:false};
    data.system.start = {value:at,initiative:null};
    data.system.tokenIcon = {show:true};
    data.system.unidentified = false;
  }
  return data;
}

/** The injected boundary is Foundry documents + the serialized GM state store. */
export function createBoonController(deps) {
  let roomSignature;
  const run = task => deps.serialize(async () => {deps.requirePrimary();return task();});
  const actorsFor = use => [...new Set([use.actorId,...(use.transfers??[]).flatMap(move=>[move.from,move.to]),...(use.holders??[])])];
  const owned = (actor,id) => Array.from(actor?.items??[]).filter(item=>flag(item)?.id===id);
  async function remove(actor,id) {
    const items = owned(actor,id);
    if (items.length) {deps.requirePrimary();await actor.deleteEmbeddedDocuments('Item',items.map(item=>item.id));}
  }
  async function ensure(actor,use) {
    if (!actor) throw new Error(t('Boon.Error.ActorMissing'));
    const existing = owned(actor,use.id);
    if(!existing.length&&use.kind==='G4') {
      const native=Array.from(actor.items??[]).filter(item=>nativeGearBoon(item)&&!flag(item));
      if(native.length>1)throw new Error(t('Boon.Error.MultipleNative'));
      existing.push(...native);
    }
    if (existing.length === 1 && flag(existing[0])?.signature === signature(use)) return;
    const source = ['A19','G4'].includes(use.kind) ? await deps.load(use.kind) : null;
    const data = boonEffectData(use,source,deps.time());
    if (!data) return;
    deps.requirePrimary();
    if (existing.length) {
      await actor.updateEmbeddedDocuments('Item',[{_id:existing[0].id,...data}]);
      if (existing.length > 1) {deps.requirePrimary();await actor.deleteEmbeddedDocuments('Item',existing.slice(1).map(item=>item.id));}
    } else await actor.createEmbeddedDocuments('Item',[data]);
  }
  async function reconcile(id) {
    const use = deps.read().uses?.[id];
    if (!use) return;
    if (use.kind === 'C45') {roomSignature = undefined;return syncRoom();}
    const keep = alive(use) && (use.expiresAt == null || (deps.time() >= use.at && deps.time() < use.expiresAt));
    for (const actorId of actorsFor(use)) if (!keep || actorId !== use.actorId) await remove(deps.actor(actorId),id);
    if (keep && (use.kind !== 'A19' || use.crossedDawn)) await ensure(deps.actor(use.actorId),use);
    await deps.update(state => {state.uses[id].status='done';delete state.uses[id].error;});
  }
  async function recover(id) {
    try {await reconcile(id);} catch (error) {
      await deps.update(state => {state.uses[id].status='pending';state.uses[id].error=String(error.message??error);});
      throw error;
    }
    return deps.read().uses[id];
  }
  async function syncRoom(recalculate=false) {
    const state = deps.read(), env = deps.environment(), time = deps.time();
    const use = Object.values(state.uses??{}).filter(use=>use.kind==='C45').sort((a,b)=>b.at-a.at)[0];
    if (!use) return;
    const day = env.valid && !env.night && deps.enabled() && state.enabled !== false;
    const members = c45Active(use,{at:time,inRoom:true,day}) ? deps.roomActors(state.binding,recalculate) : [];
    const ids = members.map(actor=>actor.uuid??actor.id).sort();
    const nextSignature = JSON.stringify([signature(use),ids,alive(use),day]);
    if (nextSignature === roomSignature) return;
    // Historical holders are included so a missed expiry or failed deletion can recover.
    const prior = Object.values(state.uses??{}).filter(entry=>entry.kind==='C45');
    for (const entry of prior) for (const actorId of entry.holders??[]) if (entry.id !== use.id || !ids.includes(actorId)) await remove(deps.actor(actorId),entry.id);
    // Reserve holders before creating native effects, so a partial failure stays recoverable.
    if (JSON.stringify(use.holders??[]) !== JSON.stringify(ids)) await deps.update(draft=>{draft.uses[use.id].holders=[...new Set([...(use.holders??[]),...ids])];});
    for (const actor of members) await ensure(actor,use);
    await deps.update(draft=>{draft.uses[use.id].holders=ids;draft.uses[use.id].status='done';delete draft.uses[use.id].error;});
    roomSignature=nextSignature;
  }
  return {
    use:input=>run(async()=>{await deps.update(state=>{recordBoon(state,input);});return recover(input.id);}),
    retry:id=>run(()=>recover(id)),
    consume:input=>run(async()=>{await deps.update(state=>{consumeBoon(state,input);});return recover(input.useId);}),
    transfer:input=>run(async()=>{
      const recipient=deps.actor(input.actorId);if (!recipient) throw new Error(t('Boon.Error.RecipientMissing'));
      if(Array.from(recipient.items??[]).some(item=>nativeGearBoon(item)&&!flag(item)))throw new Error(t('Boon.Error.RecipientNative'));
      await deps.update(state=>{transferBoon(state,input);});return recover(input.useId);
    }),
    correct:input=>run(async()=>{await deps.update(state=>{correctBoon(state,input);});return recover(input.useId);}),
    void:input=>run(async()=>{await deps.update(state=>{voidBoon(state,input);});return recover(input.useId);}),
    resolve:(useId,note)=>run(async()=>{if(!note?.trim())throw new Error(t('Boon.Error.ResolutionNote'));await deps.update(state=>{
      const use=state.uses?.[useId];if(!use)throw new Error(t('Boon.Error.RecordMissing'));use.diseasePending=false;use.cleansePending=false;use.resolution={at:deps.time(),note};
    });}),
    configure:config=>run(async()=>{await deps.update(state=>{Object.assign(state,config);});roomSignature=undefined;await syncRoom();}),
    syncRoom:(recalculate=false)=>run(()=>syncRoom(recalculate)),
    tick:at=>run(async()=>{
      if (!deps.enabled() || deps.read().enabled===false) return;
      const before=deps.read();
      const expiring=Object.values(before.uses??{}).filter(use=>alive(use)&&use.expiresAt!=null&&at>=use.expiresAt);
      if(expiring.length) {await deps.update(state=>{expireBoons(state,at);});for(const use of expiring) await recover(use.id);}
      await syncRoom();
    })
  };
}

let controller,registered=false;
const newId = () => foundry.utils.randomID();
const state = () => readState('boons');
const enabled = () => game.settings.get(ID,'config')?.enabled !== false;
const actorByRef = ref => game.actors.get(ref) ?? globalThis.fromUuidSync?.(ref);
export function boonRoomActors(binding,game=globalThis.game,recalculate=false) {
  if (!binding?.sceneId || !binding?.regionId) return [];
  if(game.scenes?.active?.id!==binding.sceneId)return [];
  const scene = game.scenes.get(binding.sceneId);
  const region=scene?.regions?.get(binding.regionId);
  if (!region) return [];
  const tokens=Array.from(scene.tokens??[]);
  // Region edits refresh token membership with noHook, after the Region hook. Use native
  // geometry once per token for that event; ordinary movement/time only reads membership.
  const membership=new Map(tokens.map(token=>[token,recalculate?token.testInsideRegion(region):Array.from(token.regions??[]).some(member=>(member.id??member)===binding.regionId)]));
  const inside=token=>membership.get(token);
  // A shared actor cannot have two different effect states. Conflicting linked tokens stay unmodified.
  const outsideLinked=new Set(tokens.filter(token=>token.actorLink&&!inside(token)).map(token=>token.actorId));
  return [...new Map(tokens.filter(token=>inside(token)&&!(token.actorLink&&outsideLinked.has(token.actorId)))
    .map(token=>token.actor).filter(actor=>['character','npc','familiar'].includes(actor?.type)).map(actor=>[actor.uuid,actor])).values()];
}
const roomActors=(binding,recalculate=false)=>boonRoomActors(binding,globalThis.game,recalculate);
async function officialSource(kind) {
  if(kind==='A19') return loadEffect(SOURCES[kind]);
  const doc=await fromUuid(SOURCES[kind]);
  if(doc?.type!=='feat'||typeof doc.toObject!=='function') throw new Error(t('Boon.Error.NativeSource'));
  return doc.toObject();
}
function getController() {
  return controller ??= createBoonController({read:state,update:fn=>updateState('boons',fn),serialize:fn=>withAction('boons',fn),
    requirePrimary:requirePrimaryGM,actor:actorByRef,load:officialSource,time:now,roomActors,environment:getEnvironment,enabled});
}
const notice = error => ui.notifications.error(error.message??String(error));
const field = (name,label,html) => `<div class="form-group"><label for="boon-${name}">${escapeHtml(label)}</label><div class="form-fields">${html}</div></div>`;
const number = (name,label,value) => field(name,label,`<input id="boon-${name}" name="${name}" type="number" step="any" value="${escapeHtml(value)}" required>`);
const check = (name,label,checked=false) => field(name,label,`<input id="boon-${name}" name="${name}" type="checkbox" ${checked?'checked':''}>`);
const options = (entries,selected) => entries.map(([value,label])=>`<option value="${escapeHtml(value)}" ${value===selected?'selected':''}>${escapeHtml(label)}</option>`).join('');
const select = (name,label,entries,selected) => field(name,label,`<select id="boon-${name}" name="${name}">${options(entries,selected)}</select>`);
const actorSelect = (selected) => {const actors=partyMembers();return select('actorId',t('Boon.Actor'),actors.map(actor=>[actor.uuid,actor.name]),selected??preferredActor(actors)?.uuid);};
const dataFrom = dialog => new FormData(dialog.element.querySelector('form'));
async function prompt(title,content,button='Boon.Record') {
  return foundry.applications.api.DialogV2.wait({window:{title:`BoB｜${t(title)}`},position:{width:610},classes:['bob-companion'],content,
    buttons:[{action:'confirm',label:t(button),callback:(_event,_button,dialog)=>dataFrom(dialog)},{action:'cancel',label:t('Boon.Cancel'),callback:()=>null}],rejectClose:false});
}
const value = (data,key) => Number(data.get(key));
const confirmed = data => {if(!data.get('confirmed'))throw new Error(t('Boon.Error.ConfirmConditions'));};
const elapsed = seconds => seconds>0?formatDuration(seconds):t('Boon.Ready');
const paragraph = (key,values) => `<p>${t(key,values)}</p>`;
const minutesAgo = at => number('minutesAgo',t('Boon.MinutesAgo'),0)+`<small>${t('Boon.CompletedAt',{time:formatTime(at)})}</small>`;

/** The PF2e clock gives local time of day; never infer a dawn from missing data. */
export function boonBathClock({at,now:current,environment}) {
  const seconds=environment?.seconds,dawn=environment?.dawn;
  if (!environment?.valid || !Number.isFinite(seconds) || !Number.isFinite(dawn)) throw new Error(t('Boon.Error.ClockUnavailable'));
  if (current-at>seconds) throw new Error(t('Boon.Error.PreviousDay'));
  const completedSeconds=((seconds-(current-at))%86400+86400)%86400;
  return {dayStart:at-completedSeconds,dawn:environment.chapter===9?null:dawn*60};
}

async function requestMeditation() {
  requirePrimaryGM();
  const chosen=await prompt('Boon.WillRoll',actorSelect()+check('cleaned',t('Boon.Cleaned'))+paragraph('Boon.WillRollHelp'),'Boon.RollWill');
  if(!chosen)return;
  const actor=actorByRef(chosen.get('actorId'));
  if(!actor?.saves?.will?.roll)throw new Error(t('Boon.Error.NoWill'));
  return actor.saves.will.roll({dc:{value:chosen.get('cleaned')?20:25},extraRollOptions:['action:meditate'],messageMode:'gm'});
}
async function useDialog(kind) {
  requirePrimaryGM();
  const current=now();
  let content=actorSelect();
  content+=minutesAgo(current);
  if(kind==='A14')content+=paragraph('Boon.A14Help')+check('cleaned',t('Boon.Cleaned'))+
    select('degree',t('Boon.WillResult'),[['criticalSuccess',t('Boon.Degree.CriticalSuccess')],['success',t('Boon.Degree.Success')],['failure',t('Boon.Degree.Failure')],['criticalFailure',t('Boon.Degree.CriticalFailure')]],'success');
  if(kind==='A19')content+=paragraph('Boon.A19Help')+paragraph('Boon.A19ClockHelp');
  if(kind==='C45')content+=paragraph('Boon.C45Help')+
    select('choice',t('Boon.StatueLabel'),[['performance',t('Boon.Statue.Performance')],['crafting',t('Boon.Statue.Crafting')],['athletics',t('Boon.Statue.Athletics')]])+
    paragraph('Boon.RoomMembers',{names:roomActors(state().binding).map(actor=>escapeHtml(actor.name)).join(', ')||t('Boon.NoRoomMembers')});
  if(kind==='G4')content+=paragraph('Boon.G4Help');
  content+=check('confirmed',t('Boon.ConfirmConditions'));
  const id=newId(),data=await prompt(LABELS[kind],content);
  if(!data)return;
  confirmed(data);
  const ago=value(data,'minutesAgo');
  if(!Number.isFinite(ago)||ago<0||ago>10080)throw new Error(t('Boon.Error.MinutesAgo'));
  const recordedAt=now(),input={id,kind,actorId:data.get('actorId'),at:recordedAt-ago*60};
  if(['A14','A19'].includes(kind))input.start=input.at-3600;
  if(kind==='A14')Object.assign(input,{cleaned:Boolean(data.get('cleaned')),degree:data.get('degree')});
  if(kind==='A19')Object.assign(input,boonBathClock({at:input.at,now:recordedAt,environment:getEnvironment()}));
  if(kind==='C45')Object.assign(input,{choice:data.get('choice'),targets:roomActors(state().binding).map(actor=>actor.uuid)});
  await getController().use(input);
  ui.notifications.info(t('Boon.Recorded'));
}

async function configureDialog() {
  requirePrimaryGM();
  const current=state(),entries=[['',t('Boon.Unbound')]];
  for(const scene of game.scenes??[])for(const region of scene.regions??[])entries.push([`${scene.id}/${region.id}`,`${scene.name} / ${region.name}`]);
  const data=await prompt('Boon.Settings',check('enabled',t('Boon.Enabled'),current.enabled!==false)+select('binding',t('Boon.BoundRoom'),entries,current.binding?`${current.binding.sceneId}/${current.binding.regionId}`:'')+paragraph('Boon.BindingHelp'),'Boon.Save');
  if(!data)return;
  const [sceneId,regionId]=String(data.get('binding')).split('/');
  await getController().configure({enabled:Boolean(data.get('enabled')),binding:sceneId&&regionId?{sceneId,regionId}:null});
}
async function diseaseRequest(use) {
  requirePrimaryGM();
  const actor=actorByRef(use.actorId);
  if(!actor)throw new Error(t('Boon.Error.ActorMissing'));
  const data=await prompt('Boon.DiseaseSave',paragraph('Boon.DiseaseHelp',{actor:escapeHtml(actor.name)})+
    field('disease',t('Boon.DiseaseName'),'<input id="boon-disease" name="disease" required>')+select('save',t('Boon.SaveType'),[['fortitude',t('Boon.Fortitude')],['will',t('Boon.Will')],['reflex',t('Boon.Reflex')]])+number('dc',t('Boon.DiseaseDC'),20),'Boon.RollSave');
  if(!data)return;
  if(!data.get('disease')?.trim()||!Number.isFinite(value(data,'dc'))||value(data,'dc')<0)throw new Error(t('Boon.Error.DiseaseDC'));
  const save=actor.saves?.[data.get('save')];
  if(!save?.roll)throw new Error(t('Boon.Error.NoSave'));
  await save.roll({dc:{value:value(data,'dc')},messageMode:'gm',extraRollOptions:['disease']});
  await whisperGM(`<p>${localizeHTML('Boon.Chat.Disease',{actor:actor.name,disease:data.get('disease')})}</p>`);
}
async function spellRequest(use) {
  requirePrimaryGM();
  const [slug,spellKey]=SPELLS[use.choice],pack=game.packs.get('pf2e.spells-srd');
  if(!pack)throw new Error(t('Boon.Error.SpellPack'));
  const index=await pack.getIndex({fields:['system.slug']}),entry=index.find(item=>item.system?.slug===slug);
  if(!entry)throw new Error(t('Boon.Error.SpellMissing',{spell:t(spellKey)}));
  const doc=await pack.getDocument(entry._id);
  if(!doc)throw new Error(t('Boon.Error.SpellUnavailable'));
  doc.sheet.render(true);
  const targets=(use.targets??[]).map(ref=>actorByRef(ref)?.name??ref).join(', ');
  await whisperGM(`<p>${localizeHTML(`Boon.Chat.Spell.${use.choice}`,{source:SHELYN})}</p><p>${localizeHTML(targets?'Boon.Chat.Targets':'Boon.Chat.TargetsMissing',{targets})}</p>`);
}
async function recordDialog(action,useId) {
  requirePrimaryGM();
  const use=state().uses?.[useId];
  if(!use)throw new Error(t('Boon.Error.ChooseRecord'));
  if(action==='retry')return getController().retry(useId);
  if(action==='void') {
    const data=await prompt('Boon.Void',paragraph('Boon.VoidHelp')+field('reason',t('Boon.Reason'),'<textarea id="boon-reason" name="reason" required></textarea>')+check('confirmed',t('Boon.ConfirmMistake')),'Boon.Void');
    if(!data)return;confirmed(data);return getController().void({id:newId(),useId,at:now(),reason:data.get('reason')});
  }
  if(action==='request') {
    if(use.kind==='A19')return diseaseRequest(use);
    if(use.kind==='C45')return spellRequest(use);
    throw new Error(t('Boon.Error.RequestType'));
  }
  if(action==='consume') {
    const data=await prompt('Boon.Consume',paragraph('Boon.ConsumeHelp',{actor:escapeHtml(actorByRef(use.actorId)?.name??use.actorId)})+check('confirmed',t('Boon.ConfirmConsume')),'Boon.Consume');
    if(!data)return;confirmed(data);return getController().consume({id:newId(),useId,at:now()});
  }
  if(action==='transfer') {
    const data=await prompt('Boon.Transfer',actorSelect()+check('confirmed',t('Boon.ConfirmTransfer')),'Boon.Transfer');
    if(!data)return;confirmed(data);return getController().transfer({id:newId(),useId,actorId:data.get('actorId'),at:now()});
  }
  if(action==='resolve') {
    if(!use.diseasePending&&!use.cleansePending)throw new Error(t('Boon.Error.NoPending'));
    const data=await prompt('Boon.Resolve',paragraph('Boon.ResolveHelp')+field('note',t('Boon.Result'),'<textarea id="boon-note" name="note" required></textarea>')+check('confirmed',t('Boon.ConfirmResolved')),'Boon.Resolve');
    if(!data)return;confirmed(data);return getController().resolve(useId,data.get('note'));
  }
  if(action==='correct') {
    const data=await prompt('Boon.Correct',paragraph('Boon.CorrectionHelp',{start:formatTime(use.start),at:formatTime(use.at),expires:use.expiresAt==null?t('Boon.None'):formatTime(use.expiresAt)})+
      `<details><summary>${t('Boon.ExactTime')}</summary>`+number('start',t('Boon.StartSeconds'),use.start)+number('at',t('Boon.CompletedSeconds'),use.at)+(use.expiresAt!=null?number('expiresAt',t('Boon.ExpiresSeconds'),use.expiresAt):'')+'</details>'+
      field('reason',t('Boon.Reason'),'<textarea id="boon-reason" name="reason" required></textarea>'),'Boon.Correct');
    if(!data)return;return getController().correct({id:newId(),useId,start:value(data,'start'),at:value(data,'at'),expiresAt:use.expiresAt==null?null:value(data,'expiresAt'),reason:data.get('reason')});
  }
}

export async function openBoons() {
  if(!game.user?.isGM)throw new Error(t('Boon.Error.GMOnly'));
  const current=state(),time=now(),records=Object.values(current.uses??{}).sort((a,b)=>b.at-a.at);
  const summary=partyMembers().map(actor=>`<tr><td>${escapeHtml(actor.name)}</td><td>${elapsed(cooldownRemaining(current,'A14',actor.uuid,time))}</td><td>${elapsed(cooldownRemaining(current,'A19',actor.uuid,time))}</td></tr>`).join('');
  const pending=records.filter(use=>!use.voided&&(use.status==='pending'||use.diseasePending||use.cleansePending||(alive(use)&&(use.kind==='G4'||use.bonus>0)))).length;
  const workflows=['A14','A19','C45','G4'];
  const content=paragraph(isPrimaryGM()?'Boon.MainHelp':'Boon.ReadOnly')+(current.enabled===false?paragraph('Boon.Paused'):'')+
    `<div class="bob-boon-actions">${workflows.map(kind=>`<button type="button" data-boon-use="${kind}">${label(kind)}</button>`).join('')}</div>`+
    `<table><thead><tr><th>${t('Boon.Actor')}</th><th>${t('Boon.A14')}</th><th>${t('Boon.A19')}</th></tr></thead><tbody>${summary}</tbody></table>`+
    paragraph('Boon.SharedCooldown',{duration:elapsed(cooldownRemaining(current,'C45',null,time))})+
    paragraph(current.binding?'Boon.RoomBound':'Boon.RoomUnbound')+paragraph('Boon.PendingCount',{count:pending})+
    `<details><summary>${t('Boon.Advanced')}</summary><button type="button" data-boon-advanced="records">${t('Boon.Records')}</button> <button type="button" data-boon-advanced="configure">${t('Boon.Settings')}</button> <button type="button" data-boon-advanced="will">${t('Boon.WillRoll')}</button></details>`;
  class BoonsDialog extends foundry.applications.api.DialogV2 {
    _onRender(context,options) {
      super._onRender(context,options);
      this.element.querySelectorAll('[data-boon-use]').forEach(button=>button.addEventListener('click',async()=>{
        if(button.disabled)return;button.disabled=true;
        try {await useDialog(button.dataset.boonUse);await this.close();await openBoons();}
        catch(error){notice(error);}finally{button.disabled=false;}
      }));
      this.element.querySelectorAll('[data-boon-advanced]').forEach(button=>button.addEventListener('click',async()=>{
        if(button.disabled)return;button.disabled=true;
        try {if(button.dataset.boonAdvanced==='records')await recordsDialog();else if(button.dataset.boonAdvanced==='configure')await configureDialog();else await requestMeditation();await this.close();await openBoons();}
        catch(error){notice(error);}finally{button.disabled=false;}
      }));
    }
  }
  await BoonsDialog.wait({window:{title:`BoB｜${t('Boon.Title')}`},position:{width:630},classes:['bob-companion'],content,
    buttons:[{action:'close',label:t('Boon.Close')}],rejectClose:false});
}

async function recordsDialog() {
  const records=Object.values(state().uses??{}).sort((a,b)=>b.at-a.at);
  const status=use=>use.voided?t('Boon.Status.Voided'): [use.status==='pending'?t('Boon.Status.Retry'):use.consumedAt!=null?t('Boon.Status.Consumed'):use.expired?t('Boon.Status.Expired'):t('Boon.Status.Recorded'),use.diseasePending?t('Boon.Status.Disease'):'',use.cleansePending?t('Boon.Status.Counteract'):'',use.bonus&&alive(use)?t('Boon.Status.UseBonus'):'',use.kind==='G4'&&alive(use)?t('Boon.Status.UseGear'):''].filter(Boolean).join(' · ');
  const rows=records.slice(0,30).map(use=>`<tr><td>${escapeHtml(label(use.kind))}</td><td>${escapeHtml(actorByRef(use.actorId)?.name??t('Boon.RemovedActor'))}</td><td>${escapeHtml(status(use))}${use.error?`<br>${escapeHtml(use.error)}`:''}</td><td>${use.expiresAt==null?t('Boon.None'):formatTime(use.expiresAt)}</td></tr>`).join('');
  const content=paragraph('Boon.RecordsHelp')+`<table><thead><tr><th>${t('Boon.Type')}</th><th>${t('Boon.Actor')}</th><th>${t('Boon.StatusLabel')}</th><th>${t('Boon.Expires')}</th></tr></thead><tbody>${rows||`<tr><td colspan="4">${t('Boon.NoRecords')}</td></tr>`}</tbody></table>`+
    select('useId',t('Boon.Record'),[['',t('Boon.ChooseRecord')],...records.map(use=>[use.id,`${label(use.kind)} · ${actorByRef(use.actorId)?.name??use.actorId} · ${status(use)} · ${formatTime(use.at)}`])])+
    select('action',t('Boon.ActionLabel'),[['consume',t('Boon.Action.Consume')],['request',t('Boon.Action.Request')],['resolve',t('Boon.Action.Resolve')],['transfer',t('Boon.Action.Transfer')],['retry',t('Boon.Action.Retry')],['correct',t('Boon.Action.Correct')],['void',t('Boon.Action.Void')]]);
  const result=await prompt('Boon.Records',content,'Boon.RunAction');
  if(!result)return;
  await recordDialog(result.get('action'),result.get('useId'));
}

export function registerBoons() {
  if(registered)return;registered=true;
  Hooks.once('ready',()=>{
    const module=game.modules.get(ID);module.api??={};
    Object.assign(module.api,{openBoons,useBoon:input=>getController().use(input),consumeBoon:input=>getController().consume(input),
      transferBoon:input=>getController().transfer(input),correctBoon:input=>getController().correct(input),voidBoon:input=>getController().void(input),retryBoon:id=>getController().retry(id)});
    if(isPrimaryGM()&&enabled()&&state().enabled!==false)void getController().tick(now()).catch(notice);
  });
  Hooks.on('updateWorldTime',time=>{if(isPrimaryGM()&&enabled()&&state().enabled!==false)void getController().tick(time).catch(notice);});
  const sync=(recalculate=false)=>{if(isPrimaryGM()&&enabled()&&state().enabled!==false)void getController().syncRoom(recalculate===true).catch(notice);};
  const tokenChanged=token=>{if(state().binding?.sceneId===token.parent?.id)sync();};
  Hooks.on('updateToken',tokenChanged);Hooks.on('createToken',tokenChanged);Hooks.on('deleteToken',tokenChanged);
  Hooks.on('updateRegion',region=>{if(state().binding?.regionId===region.id)sync(true);});
  Hooks.on('deleteRegion',region=>{if(state().binding?.regionId===region.id)sync(true);});
  Hooks.on('canvasReady',sync);
  Hooks.on('updateScene',(_scene,change)=>{if(Object.hasOwn(change,'active'))sync();});
  Hooks.on('updateSetting',setting=>{
    // Turning off the environment removes only current room effects once; later hooks stay idle.
    if(setting.key===`${ID}.config`&&isPrimaryGM())void getController().syncRoom().catch(notice);
  });
  Hooks.on('updateUser',()=>{if(isPrimaryGM()&&enabled()&&state().enabled!==false)void getController().tick(now()).catch(notice);});
}
