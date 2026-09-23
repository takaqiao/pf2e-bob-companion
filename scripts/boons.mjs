import {ID} from './model.mjs';
import {getEnvironment} from './runtime.mjs';
import {readState,updateState,withAction,requirePrimaryGM,isPrimaryGM,now,escapeHtml,partyMembers,loadEffect,whisperGM} from './assistant-core.mjs';
import {recordBoon,consumeBoon,transferBoon,correctBoon,voidBoon,cooldownRemaining,c45Active,expireBoons} from './boon-model.mjs';

const SOURCES = {A19:'Item.Y2ix3ISFWBhXLsE0',G4:'Item.0vmwZrIhm5rWHkYh'};
const SHELYN = 'Compendium.pf2e.adventure-specific-actions.Item.8Ze3B6HWu2fyKETM';
const STUPEFIED = 'Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg';
const SPELLS = {performance:['sure-footing','稳固脚步'],crafting:['clear-mind','清神醒脑'],athletics:['sound-body','身健体康']};
const LABELS = {A14:'A14 石间冥想',A19:'A19 浴池',C45:'C45 莎琳的恩典',G4:'G4 齿轮恩赐'};
const SKILLS = {performance:'表演',crafting:'手艺',athletics:'运动'};
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
  let text;
  if (use.kind === 'A14' && use.bonus) {
    data.name = '心智启迪（待消费）';
    text = `下一次基于智力的技能检定获得 +${use.bonus} 环境加值。检定后请 GM 确认消费；消费前此效果仍会提供加值。`;
    data.system.rules = [{key:'FlatModifier',selector:['int-skill-check'],type:'circumstance',value:use.bonus},
      {key:'Note',selector:['int-skill-check'],title:'心智启迪',text:'使用本次加值后，请 GM 消费已使用的恩惠。'}];
  } else if (use.kind === 'A14' && use.condition) {
    data.name = '心神不宁';text = '呆滞 1，持续至所示到期时间。';
    data.system.rules = [{key:'GrantItem',uuid:STUPEFIED,inMemoryOnly:true}];
  } else if (use.kind === 'A19') {
    if (!source || !use.crossedDawn) return null;
    data.name = '制作灵感';text = '当天剩余时间内，用于制作物品的手艺检定获得 +1 物品加值。';
  } else if (use.kind === 'C45') {
    data.name = `${SKILLS[use.choice]}灵感`;
    text = `当前在受祝福房间的白昼，${SKILLS[use.choice]}检定获得 +1 物品加值。离开或入夜时暂停。`;
    data.system.rules = [{key:'FlatModifier',selector:[use.choice],type:'item',value:1}];
  } else if (use.kind === 'G4') {
    if (!source) throw new Error('原生恩赐条目不可用。');
    data.name = '预知恩赐（待消费）';
    text = '一次检定可获得 +2 状态加值，可在得知结果后决定使用，并可能改变成功程度。请 GM 按状态加值叠加规则重判后确认消费。';
    data.system.rules = [{key:'Note',selector:'all',title:'预知恩赐',text:'可在得知结果后使用一次 +2 状态加值；请 GM 重判结果并消费。'}];
  } else return null;
  data.system.description = {value:`<p>${text}</p>`,gm:''};
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
    if (!actor) throw new Error('记录的角色已不存在，请由 GM 纠正记录。');
    const existing = owned(actor,use.id);
    if(!existing.length&&use.kind==='G4') {
      const native=Array.from(actor.items??[]).filter(item=>nativeGearBoon(item)&&!flag(item));
      if(native.length>1)throw new Error('角色已有多份原生恩赐，请先由 GM 核对。');
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
      const recipient=deps.actor(input.actorId);if (!recipient) throw new Error('接收者不存在。');
      if(Array.from(recipient.items??[]).some(item=>nativeGearBoon(item)&&!flag(item)))throw new Error('接收者已持有原生恩赐，请先登记该恩赐。');
      await deps.update(state=>{transferBoon(state,input);});return recover(input.useId);
    }),
    correct:input=>run(async()=>{await deps.update(state=>{correctBoon(state,input);});return recover(input.useId);}),
    void:input=>run(async()=>{await deps.update(state=>{voidBoon(state,input);});return recover(input.useId);}),
    resolve:(useId,note)=>run(async()=>{if(!note?.trim())throw new Error('请记录 GM 已确认的结算结果。');await deps.update(state=>{
      const use=state.uses?.[useId];if(!use)throw new Error('记录不存在。');use.diseasePending=false;use.cleansePending=false;use.resolution={at:deps.time(),note};
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
  if(doc?.type!=='feat'||typeof doc.toObject!=='function') throw new Error('所需的原生恩赐条目不可用，请检查冒险内容导入；记录保留待处理。');
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
const actorSelect = (selected) => select('actorId','角色',partyMembers().map(actor=>[actor.uuid,actor.name]),selected);
const dataFrom = dialog => new FormData(dialog.element.querySelector('form'));
async function prompt(title,content,label='确认记录') {
  return foundry.applications.api.DialogV2.wait({window:{title:`BoB｜${title}`},position:{width:650},classes:['bob-companion'],content,
    buttons:[{action:'confirm',label,callback:(_event,_button,dialog)=>dataFrom(dialog)},{action:'cancel',label:'取消',callback:()=>null}],rejectClose:false});
}
const value = (data,key) => Number(data.get(key));
const confirmed = data => {if(!data.get('confirmed'))throw new Error('请先确认实际使用条件与结果。');};
const elapsed = seconds => `${Math.ceil(seconds/3600*10)/10} 小时`;

async function requestMeditation() {
  requirePrimaryGM();
  const chosen=await prompt('冥想意志检定',actorSelect()+check('cleaned','竖石已清理')+'<p>先完成 1 小时冥想。检定本身不结算冷却；回到完成使用填写结果后结算。</p>','发起原生意志检定');
  if(!chosen)return;
  const actor=actorByRef(chosen.get('actorId'));
  if(!actor?.saves?.will?.roll)throw new Error('角色没有可用的原生意志豁免。');
  return actor.saves.will.roll({dc:{value:chosen.get('cleaned')?20:25},extraRollOptions:['action:meditate'],messageMode:'gm'});
}
async function useDialog(kind) {
  requirePrimaryGM();
  const at=now(),env=getEnvironment();
  const dayStart=env.valid?at-env.seconds:NaN;
  let content=actorSelect();
  if(['A14','A19'].includes(kind))content+=number('start','实际开始（世界秒）',at-3600)+number('at','实际完成（世界秒）',at);
  else content+=number('at','实际使用（世界秒）',at);
  if(kind==='A14')content+='<p>理解用途后冥想 1 小时。已清理 DC 20 意志；未清理 DC 25，失败按大失败处理。无论结果，每人冷却一周。</p>'+check('cleaned','竖石已清理')+
    select('degree','原生意志检定结果',[['criticalSuccess','大成功：下一次智力技能 +2'],['success','成功：下一次智力技能 +1'],['failure','失败'],['criticalFailure','大失败：呆滞 1（24 小时）']],'success');
  if(kind==='A19')content+='<p>确认浴池魔法已可使用，且浸泡满 1 小时；容量由 GM 确认。额外疾病豁免不会提高疾病阶段，助手不会自动删除或修改疾病。跨日出后，制作加值持续到当天午夜。</p>'+
    number('dayStart','完成时所在日期的午夜（世界秒）',Number.isFinite(dayStart)?dayStart:at)+number('dawn','该日期日出（自午夜起秒数）',env.valid?env.dawn*60:27000)+
    '<p>以上日出由当前章节世界钟推算。跨章节、长时间浸泡或时钟调整时，请 GM 校准。无有效白昼时不可勾选跨日出。</p>'+check('hasDawn','确认这一天存在日出',env.valid&&env.chapter!==9);
  if(kind==='C45')content+='<p>三座雕像共享 24 小时冷却。6 环法术影响使用时房内所有生物；反制 +17，具体反制规则请以原生条目为准，由 GM 结算。随后 8 小时内，仅在本房白昼提供 +1 物品加值。</p>'+
    select('choice','雕像',[['performance','起舞：稳固脚步 / 表演'],['crafting','沉思：清神醒脑 / 手艺'],['athletics','安睡：身健体康 / 运动']])+`<p>已绑定房间当前生物：${roomActors(state().binding).map(actor=>escapeHtml(actor.name)).join('、')||'无 / 尚未绑定 Region'}。未绑定时不推测位置，也不添加加值。</p>`;
  if(kind==='G4')content+='<p>仅记录 GM 已决定授予的一次恩赐。每位角色最多持有一次；归还者已持有时，请选择尚未持有的队友。全队均持有时不授予；第 13 枚齿轮不授予这种恩赐。此面板不自动结算其他奖励。</p>';
  content+=check('confirmed','已确认实际条件、角色与结果');
  const id=newId(),data=await prompt(LABELS[kind],content);
  if(!data)return;
  confirmed(data);
  const input={id,kind,actorId:data.get('actorId'),at:value(data,'at')};
  if(input.at>now())throw new Error('实际完成时间不能在未来。');
  if(['A14','A19'].includes(kind))input.start=value(data,'start');
  if(kind==='A14')Object.assign(input,{cleaned:Boolean(data.get('cleaned')),degree:data.get('degree')});
  if(kind==='A19')Object.assign(input,{dayStart:value(data,'dayStart'),dawn:data.get('hasDawn')?value(data,'dawn'):null});
  if(kind==='C45')Object.assign(input,{choice:data.get('choice'),targets:roomActors(state().binding).map(actor=>actor.uuid)});
  await getController().use(input);
  ui.notifications.info('使用已记录；当前效果已同步。待结算事项可在面板继续处理。');
}

async function configureDialog() {
  requirePrimaryGM();
  const current=state(),entries=[['','未绑定']];
  for(const scene of game.scenes??[])for(const region of scene.regions??[])entries.push([`${scene.id}/${region.id}`,`${scene.name} / ${region.name}`]);
  const data=await prompt('恩惠设置',check('enabled','启用恩惠助手',current.enabled!==false)+select('binding','C45 原生 Region',entries,current.binding?`${current.binding.sceneId}/${current.binding.regionId}`:'')+'<p>请选择房间实际范围；不创建区域或按地图坐标猜测。只有本区域中的角色受白昼加值。</p>','保存');
  if(!data)return;
  const [sceneId,regionId]=String(data.get('binding')).split('/');
  await getController().configure({enabled:Boolean(data.get('enabled')),binding:sceneId&&regionId?{sceneId,regionId}:null});
}
async function diseaseRequest(use) {
  requirePrimaryGM();
  const actor=actorByRef(use.actorId);
  if(!actor)throw new Error('角色不存在。');
  const data=await prompt('额外疾病豁免',`<p>${escapeHtml(actor.name)}：请选择实际疾病对应的豁免与 DC。检定不自动改变疾病，任何失败均不能提高阶段。</p>`+
    field('disease','疾病名称','<input id="boon-disease" name="disease" required>')+select('save','豁免',[['fortitude','强韧'],['will','意志'],['reflex','反射']])+number('dc','疾病 DC',20),'发起原生豁免');
  if(!data)return;
  if(!data.get('disease')?.trim()||!Number.isFinite(value(data,'dc'))||value(data,'dc')<0)throw new Error('请填写疾病与有效 DC。');
  const save=actor.saves?.[data.get('save')];
  if(!save?.roll)throw new Error('角色没有此原生豁免。');
  await save.roll({dc:{value:value(data,'dc')},messageMode:'gm',extraRollOptions:['disease']});
  await whisperGM(`<p>${escapeHtml(actor.name)} 的 ${escapeHtml(data.get('disease'))} 额外豁免：失败不能提高疾病阶段。请核对原生疾病后在恩惠面板确认完成。</p>`);
}
async function spellRequest(use) {
  requirePrimaryGM();
  const [slug,label]=SPELLS[use.choice],pack=game.packs.get('pf2e.spells-srd');
  if(!pack)throw new Error('PF2e 原生法术合集不可用。');
  const index=await pack.getIndex({fields:['system.slug']}),entry=index.find(item=>item.system?.slug===slug);
  if(!entry)throw new Error(`找不到原生法术 ${label}；待办保留。`);
  const doc=await pack.getDocument(entry._id);
  if(!doc)throw new Error('原生法术不可用。');
  doc.sheet.render(true);
  await whisperGM(`<p>本次为 6 环 ${escapeHtml(label)}，反制调整值 +17。请核对 <a class="content-link" data-uuid="${SHELYN}">原生恩典条目</a> 并确认适用状态与反制结果。</p><p>使用时房内目标：${(use.targets??[]).map(ref=>escapeHtml(actorByRef(ref)?.name??'已移除角色')).join('、')||'未记录；由 GM 确认实际在场者'}。</p>`);
}
async function recordDialog(action,useId) {
  requirePrimaryGM();
  const use=state().uses?.[useId];
  if(!use)throw new Error('请选择记录。');
  if(action==='retry')return getController().retry(useId);
  if(action==='void') {
    const data=await prompt('撤销误登记','<p>仅用于纠正错误记录：撤销本次冷却并移除其当前效果。此操作不恢复已经完成的疾病 / 反制结果。</p>'+field('reason','纠正原因','<textarea id="boon-reason" name="reason" required></textarea>')+check('confirmed','确认这是误登记'),'撤销此记录');
    if(!data)return;confirmed(data);return getController().void({id:newId(),useId,at:now(),reason:data.get('reason')});
  }
  if(action==='request') {
    if(use.kind==='A19')return diseaseRequest(use);
    if(use.kind==='C45')return spellRequest(use);
    throw new Error('请选择浴池或雕像记录；冥想可使用单独的检定按钮。');
  }
  if(action==='consume') {
    const data=await prompt('消费一次性恩惠',`<p>${escapeHtml(actorByRef(use.actorId)?.name??use.actorId)}：确认已在一次实际检定中使用此恩惠。</p>`+check('confirmed','已使用，移除当前效果'),'确认消费');
    if(!data)return;confirmed(data);return getController().consume({id:newId(),useId,at:now()});
  }
  if(action==='transfer') {
    const data=await prompt('转授当前恩赐',actorSelect()+check('confirmed','已确认转授给此角色'),'转授');
    if(!data)return;confirmed(data);return getController().transfer({id:newId(),useId,actorId:data.get('actorId'),at:now()});
  }
  if(action==='resolve') {
    if(!use.diseasePending&&!use.cleansePending)throw new Error('该记录没有待确认的疾病或反制事项。');
    const data=await prompt('确认疾病 / 反制已结算','<p>请先按原生规则结算；浴池疾病豁免不得提高阶段。此操作仅完成待办记录。</p>'+field('note','结算结果','<textarea id="boon-note" name="note" required></textarea>')+check('confirmed','已由 GM 核对实际状态'),'完成待办');
    if(!data)return;confirmed(data);return getController().resolve(useId,data.get('note'));
  }
  if(action==='correct') {
    const data=await prompt('校准记录时间',number('start','开始（世界秒）',use.start)+number('at','完成（世界秒）',use.at)+(use.expiresAt!=null?number('expiresAt','效果到期（世界秒）',use.expiresAt):'')+
      field('reason','纠正原因','<textarea id="boon-reason" name="reason" required></textarea>')+'<p>冷却按校准后的完成时间计算；其他角色不受影响。已消费记录不会恢复成未消费。</p>','校准并同步');
    if(!data)return;return getController().correct({id:newId(),useId,start:value(data,'start'),at:value(data,'at'),expiresAt:use.expiresAt==null?null:value(data,'expiresAt'),reason:data.get('reason')});
  }
}

export async function openBoons() {
  if(!game.user?.isGM)throw new Error('恩惠助手仅供 GM 使用。');
  const current=state(),time=now(),records=Object.values(current.uses??{}).sort((a,b)=>b.at-a.at);
  const summary=partyMembers().map(actor=>`<tr><td>${escapeHtml(actor.name)}</td><td>${elapsed(cooldownRemaining(current,'A14',actor.uuid,time))}</td><td>${elapsed(cooldownRemaining(current,'A19',actor.uuid,time))}</td></tr>`).join('');
  const pending=records.filter(use=>!use.voided&&(use.status==='pending'||use.diseasePending||use.cleansePending||(alive(use)&&(use.kind==='G4'||use.bonus>0)))).length;
  const workflows=[['A14','石间冥想','完成 1 小时冥想，登记意志结果与一次技能恩惠。'],['A19','浴池','登记浸泡，处理疾病豁免与跨日出制作灵感。'],['C45','莎琳的恩典','选择雕像，追踪共享冷却及房内白昼加值。'],['G4','齿轮恩赐','登记已获的一次恩赐，已有持有者可在记录中转授。']];
  const content=`<p>${isPrimaryGM()?'确认实际使用后记录。':'当前为只读，请由主 GM 执行使用。'}${current.enabled===false?' 自动跟踪已暂停。':''}</p>`+
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${workflows.map(([kind,label,detail])=>`<div class="bob-card"><button type="button" data-boon-use="${kind}">${label}</button><p>${detail}</p></div>`).join('')}</div>`+
    `<table><thead><tr><th>角色</th><th>冥想剩余冷却</th><th>浴池剩余冷却</th></tr></thead><tbody>${summary}</tbody></table><p>雕像共享冷却：${elapsed(cooldownRemaining(current,'C45',null,time))}。${current.binding?'房间已绑定。':'请先在设置中绑定房间。'}</p><p>${pending} 条待处理记录。</p>`;
  class BoonsDialog extends foundry.applications.api.DialogV2 {
    _onRender(context,options) {
      super._onRender(context,options);
      this.element.querySelectorAll('[data-boon-use]').forEach(button=>button.addEventListener('click',async()=>{
        if(button.disabled)return;button.disabled=true;
        try {await useDialog(button.dataset.boonUse);await this.close();await openBoons();}
        catch(error){notice(error);}finally{button.disabled=false;}
      }));
    }
  }
  const result=await BoonsDialog.wait({window:{title:'BoB｜恩惠与冷却'},position:{width:700},classes:['bob-companion'],content,
    buttons:[{action:'records',label:'已有记录 / 处理待办'},{action:'configure',label:'设置'},{action:'close',label:'关闭'}],rejectClose:false});
  if(!result||result==='close')return;
  try {
    if(result==='configure')await configureDialog();
    else if(result==='records')await recordsDialog();
  }catch(error){notice(error);}
  return openBoons();
}

async function recordsDialog() {
  const records=Object.values(state().uses??{}).sort((a,b)=>b.at-a.at);
  const status=use=>use.voided?'已撤销': [use.status==='pending'?'效果待重试':use.consumedAt!=null?'已消费':use.expired?'已到期':'已记录',use.diseasePending?'疾病豁免待确认':'',use.cleansePending?'法术反制待确认':'',use.bonus&&alive(use)?'下次检定后消费':'',use.kind==='G4'&&alive(use)?'尚未消费':''].filter(Boolean).join(' · ');
  const rows=records.slice(0,30).map(use=>`<tr><td>${escapeHtml(LABELS[use.kind])}</td><td>${escapeHtml(actorByRef(use.actorId)?.name??'已移除角色')}</td><td>${escapeHtml(status(use))}${use.error?`<br>${escapeHtml(use.error)}`:''}</td><td>${use.expiresAt??'—'}</td></tr>`).join('');
  const content=`<p>世界时间：${now()} 秒。下方仅显示最近 30 条，选择框可处理全部记录。</p><table><thead><tr><th>来源</th><th>角色</th><th>状态</th><th>到期世界秒</th></tr></thead><tbody>${rows||'<tr><td colspan="4">尚无记录</td></tr>'}</tbody></table>`+
    select('useId','记录',[['','选择记录'],...records.map(use=>[use.id,`${LABELS[use.kind]} · ${actorByRef(use.actorId)?.name??use.actorId} · ${status(use)} · ${use.at}`])])+
    select('action','处理方式',[['consume','消费已用于检定的恩惠'],['request','疾病豁免 / 反制请求'],['resolve','确认疾病 / 反制已结算'],['transfer','转授一次恩赐'],['retry','重试未完成的效果'],['correct','校准开始与到期时间'],['void','撤销误登记'],['meditation','发起冥想意志检定（无需选择记录）']]);
  const result=await prompt('已有恩惠与待办',content,'执行所选操作');
  if(!result)return;
  if(result.get('action')==='meditation')await requestMeditation();
  else await recordDialog(result.get('action'),result.get('useId'));
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
