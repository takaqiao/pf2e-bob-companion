import {ID} from './model.mjs';
import {readState,updateState,withAction,requirePrimaryGM,partyMembers,now,escapeHtml,loadEffect} from './assistant-core.mjs';
import {getEnvironment} from './runtime.mjs';
import {SOULHEART_GRADES,soulheartGrade,phantomRank,planUpgrade,runUpgrade,correctUpgrade,planLife,runLife,planHPSync} from './soulheart-model.mjs';

export const SOULHEART_HP_SOURCE='Item.mE0lIeDPfDvm7Qhy';
export const SOULHEART_LIFE_SOURCE='Compendium.pf2e.equipment-effects.Item.iiQSTRA8EVCvlfDQ';
const DOMAIN='soulhearts',ACTION='soulhearts';
const list=collection=>Array.from(collection?.values?.()??collection??[]);
const flag=document=>document?.flags?.[ID]??{};
const copy=value=>structuredClone(value);
const randomId=()=>foundry.utils.randomID();
const actorById=id=>{const actor=game.actors.get(id);if(!actor)throw new Error('事务所需角色已移除，请恢复该角色后重试。');return actor;};
const ownedItem=(actor,id)=>{const item=actor.items.get(id);if(!item)throw new Error('实际物品已移除或转移，请恢复原物品后重试。');return item;};
const hpRule=effect=>effect?.system?.rules?.find(rule=>rule.key==='FlatModifier' && (Array.isArray(rule.selector)?rule.selector.includes('hp'):rule.selector==='hp') && rule.value==='@item.badge.value');
function recognizedHP(effect) {
  const sources=[effect.sourceId,effect._stats?.compendiumSource,effect._stats?.duplicateSource,effect.flags?.core?.sourceId];
  return effect.type==='effect' && (flag(effect).soulheartHP || effect.id==='mE0lIeDPfDvm7Qhy' || sources.includes(SOULHEART_HP_SOURCE) || effect.system?.slug==='bolster-maiserene-phantom');
}
export function findHPEffect(actor) {
  const effects=list(actor?.items).filter(recognizedHP);
  if(effects.length>1)throw new Error(`${actor.name??actor.id} 有多个生命值累计效果，请 GM 先核对，助手不会删除旧奖励。`);
  const effect=effects[0];if(!effect)return null;
  if(!hpRule(effect)||!Number.isInteger(Number(effect.system.badge?.value)))throw new Error('已有生命值效果的规则或计数无法安全读取。');
  return {id:effect.id,value:Number(effect.system.badge.value)};
}
function hpData(template,value,id) {
  if(!hpRule(template))throw new Error('官方生命值效果不含预期的 HP 计数规则，请恢复原生资产。');
  const data=copy(template);delete data._id;delete data.folder;delete data._stats;
  data.name='生命值提升';data.system.description={value:`<p>最大生命值提高 ${value} 点。仅在当前冒险的诅咒与停留条件仍成立时适用；条件结束由 GM 移除此效果。</p>`,gm:''};
  data.system.badge={...data.system.badge,type:'counter',value,min:0,max:null,labels:null,loop:false};
  data.flags={[ID]:{soulheartHP:true,lastUpgrade:id},core:{sourceId:SOULHEART_HP_SOURCE}};
  return data;
}
export function lifeEffectData(template,op) {
  const rule=template?.system?.rules?.find(rule=>rule.key==='TempHP');
  if(!rule)throw new Error('官方强化生命效果不含临时生命值规则，请检查 PF2e 资产。');
  const data=copy(template);delete data._id;delete data.folder;delete data._stats;
  data.name='临时生命值';data.system.rules=[{...copy(rule),value:op.temporaryHP}];
  // Grade and day/night have already been resolved from the actual item and preview.
  delete data.system.rules[0].predicate;
  data.system.description={value:`<p>获得 ${op.temporaryHP} 点临时生命值，最多持续 8 小时。</p>`,gm:''};
  data.system.duration={value:8,unit:'hours',expiry:'turn-start',sustained:false};data.system.start={value:op.createdAt,initiative:null};
  data.system.badge=null;data.flags={[ID]:{soulheartLife:op.id},core:{sourceId:SOULHEART_LIFE_SOURCE}};
  return data;
}
/** The port reconciles a native write even when its acknowledgement or subsequent receipt write failed. */
export function makeSoulheartPort({read=()=>readState(DOMAIN),save=mutator=>updateState(DOMAIN,mutator),actor=actorById,load=loadEffect,assertGM=requirePrimaryGM,time=now,environment=getEnvironment}={}) {
  const getItem=op=>ownedItem(actor(op.holderId),op.itemId);
  const changed=()=>{throw new Error('实际数量、阶位、效果或账本已经改变；请重新预览或由 GM 核对。');};
  async function checkCorrection(op) {
    if(op.kind!=='sync') {
      const item=getItem(op);
      if(Number(item.system.quantity)!==op.quantityAfter || flag(item).lastSoulheartUpgrade!==op.id || phantomRank(actor(op.phantomId)).rank!==op.rankAfter)changed();
    }
    for(const pc of op.beneficiaries) {
      const actual=findHPEffect(actor(pc.id)),effect=actual&&actor(pc.id).items.get(actual.id);
      if(actual?.value!==op.totalAfter||flag(effect).lastUpgrade!==op.id)changed();
    }
  }
  return {read,save,
    async preflight(op) {
      assertGM();const state=read();
      if(Number(state.total??0)!==op.ledgerBefore || (state.lastCompleted??null)!==op.previousCompleted)changed();
      if(op.kind!=='sync') {
        const item=getItem(op);
        if(Number(item.system.quantity)!==op.quantityBefore || soulheartGrade(item,op.binding)!==op.grade || phantomRank(actor(op.phantomId)).rank!==op.rankBefore)changed();
        if(typeof actor(op.phantomId).toggleRollOption!=='function')throw new Error('当前角色缺少 PF2e 原生阶位接口。');
      }
      for(const pc of op.beneficiaries) {
        const recipient=actor(pc.id),actual=findHPEffect(recipient);
        if(recipient.type!=='character'||(actual?.id??null)!==pc.effectId||(actual?.value??0)!==pc.before)changed();
      }
      hpData(await load(SOULHEART_HP_SOURCE),op.totalAfter,op.id);
    },
    checkCorrection,
    async preflightLife(op) {
      assertGM();const item=getItem(op);
      if(Number(item.system.quantity)!==op.quantityBefore||soulheartGrade(item,op.binding)!==op.grade)changed();
      if(flag(item).soulheartDaily && time()<flag(item).soulheartDaily.resetAt)throw new Error('这件物品的每日强化生命已经使用。');
      lifeEffectData(await load(SOULHEART_LIFE_SOURCE),op);
      // Only a new transaction enters preflight. Reserved retries keep their original phase and deadline.
      const current=environment(),at=time(),phase=current.valid?(current.night?'night':'day'):null;
      const resetAt=at+86400-((current.seconds%86400+86400)%86400);
      if(!Number.isFinite(at)||!Number.isFinite(current.seconds)||phase!==op.phase||at<op.createdAt||Math.abs(resetAt-op.resetAt)>=1) {
        throw new Error('昼夜或日期已改变，或世界钟不可用；请重新预览强化生命。');
      }
    },
    async applyLife(op,step) {
      assertGM();const item=getItem(op),holder=actor(op.holderId),daily=flag(item).soulheartDaily;
      if(step==='daily') {
        if(daily?.id===op.id)return;
        if(daily&&time()<daily.resetAt)throw new Error('每日使用记录已改变，请 GM 核对。');
        await item.update({[`flags.${ID}.soulheartDaily`]:{id:op.id,usedAt:op.createdAt,resetAt:op.resetAt}});return;
      }
      if(list(holder.items).some(effect=>flag(effect).soulheartLife===op.id))return;
      if(time()>=op.expiresAt) {
        await save(state=>{state.operations[op.id].notice='重试时 8 小时有效期已过，未重新发放临时生命值。';});return;
      }
      const data=lifeEffectData(await load(SOULHEART_LIFE_SOURCE),op);assertGM();
      // PF2e sets effect.start to the creation time, including a delayed retry.
      const remaining=op.expiresAt-time();
      if(remaining<=0) {
        await save(state=>{state.operations[op.id].notice='重试时 8 小时有效期已过，未重新发放临时生命值。';});return;
      }
      data.system.duration={...data.system.duration,value:remaining/60,unit:'minutes'};
      await holder.createEmbeddedDocuments('Item',[data]);
    },
    async apply(op,step,undo=false) {
      assertGM();const marker=undo?`undo:${op.id}`:op.id;
      if(step==='quantity') {
        const item=getItem(op),before=undo?op.quantityAfter:op.quantityBefore,after=undo?op.quantityBefore:op.quantityAfter;
        if(flag(item).lastSoulheartUpgrade===marker && Number(item.system.quantity)===after)return;
        if(Number(item.system.quantity)!==before || flag(item).lastSoulheartUpgrade===marker || (undo&&flag(item).lastSoulheartUpgrade!==op.id))changed();
        await item.update({'system.quantity':after,[`flags.${ID}.lastSoulheartUpgrade`]:marker});
        return;
      }
      if(step==='rank') {
        const phantom=actor(op.phantomId),current=phantomRank(phantom),before=undo?op.rankAfter:op.rankBefore,after=undo?op.rankBefore:op.rankAfter;
        if(current.itemId!==op.rankItemId)changed();
        if(current.rank===after)return;
        if(current.rank!==before)changed();
        await phantom.toggleRollOption(op.rankDomain,'support-rank',op.rankItemId,after>0,String(after||1));
        if(phantomRank(phantom).rank!==after)throw new Error('原生阶位未更新，保留事务以供重试。');
        return;
      }
      const pc=op.beneficiaries.find(pc=>`hp:${pc.id}`===step);if(!pc)throw new Error('生命值步骤无效。');
      const recipient=actor(pc.id),actual=findHPEffect(recipient),effect=actual&&recipient.items.get(actual.id),target=undo?pc.before:op.totalAfter;
      if(undo&&!pc.effectId) {
        if(!effect)return;
        if(flag(effect).lastUpgrade!==op.id||actual.value!==op.totalAfter)changed();
        await recipient.deleteEmbeddedDocuments('Item',[effect.id]);return;
      }
      if(effect&&flag(effect).lastUpgrade===marker&&actual.value===target)return;
      const expectedValue=undo?op.totalAfter:pc.before;
      if((effect ? actual.value!==expectedValue || (pc.effectId && effect.id!==pc.effectId) : Boolean(pc.effectId)) || (undo&&flag(effect).lastUpgrade!==op.id))changed();
      const data=hpData(await load(SOULHEART_HP_SOURCE),target,marker);
      assertGM();
      if(effect)await effect.update({name:data.name,'system.description':data.system.description,'system.badge':data.system.badge,[`flags.${ID}.soulheartHP`]:true,[`flags.${ID}.lastUpgrade`]:marker});
      else await recipient.createEmbeddedDocuments('Item',[data]);
    }
  };
}

