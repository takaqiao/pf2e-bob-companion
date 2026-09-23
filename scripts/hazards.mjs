import {ID} from './model.mjs';
import {isPrimaryGM,requirePrimaryGM,now,escapeHtml as esc,readState,updateState,withAction,whisperGM,partyMembers} from './assistant-core.mjs';
import {setMembership,advanceHazards,resolveFoul,requestFoul,resolveLightning,removeTrackedToken} from './hazard-model.mjs';
const DOMAIN='hazards',labels={dungeon:'地牢（免疫离开计时）',foul:'污秽空气',tower:'高塔户外'};
const report=error=>ui.notifications.error(error.message);
const stormEnded=()=>!!game.settings.get(ID,'config')?.stormEnded;
const enabled=()=>game.settings.get(ID,'config')?.enabled!==false;
async function change(mutator){
  let added=false;
  const result=await updateState(DOMAIN,s=>{
    const previous=structuredClone(s.requests??{});mutator(s);
    added=Object.entries(s.requests??{}).some(([key,r])=>!previous[key]||(r.count??0)>(previous[key].count??0));
  });
  if(added)await whisperGM('<p>有环境检定待确认。请打开「冒险助手 → 环境危险」。角色是否实际暴露及结算结果由 GM 确认。</p>');
  return result;
}
function membership(token,state,recalculate=false){
  const actor=game.actors.get(token.actorId);
  if(actor?.type!=='character'||!actor.hasPlayerOwner)return null;
  const members=new Set(partyMembers().map(a=>a.uuid));if(!members.has(actor.uuid))return null;
  const regions=recalculate?Array.from(token.parent.regions??[]).filter(r=>state.bindings?.[r.uuid]&&token.testInsideRegion(r)):Array.from(token.regions??[]);
  const types=regions.map(r=>state.bindings?.[r.uuid]).filter(Boolean);
  if(!recalculate&&!token.regions)for(const id of token._source?._regions??[]) {const type=state.bindings?.[`Scene.${token.parent.id}.Region.${id}`];if(type)types.push(type);}
  return {tokenUuid:token.uuid,actorUuid:actor.uuid,sceneId:token.parent.id,name:actor.name,types};
}
export async function trackHazardToken(token,{recalculate=false}={}){
  if(!isPrimaryGM()||!enabled())return;
  const state=readState(DOMAIN);if(!Object.keys(state.bindings??{}).length&&!state.tokens?.[token.uuid])return;
  const data=token.parent?.id===game.scenes.active?.id?membership(token,state,recalculate):null;
  if(!data){if(state.tokens?.[token.uuid])await change(s=>removeTrackedToken(s,token.uuid,now()));return;}
  if(!data.types.length&&!state.tokens?.[token.uuid])return;
  await change(s=>{advanceHazards(s,now(),{stormEnded:stormEnded()});setMembership(s,data,now());});
}
export async function refreshHazards({recalculate=false}={}){
  requirePrimaryGM();if(!enabled())return;
  const state=readState(DOMAIN);
  if(!Object.keys(state.bindings??{}).length&&!Object.keys(state.tokens??{}).length&&!Object.keys(state.actors??{}).length&&!state.lightning)return;
  for(const [uuid,record] of Object.entries(state.tokens??{}))if(record.sceneId!==game.scenes.active?.id||!await fromUuid(uuid))await change(s=>removeTrackedToken(s,uuid,now()));
  const scene=game.scenes.active;
  if(scene&&(Object.keys(state.bindings??{}).some(key=>key.startsWith(`${scene.uuid}.`))||Object.keys(state.tokens??{}).length))for(const token of scene.tokens)await trackHazardToken(token,{recalculate});
  await change(s=>advanceHazards(s,now(),{stormEnded:stormEnded()}));
}
export async function bindHazardRegion(regionUuid,type){
  requirePrimaryGM();const region=await fromUuid(regionUuid);
  if(region?.documentName!=='Region'||(type&&!Object.hasOwn(labels,type)))throw new Error('请选择有效区域与用途。');
  await updateState(DOMAIN,s=>{s.bindings??={};if(type)s.bindings[regionUuid]=type;else delete s.bindings[regionUuid];});
  // Removing the final binding must also clear previously tracked exposure.
  for(const token of region.parent.tokens)await trackHazardToken(token);
}
async function resolveAir(actorUuid,success){
  return withAction(`foul:${actorUuid}`,()=>change(s=>{
    if(!s.requests?.[`foul:${actorUuid}`])throw new Error('此待办已处理。');
    resolveFoul(s,actorUuid,success,now());
  }));
}
async function rollAir(actorUuid){
  requirePrimaryGM();const actor=await fromUuid(actorUuid);
  if(!actor?.saves?.fortitude)throw new Error('角色已不存在或无法进行强韧豁免。');
  await actor.saves.fortitude.roll({dc:{value:25},messageMode:'gm'});
}
async function rollLightning(){
  return withAction('lightning:roll',async()=>{
    const pending=readState(DOMAIN).requests?.lightning;if(!pending)throw new Error('没有待结算的雷击时段。');
    const roll=await new Roll('1d20').evaluate();
    await roll.toMessage({flavor:'环境检定（平检 DC 17）',whisper:game.users.filter(u=>u.isGM).map(u=>u.id)},{rollMode:'gmroll'});
    await updateState(DOMAIN,s=>{if(!s.requests?.lightning)return;if(s.requests.lightning.count>1)s.requests.lightning.count--;else resolveLightning(s);});
    if(roll.total>=17)await whisperGM('<p>此次检定成功。由 GM 从实际在户外的角色中指定一名：承受 10d6 电击伤害，DC 30 基础反射豁免。先确认遮蔽与免疫，再手动结算；尚未自动扣除生命值。</p>');
    return roll.total;
  });
}
const options=(entries,current)=>entries.map(([v,n])=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(n)}</option>`).join('');
function body(){
  const s=readState(DOMAIN),scene=canvas.scene;
  const regions=Array.from(scene?.regions??[],r=>[r.uuid,r.name]);
  const requests=Object.values(s.requests??{});
  const air=requests.filter(r=>r.kind==='foul').map(r=>`<li>${esc(game.actors.get(r.actorUuid.split('.').at(-1))?.name??'角色')}：DC 25 强韧 <button type="button" data-air="roll" data-actor="${esc(r.actorUuid)}">GM 检定</button><button type="button" data-air="success" data-actor="${esc(r.actorUuid)}">确认成功</button><button type="button" data-air="failure" data-actor="${esc(r.actorUuid)}">已处理／无暴露</button></li>`).join('');
  return `<p>仅主 GM 结算。使用原生区域追踪队伍；不自动判定是否呼吸，也不自动造成伤害。</p><h3>待办</h3>${air?`<ul>${air}</ul>`:'<p>没有待处理的空气检定。</p>'}${s.requests?.lightning?`<p>户外雷击：累计 ${s.requests.lightning.count} 次待确认。</p><button type="button" data-hazard="roll-lightning">结算一次平检</button><button type="button" data-hazard="clear-lightning">确认这些时段无需结算</button>`:'<p>没有待处理的雷击检定。</p>'}<details><summary>区域与计时设置</summary><p>地牢离开超过 8 小时才失去空气免疫。污秽区域也视为地牢；请为其余地牢范围另设区域。高塔按队伍户外累计，每 10 分钟一次；全员离开暂停。风暴停止状态沿用规则面板。</p><p>当前场景：${esc(scene?.name??'未载入')}</p>${regions.length?`<label>区域 <select name="region">${options(regions,'')}</select></label><label>用途 <select name="hazardType">${options([['','移除用途'],...Object.entries(labels)],'')}</select></label><button type="button" data-hazard="bind">保存区域用途</button>`:'<p>先用原生区域工具画出需要追踪的范围。</p>'}<ul>${Object.entries(s.bindings??{}).map(([uuid,type])=>`<li>${esc(fromUuidSync(uuid)?.name??uuid)}：${esc(labels[type])}</li>`).join('')}</ul><p>免疫记录：${Object.entries(s.actors??{}).filter(([,a])=>a.immune).map(([uuid])=>esc(fromUuidSync(uuid)?.name??'角色')).join('、')||'无'}</p></details><p class="bob-warning" data-error></p>`;
}
let opening,activeWindow;
export function openHazards(){
  if(opening){activeWindow?.bringToFront();return opening;}
  opening=showHazards().finally(()=>{opening=null;activeWindow=null;});return opening;
}
async function showHazards(){
  if(!game.user?.isGM)throw new Error('冒险助手仅供 GM 使用。');
  if(isPrimaryGM())await refreshHazards();
  class Panel extends foundry.applications.api.DialogV2 {
    async _onRender(context,options){await super._onRender(context,options);this.element.addEventListener('click',async event=>{
      const b=event.target.closest('[data-air],[data-hazard]');if(!b||this.busy)return;this.busy=true;b.disabled=true;
      try{
        if(b.dataset.air==='roll')await rollAir(b.dataset.actor);
        else if(b.dataset.air)await resolveAir(b.dataset.actor,b.dataset.air==='success');
        else if(b.dataset.hazard==='roll-lightning')await rollLightning();
        else if(b.dataset.hazard==='clear-lightning'){if(await foundry.applications.api.DialogV2.confirm({window:{title:'确认已处理'},content:'<p>清除当前累计的雷击待办？已累计的户外时间仍保留。</p>'}))await updateState(DOMAIN,s=>resolveLightning(s));}
        else if(b.dataset.hazard==='bind')await bindHazardRegion(this.element.querySelector('[name="region"]').value,this.element.querySelector('[name="hazardType"]').value);
        await this.close();void openHazards();
      }catch(error){this.element.querySelector('[data-error]').textContent=error.message;}finally{this.busy=false;b.disabled=false;}
    });}
  }
  return Panel.wait({window:{title:'BoB｜环境危险',resizable:true},render:(_event,dialog)=>{activeWindow=dialog;},position:{width:640},classes:['bob-companion'],content:body(),buttons:[{action:'close',label:'关闭'}]});
}
export function registerHazards(){
  Hooks.once('ready',()=>{const mod=game.modules.get(ID);Object.assign(mod.api??={}, {openHazards,bindHazardRegion,refreshHazards});});
  Hooks.on('updateToken',(token,changes)=>{if(['x','y','elevation','_regions','actorId','actorLink'].some(k=>Object.hasOwn(changes,k)))void trackHazardToken(token).catch(report);});
  Hooks.on('createToken',token=>{void trackHazardToken(token).catch(report);});
  Hooks.on('deleteToken',token=>{if(isPrimaryGM()&&enabled()&&readState(DOMAIN).tokens?.[token.uuid])void change(s=>removeTrackedToken(s,token.uuid,now())).catch(report);});
  Hooks.on('updateScene',(_scene,changes)=>{if(Object.hasOwn(changes,'active')&&isPrimaryGM()&&enabled())void refreshHazards().catch(report);});
  Hooks.on('canvasReady',()=>{if(isPrimaryGM())void refreshHazards().catch(report);});
  Hooks.on('updateRegion',region=>{if(isPrimaryGM()&&readState(DOMAIN).bindings?.[region.uuid])void refreshHazards({recalculate:true}).catch(report);});
  Hooks.on('deleteRegion',region=>{if(isPrimaryGM()&&enabled()&&readState(DOMAIN).bindings?.[region.uuid])void updateState(DOMAIN,s=>{delete s.bindings[region.uuid];}).then(()=>refreshHazards({recalculate:true})).catch(report);});
  Hooks.on('updateWorldTime',()=>{if(isPrimaryGM()&&enabled()&&Object.keys(readState(DOMAIN)).length)void change(s=>advanceHazards(s,now(),{stormEnded:stormEnded()})).catch(report);});
  Hooks.on('updateSetting',setting=>{if(setting.key===`${ID}.config`&&isPrimaryGM()&&Object.keys(readState(DOMAIN)).length)void change(s=>advanceHazards(s,now(),{stormEnded:stormEnded(),enabled:enabled()})).then(()=>enabled()?refreshHazards():null).catch(report);});
  Hooks.on('combatTurnChange',combat=>{if(!isPrimaryGM()||!enabled())return;const token=combat.combatant?.token;if(!token)return;const actorUuid=`Actor.${token.actorId}`;void change(s=>requestFoul(s,actorUuid,now(),`${combat.id}:${combat.round}:${combat.turn}`)).catch(report);});
}
