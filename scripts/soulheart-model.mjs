/** No Foundry globals: identity, preview and recoverable soulheart transactions. */
export const SOULHEART_GRADES = Object.freeze({
  ordinary:{rank:0,hp:1,day:6,night:3,slug:'soulheart',source:'Compendium.pf2e.equipment-srd.Item.8WxFFZm6OcBCCARR',label:'普通'},
  greater:{rank:1,hp:2,day:12,night:6,slug:'soulheart-greater',source:'Compendium.pf2e.equipment-srd.Item.5nNs3OFkRXH8yU1D',label:'高等'},
  major:{rank:2,hp:3,day:18,night:9,slug:'soulheart-major',source:'Compendium.pf2e.equipment-srd.Item.05h3LWflr74iJiVg',label:'上等'}
});
const clone = value => structuredClone(value);
const values = collection => Array.from(collection?.values?.() ?? collection ?? []);
export function soulheartGrade(item,binding) {
  if(!item || item.type!=='equipment') return null;
  const source=item.sourceId ?? item._stats?.compendiumSource ?? item.flags?.core?.sourceId;
  if(['soulheart-pure','soulheart-angelic'].includes(item.system?.slug)||['Compendium.pf2e.equipment-srd.Item.klQlruwrLO0xvPjl','Compendium.pf2e.equipment-srd.Item.Y10KCgi8mOL2iAkS'].includes(source))return null;
  const known=Object.entries(SOULHEART_GRADES).find(([,grade])=>grade.source===source)?.[0]??Object.entries(SOULHEART_GRADES).find(([,grade])=>grade.slug===item.system?.slug)?.[0];
  return known ?? (Object.hasOwn(SOULHEART_GRADES,binding??'') ? binding : null);
}
export function phantomRank(actor) {
  const matches=values(actor?.items).flatMap(item=>(item._source?.system?.rules ?? item.system?.rules ?? []).filter(rule=>rule.key==='RollOption' && rule.option==='support-rank' && rule.toggleable && ['1','2','3'].every(value=>rule.suboptions?.some(option=>option.value===value))).map(rule=>({item,rule})));
  if(matches.length!==1) throw new Error('目标必须具有唯一的原生 support-rank 阶位开关。');
  const {item,rule}=matches[0],rank=rule.value===false?0:Number(rule.selection);
  if(!Number.isInteger(rank)||rank<0||rank>3) throw new Error('魅影阶位无法读取，请先校准原生开关。');
  return {rank,itemId:item.id,domain:rule.domain??'all',option:'support-rank'};
}
function actualItem(item,binding) {
  const grade=soulheartGrade(item,binding),quantity=Number(item?.system?.quantity);
  if(!grade) throw new Error('无法识别实际魂心；自定义物品须由 GM 明确绑定。');
  if(!Number.isInteger(quantity)||quantity<1) throw new Error('实际物品数量不足。');
  return {grade,quantity};
}
export function planUpgrade({id,holderId,item,phantom,beneficiaries,state={},time,binding}) {
  const {grade,quantity}=actualItem(item,binding),rule=SOULHEART_GRADES[grade],rank=phantomRank(phantom);
  if(rule.rank!==rank.rank) throw new Error(`此魂心要求 ${rule.rank} 阶魅影；当前为 ${rank.rank} 阶。`);
  if(!id||!holderId||!beneficiaries?.length) throw new Error('请选择实际持有者及至少一名受益角色。');
  const unique=[...new Map(beneficiaries.map(actor=>[actor.id,actor])).values()];
  const baseline=unique.map(actor=>({id:actor.id,effectId:actor.effect?.id??null,before:Number(actor.effect?.value??0)}));
  if(baseline.some(pc=>!Number.isInteger(pc.before)||pc.before<0)) throw new Error('已有生命值奖励无法读取，请先校准。');
  const totalBefore=Math.max(Number(state.total??0),...baseline.map(pc=>pc.before));
  return {id,kind:'upgrade',status:'preview',createdAt:time,holderId,itemId:item.id,itemUuid:item.uuid,grade,binding:binding??null,
    quantityBefore:quantity,quantityAfter:quantity-1,phantomId:phantom.id,rankItemId:rank.itemId,rankDomain:rank.domain,
    rankBefore:rank.rank,rankAfter:rank.rank+1,beneficiaries:baseline,totalBefore,totalAfter:totalBefore+rule.hp,
    ledgerBefore:Number(state.total??0),previousCompleted:state.lastCompleted??null,steps:{}};
}
export function planHPSync({id,beneficiaries,state={},time,baseline}) {
  if(!beneficiaries?.length)throw new Error('请选择至少一名受益角色。');
  const targets=[...new Map(beneficiaries.map(pc=>[pc.id,pc])).values()].map(pc=>({id:pc.id,effectId:pc.effect?.id??null,before:Number(pc.effect?.value??0)}));
  const minimum=Math.max(Number(state.total??0),...targets.map(pc=>pc.before));
  baseline=baseline??minimum;
  if(!Number.isInteger(baseline)||baseline<minimum)throw new Error('接纳基线不能降低已获得的生命值；错误奖励请通过最近事务纠正。');
  return {id,kind:'sync',status:'preview',createdAt:time,beneficiaries:targets,totalBefore:minimum,totalAfter:baseline,ledgerBefore:Number(state.total??0),previousCompleted:state.lastCompleted??null,steps:{}};
}
const stepsFor = op => [...(op.kind==='sync'?[]:['quantity','rank']),...op.beneficiaries.map(pc=>`hp:${pc.id}`)];
function ensureAvailable(state,id) {
  if(Object.values(state.operations??{}).some(op=>op.id!==id && ['pending','correcting'].includes(op.status))) throw new Error('已有待完成事务；请先重试或完成纠正。');
}
async function recordFailure(port,id,error) {
  await port.save(state=>{state.operations[id].error=String(error.message??error);});
}
export async function runUpgrade(port,proposal,confirmed=false) {
  if(!confirmed) return null;
  let state=port.read(),op=state.operations?.[proposal.id];
  ensureAvailable(state,proposal.id);
  if(op?.status==='complete'||op?.status==='corrected') return op;
  if(op?.status==='correcting') throw new Error('此事务正在纠正，请继续纠正。');
  if(!op) {
    await port.preflight(proposal);
    await port.save(state=>{ensureAvailable(state,proposal.id);state.operations??={};state.operations[proposal.id]={...clone(proposal),status:'pending'};});
  }
  try {
    for(const step of stepsFor(port.read().operations[proposal.id])) {
      op=port.read().operations[proposal.id];
      // Applied steps are not replayed. An unacknowledged document write is reconciled by the port.
      if(op.steps[step]) continue;
      await port.apply(op,step,false);
      await port.save(state=>{state.operations[op.id].steps[step]=true;});
    }
    await port.save(state=>{const current=state.operations[proposal.id];current.status='complete';delete current.error;state.total=current.totalAfter;state.lastCompleted=current.id;});
  } catch(error) {await recordFailure(port,proposal.id,error);throw error;}
  return port.read().operations[proposal.id];
}
export async function correctUpgrade(port,id) {
  let state=port.read(),op=state.operations?.[id];
  if(op?.status==='corrected') return op;
  if(!op||!['complete','correcting'].includes(op.status)) throw new Error('请先完成事务再纠正。');
  ensureAvailable(state,id);
  if(state.lastCompleted!==id) throw new Error('已有后续奖励，不能撤销较早的事务。');
  if(op.status!=='correcting') {
    await port.checkCorrection(op);
    await port.save(state=>{state.operations[id].status='correcting';state.operations[id].undoSteps={};});
  }
  try {
    for(const step of stepsFor(op).reverse()) {
      op=port.read().operations[id];if(op.undoSteps[step]) continue;
      await port.apply(op,step,true);
      await port.save(state=>{state.operations[id].undoSteps[step]=true;});
    }
    await port.save(state=>{const current=state.operations[id];current.status='corrected';delete current.error;state.total=current.ledgerBefore;state.lastCompleted=current.previousCompleted;});
  } catch(error) {await recordFailure(port,id,error);throw error;}
  return port.read().operations[id];
}
export function planLife({id,holderId,item,phase,time,seconds,lastUse,binding}) {
  const {grade}=actualItem(item,binding);
  if(!['day','night'].includes(phase)||!Number.isFinite(time)||!Number.isFinite(seconds)) throw new Error('昼夜或世界钟不可用，请由 GM 确认当前昼夜。');
  if(lastUse && time<lastUse.resetAt) throw new Error('这件物品的每日强化生命已经使用；时间倒退不会刷新。');
  return {id,kind:'life',status:'preview',holderId,itemId:item.id,itemUuid:item.uuid,grade,binding:binding??null,createdAt:time,temporaryHP:SOULHEART_GRADES[grade][phase],phase,
    expiresAt:time+28800,resetAt:time+86400-((seconds%86400+86400)%86400),quantityBefore:Number(item.system.quantity),steps:{}};
}
export async function runLife(port,proposal,confirmed=false) {
  if(!confirmed)return null;
  let state=port.read(),op=state.operations?.[proposal.id];ensureAvailable(state,proposal.id);
  if(op?.status==='complete')return op;
  if(!op) {
    await port.preflightLife(proposal);
    await port.save(state=>{ensureAvailable(state,proposal.id);state.operations??={};state.operations[proposal.id]={...clone(proposal),status:'pending'};});
  }
  try {
    for(const step of ['daily','effect']) {
      op=port.read().operations[proposal.id];if(op.steps[step])continue;
      await port.applyLife(op,step);
      await port.save(state=>{state.operations[op.id].steps[step]=true;});
    }
    await port.save(state=>{state.operations[proposal.id].status='complete';delete state.operations[proposal.id].error;});
  } catch(error) {await recordFailure(port,proposal.id,error);throw error;}
  return port.read().operations[proposal.id];
}