export function previewSoulheart({holderId,itemId,phantomId,beneficiaryIds,binding}={}) {
  requirePrimaryGM();const holder=actorById(holderId),item=ownedItem(holder,itemId),state=readState(DOMAIN);
  binding??=state.bindings?.[item.uuid];
  return planUpgrade({id:randomId(),holderId,item,phantom:actorById(phantomId),beneficiaries:beneficiaryIds.map(id=>({id,effect:findHPEffect(actorById(id))})),state,time:now(),binding});
}
export async function commitSoulheart(proposal,confirmed=false) {
  return withAction(ACTION,()=>runUpgrade(makeSoulheartPort(),typeof proposal==='string'?readState(DOMAIN).operations?.[proposal]:proposal,confirmed));
}
export async function correctSoulheart(id) {return withAction(ACTION,()=>correctUpgrade(makeSoulheartPort(),id));}
export function previewSoulheartLife({holderId,itemId,binding,phase}={}) {
  requirePrimaryGM();const item=ownedItem(actorById(holderId),itemId),environment=getEnvironment(),state=readState(DOMAIN);
  binding??=state.bindings?.[item.uuid];
  return planLife({id:randomId(),holderId,item,binding,phase:phase??(environment.valid?(environment.night?'night':'day'):null),time:now(),seconds:environment.seconds,lastUse:flag(item).soulheartDaily});
}
export async function activateSoulheartLife(proposal,confirmed=false) {
  return withAction(ACTION,()=>runLife(makeSoulheartPort(),typeof proposal==='string'?readState(DOMAIN).operations?.[proposal]:proposal,confirmed));
}
export function previewSoulheartHPSync({beneficiaryIds,baseline}={}) {
  requirePrimaryGM();return planHPSync({id:randomId(),beneficiaries:beneficiaryIds.map(id=>({id,effect:findHPEffect(actorById(id))})),state:readState(DOMAIN),time:now(),baseline});
}

const esc=escapeHtml;
const select=(name,label,entries)=>`<label class="bob-field"><span>${esc(label)}</span><select name="${esc(name)}">${entries.map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('')}</select></label>`;
const partyChoices=()=>list(game.actors).filter(actor=>actor.type==='character');
const recipientsHTML=()=>{const selected=new Set(partyMembers().map(actor=>actor.id));return `<fieldset><legend>受益队伍（仅人物角色）</legend>${partyChoices().map(actor=>`<label class="bob-field"><input type="checkbox" name="beneficiary" value="${esc(actor.id)}" ${selected.has(actor.id)?'checked':''}>${esc(actor.name)}</label>`).join('')}</fieldset>`;};
const dialog=()=>foundry.applications.api.DialogV2;
async function choose(title,content,buttons=[{action:'next',label:'预览'}]) {
  return dialog().wait({window:{title:`BoB｜${title}`},position:{width:600},classes:['bob-companion'],content,rejectClose:false,buttons:buttons.map(button=>({...button,callback:(_event,_button,instance)=>({action:button.action,form:new FormData(instance.element.querySelector('form'))})}))});
}
const names=op=>op.beneficiaries.map(pc=>`<li>${esc(actorById(pc.id).name)}：当前 ${pc.before} → ${op.totalAfter} HP${pc.effectId?'（接纳已有计数效果）':'（建立唯一计数效果）'}</li>`).join('');
async function confirmUpgrade(op) {
  const details=op.kind==='sync'?'<p>接纳已有奖励基线／为加入的角色补齐已获得奖励。</p>':`<p>${esc(actorById(op.holderId).name)} 的 ${esc(ownedItem(actorById(op.holderId),op.itemId).name)}（${esc(SOULHEART_GRADES[op.grade].label)}）：数量 ${op.quantityBefore} → ${op.quantityAfter}。</p><p>${esc(actorById(op.phantomId).name)}：${op.rankBefore} → ${op.rankAfter} 阶；每位角色本次奖励 +${SOULHEART_GRADES[op.grade].hp} HP。</p>`;
  return dialog().confirm({window:{title:'BoB｜确认魂心操作'},content:`${details}<p>完整累计奖励：${op.totalBefore} → ${op.totalAfter} HP。</p><ul>${names(op)}</ul><p>已存在的计数作为基线接纳，角色间差额也会在此补齐。请先核对是否正确。</p>${op.binding?'<p>此物品使用 GM 明确绑定的类型；请核对实际物品。</p>':''}`,rejectClose:false});
}
async function chooseHolder(mode) {
  const holders=list(game.actors).filter(actor=>list(actor.items).some(item=>item.type==='equipment' && Number(item.system.quantity)>0));
  if(!holders.length)throw new Error('没有持有装备的角色。');
  const result=await choose('选择魂心持有者',select('holder','实际持有者',holders.map(actor=>[actor.id,actor.name])),[{action:'next',label:'选择实际物品'}]);
  if(!result)return;
  const holder=actorById(result.form.get('holder')),state=readState(DOMAIN);
  const items=list(holder.items).filter(item=>Number(item.system.quantity)>0&&(mode==='bind'?item.type==='equipment':soulheartGrade(item,state.bindings?.[item.uuid])));
  if(!items.length)throw new Error('此持有者没有可识别的魂心。自定义物品可先使用“绑定物品”。');
  const itemChoice=await choose(mode==='bind'?'明确绑定自定义魂心':'选择实际魂心',select('item','实际物品',items.map(item=>[item.id,`${item.name} × ${item.system.quantity}`]))+(mode==='bind'?select('grade','GM 确认类型',Object.entries(SOULHEART_GRADES).map(([key,value])=>[key,value.label])):'')+'<p>只处理所选持有者实际拥有的物品；纯净及天使魂心保留剧情使用。</p>',[{action:'next',label:mode==='bind'?'预览绑定':'继续'}]);
  if(!itemChoice)return;
  const item=ownedItem(holder,itemChoice.form.get('item'));
  if(mode==='bind') {
    const grade=itemChoice.form.get('grade');
    if(await dialog().confirm({window:{title:'BoB｜确认物品绑定'},content:`<p>将 ${esc(holder.name)} 持有的“${esc(item.name)}”（数量 ${item.system.quantity}）明确绑定为${esc(SOULHEART_GRADES[grade].label)}魂心。不会扣除物品；后续使用仍需预览确认。</p>`,rejectClose:false})) {
      await withAction(ACTION,()=>updateState(DOMAIN,state=>{state.bindings??={};state.bindings[item.uuid]=grade;}));
    }
    return;
  }
  if(mode==='life') {
    const op=previewSoulheartLife({holderId:holder.id,itemId:item.id});
    if(await dialog().confirm({window:{title:'BoB｜确认强化生命'},content:`<p>${esc(holder.name)} 使用 ${esc(item.name)}，按当前${op.phase==='day'?'白天':'夜晚'}获得 ${op.temporaryHP} 点临时生命值，持续 8 小时。</p><p>每日一次（按 PF2e 世界钟午夜刷新）；物品数量保持 ${op.quantityBefore}。已有更高临时生命值由 PF2e 按原生规则处理。</p>`,rejectClose:false}))await activateSoulheartLife(op,true);
    return;
  }
  const grade=soulheartGrade(item,state.bindings?.[item.uuid]);
  const phantoms=list(game.actors).filter(actor=>{try{return phantomRank(actor).rank===SOULHEART_GRADES[grade].rank;}catch{return false;}});
  if(!phantoms.length)throw new Error(`当前没有具备原生 ${SOULHEART_GRADES[grade].rank} 阶开关的合格魅影。`);
  const target=await choose('目标魅影与受益队伍',select('phantom','合格魅影',phantoms.map(actor=>[actor.id,`${actor.name}（${SOULHEART_GRADES[grade].rank} 阶）`]))+recipientsHTML());
  if(!target)return;
  const op=previewSoulheart({holderId:holder.id,itemId:item.id,phantomId:target.form.get('phantom'),beneficiaryIds:target.form.getAll('beneficiary')});
  if(await confirmUpgrade(op))await commitSoulheart(op,true);
}
async function chooseHPSync() {
  const state=readState(DOMAIN),minimum=Math.max(Number(state.total??0),...partyChoices().map(actor=>findHPEffect(actor)?.value??0));
  const result=await choose('接纳基线／新角色补齐',`<p>填写此前已经获得的每名 PC 累计 HP 奖励。已有原生效果会在下一步逐项预览；不能降低已获得奖励。</p><label class="bob-field">完整累计基线<input name="baseline" type="number" min="${minimum}" value="${minimum}" step="1"></label>${recipientsHTML()}`);
  if(!result)return;
  const op=previewSoulheartHPSync({beneficiaryIds:result.form.getAll('beneficiary'),baseline:Number(result.form.get('baseline'))});
  if(await confirmUpgrade(op))await commitSoulheart(op,true);
}
export async function openSoulhearts() {
  if(!game.user?.isGM)throw new Error('魂心助手仅供 GM 使用。');
  const state=readState(DOMAIN),operations=Object.values(state.operations??{}),pending=operations.filter(op=>['pending','correcting'].includes(op.status));
  const recent=operations.filter(op=>op.status==='complete').slice(-5).reverse();
  const content=`<p>完整累计奖励：<strong>${Number(state.total??0)} HP</strong>。本页与角色效果保存完整值；官方战役计数未同步（旧字段上限 21），请以本页为准。</p><p>由主 GM 执行。永久奖励的诅咒与停留条件结束时，请 GM 移除对应角色效果。</p>${pending.length?`<h3>待完成事务</h3><ul>${pending.map(op=>`<li>${esc(op.id)}：${esc(op.error??'处理中')} ${esc(op.notice??'')}</li>`).join('')}</ul>${select('pending','要继续的事务',pending.map(op=>[op.id,`${op.id} · ${op.kind==='life'?'临时生命值':op.status==='correcting'?'纠正':'生命值奖励'}`]))}`:''}${recent.length?`<details><summary>最近完成记录</summary><ul>${recent.map(op=>`<li>${esc(op.id)}：${op.kind==='life'?`临时生命值 ${op.temporaryHP}`:`累计 ${op.totalAfter} HP`}${op.notice?`；${esc(op.notice)}`:''}</li>`).join('')}</ul></details>`:''}`;
  const buttons=[{action:'upgrade',label:'强化魅影'},{action:'life',label:'强化生命'},{action:'sync',label:'基线／新角色'},{action:'bind',label:'绑定物品'}];
  if(pending.length)buttons.unshift({action:'retry',label:'继续待办'});
  if(state.lastCompleted)buttons.push({action:'correct',label:'纠正最近奖励'});
  const result=await choose('魂心助手',content,buttons);if(!result)return;
  try {
    requirePrimaryGM();
    if(['upgrade','life','bind'].includes(result.action))await chooseHolder(result.action);
    else if(result.action==='sync')await chooseHPSync();
    else if(result.action==='retry') {
      const op=readState(DOMAIN).operations?.[result.form.get('pending')];
      if(op.status==='correcting')await correctSoulheart(op.id);
      else if(op.kind==='life')await activateSoulheartLife(op,true);else await commitSoulheart(op,true);
    } else if(result.action==='correct') {
      const op=readState(DOMAIN).operations?.[state.lastCompleted];
      if(await dialog().confirm({window:{title:'BoB｜确认纠正'},content:`<p>撤回最近奖励 ${esc(op.id)}。累计 ${op.totalAfter} → ${op.ledgerBefore} HP；恢复此操作前各角色的实际计数${op.kind==='upgrade'?'、物品数量和魅影阶位':''}。若相关文档已经发生后续变化会停止。</p>`,rejectClose:false}))await correctSoulheart(op.id);
    }
  } catch(error) {ui.notifications.error(error.message);}
  return openSoulhearts();
}
let registered=false;
export function registerSoulhearts() {
  if(registered)return;registered=true;
  Hooks.once('ready',()=>{const module=game.modules.get(ID);if(module)Object.assign(module.api??={}, {openSoulhearts,previewSoulheart,commitSoulheart,correctSoulheart,previewSoulheartLife,activateSoulheartLife,previewSoulheartHPSync});});
}
